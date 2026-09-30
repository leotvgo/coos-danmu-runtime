import { Worker } from 'node:worker_threads';
import { compatibleSource } from './compatibility.js';
import { workerSource } from './assets.js';
export class RuntimeClient {
  constructor({ bytes, dataDir, timeoutMs = 60_000, workerFactory, onLog = () => {} }) {
    this.pending = new Map(); this.serial = 0; this.timeoutMs = timeoutMs; this.closed = false;
    const spawn = workerFactory || ((source, options) => new Worker(source, options));
    this.worker = spawn(workerSource(), { eval: true, execArgv: [], workerData: { code: compatibleSource(bytes.toString('utf8')), dataDir },
      env: { NODE_ENV: 'production', DANMU_API_PORT: '9321' }, resourceLimits: { maxOldGenerationSizeMb: 256 } });
    this.ready = new Promise((resolve,reject) => {
      const timer = setTimeout(() => { reject(new Error('完整弹幕服务启动超时')); this.close(); }, 15_000);
      this.worker.on('message', message => {
        if (message.type === 'ready') { clearTimeout(timer); resolve(); }
        if (message.type === 'failed') { clearTimeout(timer); reject(new Error('完整弹幕服务启动失败')); this.close(); }
        if (message.type === 'log') onLog({ level: message.level, message: message.message });
        if (message.type === 'response') {
          const task = this.pending.get(message.id);
          if (task) { this.pending.delete(message.id); task.finish(); task.resolve({
            status: message.status, headers: message.headers, body: Buffer.from(message.body, 'base64'),
          }); }
        }
      });
      this.worker.once('error', () => { clearTimeout(timer); reject(new Error('弹幕服务执行失败')); });
      this.worker.once('exit', () => {
        clearTimeout(timer); this.closed = true;
        reject(new Error('弹幕服务已退出'));
        for (const task of this.pending.values()) { task.finish(); task.reject(new Error('弹幕服务已退出')); }
        this.pending.clear();
      });
    });
    this.ready.catch(() => {});
  }
  async request(input, { signal } = {}) {
    await this.ready;
    if (this.closed || signal?.aborted) throw new Error('弹幕请求已取消');
    if (this.pending.size >= 32) throw new Error('弹幕服务繁忙');
    const id = ++this.serial;
    return new Promise((resolve,reject) => {
      const abort = () => {
        const task = this.pending.get(id); if (!task) return;
        this.pending.delete(id); task.finish(); this.worker.postMessage({ type: 'abort', id }); reject(new Error('弹幕请求超时或已取消'));
      };
      const timer = setTimeout(abort, this.timeoutMs);
      const finish = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      this.pending.set(id, { resolve,reject,finish });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.postMessage({ type: 'request', id, input: { ...input,
        body: Buffer.isBuffer(input.body) ? input.body.toString('base64') : input.body ? Buffer.from(input.body).toString('base64') : '' } });
    });
  }
  async close() {
    if (this.closing) return this.closing;
    if (this.worker.threadId === -1) return;
    this.closed = true; this.worker.postMessage({ type: 'stop' });
    this.closing = new Promise(resolve => {
      const timer = setTimeout(() => { this.worker.terminate().finally(resolve); }, 1500);
      this.worker.once('exit', () => { clearTimeout(timer); resolve(); });
    });
    return this.closing;
  }
}
