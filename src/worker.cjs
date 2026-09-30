'use strict';
// Runs the COMPLETE upstream HTTP application in a separate Node isolate.
// Its HTTP servers are transported over IPC; only the host owns public ports.
const { parentPort, workerData } = require('node:worker_threads');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { Readable, Writable } = require('node:stream');
const { EventEmitter } = require('node:events');
const Module = require('node:module');
const { fileURLToPath } = require('node:url');
const zlib = require('node:zlib');

const root = fs.realpathSync(path.resolve(workerData.dataDir));
const servers = new Map();
const pending = new Map();
const originalFetch = globalThis.fetch;
const originalRequest = http.request;
const MAX_BODY = 32 * 1024 * 1024;
const realRead = fs.readFileSync.bind(fs);
const realWrite = fs.writeFileSync.bind(fs);
const realMkdir = fs.mkdirSync.bind(fs);
const realExists = fs.existsSync.bind(fs);
const realPath = fs.realpathSync.bind(fs);
realMkdir(path.join(root, 'config'), { recursive: true, mode: 0o700 });
realMkdir(path.join(root, '.cache'), { recursive: true, mode: 0o700 });
realMkdir(path.join(root, 'danmu_api', 'utils'), { recursive: true, mode: 0o700 });

// This changes only the Worker JS object, never the process working directory.
process.cwd = () => root;
function scopedPath(value) {
  if (value instanceof URL) value = fileURLToPath(value);
  if (Buffer.isBuffer(value)) value = value.toString();
  if (typeof value !== 'string') return value;
  let resolved = path.resolve(root, value);
  // Bundled server.js derives config from its virtual filename; utilities
  // derive .cache from their virtual __dirname. Both belong to this instance.
  const bundledConfig = path.join(root, 'danmu_api', 'config');
  if (resolved === bundledConfig || resolved.startsWith(bundledConfig + path.sep)) {
    resolved = path.join(root, 'config', path.relative(bundledConfig, resolved));
  }
  const reject=()=>{throw Object.assign(new Error('Danmu instance file access denied'),{code:'EACCES'});};
  let ancestor=resolved;
  while(!realExists(ancestor) && path.dirname(ancestor)!==ancestor)ancestor=path.dirname(ancestor);
  const canonical=realPath(ancestor),canonicalRoot=realPath(root);
  if(canonical!==canonicalRoot && !canonical.startsWith(canonicalRoot+path.sep))reject();
  return resolved;
}
for (const name of ['readFile','readFileSync','writeFile','writeFileSync','appendFile','appendFileSync',
  'mkdir','mkdirSync','readdir','readdirSync','stat','statSync','lstat','lstatSync','access','accessSync',
  'existsSync','realpath','realpathSync','unlink','unlinkSync','rm','rmSync','rmdir','rmdirSync','open','openSync','watch',
  'createReadStream','createWriteStream']) {
  const original = fs[name];
  if (typeof original === 'function') fs[name] = function(file, ...args) {
    return original.call(fs, scopedPath(file), ...args);
  };
}
for (const name of ['rename','renameSync','copyFile','copyFileSync','cp','cpSync']) {
  const original = fs[name];
  if (typeof original === 'function') fs[name] = function(from, to, ...args) {
    return original.call(fs, scopedPath(from), scopedPath(to), ...args);
  };
}
for (const name of ['readFile','writeFile','appendFile','mkdir','readdir','stat','lstat','access','unlink','rm','rmdir','open']) {
  const original = fs.promises[name];
  if (typeof original === 'function') fs.promises[name] = (file, ...args) => original.call(fs.promises, scopedPath(file), ...args);
}
for (const name of ['rename','copyFile','cp']) {
  const original = fs.promises[name];
  if (typeof original === 'function') fs.promises[name] = (from, to, ...args) => original.call(fs.promises, scopedPath(from), scopedPath(to), ...args);
}

function redact(value) {
  let text;
  try { text = typeof value === 'string' ? value : value instanceof Error ? value.message : JSON.stringify(value); }
  catch { text = '[unavailable]'; }
  text = String(text || '');
  for (const [key, secret] of Object.entries(process.env)) {
    if (/TOKEN|COOKIE|PASSWORD|SECRET|KEY|SESSDATA|AUTH/i.test(key) && secret && secret.length > 3) {
      text = text.split(secret).join('[redacted]');
    }
  }
  return text.replace(/https?:\/\/[^\s"'<>]+/gi, '[url]')
    .replace(/\b(?:Cookie|Authorization|Set-Cookie)\s*[:=]\s*[^\r\n]+/gi, '[redacted]')
    .replace(/\b(?:Bearer|Basic)\s+[A-Za-z0-9+/=._-]+/gi, '[redacted]');
}
for (const level of ['log','info','warn','error','debug']) {
  console[level] = (...args) => parentPort.postMessage({ type: 'log', level, message: args.map(redact).join(' ').slice(0, 1500) });
}

class Incoming extends Readable {
  constructor(input) {
    super({ autoDestroy: false });
    this.method = input.method || 'GET'; this.url = input.path || '/';
    this.headers = Object.fromEntries(Object.entries(input.headers || {}).map(([k,v]) => [k.toLowerCase(),v]));
    this.headers.host = new URL(input.origin || 'http://127.0.0.1:9321').host;
    this.headers['x-forwarded-proto'] = new URL(input.origin || 'http://127.0.0.1:9321').protocol.slice(0,-1);
    this.socket = new EventEmitter(); this.socket.remoteAddress = input.clientIp || '127.0.0.1';
    this.connection = this.socket; this.httpVersion = '1.1'; this.aborted = false;
    this.bytes = Buffer.from(input.body || '', 'base64');
    if (this.bytes.length) this.headers['content-length'] = String(this.bytes.length);
  }
  _read() { if (this.bytes) this.push(this.bytes); this.bytes = null; this.push(null); }
}
class Outgoing extends Writable {
  constructor(resolve, reject) {
    super(); this.statusCode = 200; this.headers = {}; this.parts = []; this.bytes = 0;
    this.headersSent = false;
    this.once('error', reject);
    this.once('finish', () => resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(this.parts) }));
  }
  setHeader(key, value) { this.headers[String(key).toLowerCase()] = value; return this; }
  getHeader(key) { return this.headers[String(key).toLowerCase()]; }
  getHeaders() { return { ...this.headers }; }
  hasHeader(key) { return this.getHeader(key) !== undefined; }
  removeHeader(key) { delete this.headers[String(key).toLowerCase()]; }
  writeHead(status, message, headers) {
    this.statusCode = status;
    for (const [key,value] of Object.entries(typeof message === 'object' ? message : headers || {})) this.setHeader(key,value);
    this.headersSent = true; return this;
  }
  flushHeaders() { this.headersSent = true; }
  _write(chunk, encoding, callback) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, encoding);
    this.bytes += bytes.length;
    if (this.bytes > MAX_BODY) return callback(new Error('Upstream response limit exceeded'));
    this.parts.push(bytes); this.headersSent = true; callback();
  }
}
function dispatch(port, input, requestId) {
  return new Promise((resolve, reject) => {
    const server = servers.get(Number(port));
    if (!server) return reject(new Error('Upstream HTTP service is not ready'));
    const req = new Incoming(input);
    const res = new Outgoing(resolve, reject);
    if (requestId) pending.set(requestId, { req, res });
    res.once('finish', () => { if (requestId) pending.delete(requestId); });
    res.once('error', () => { if (requestId) pending.delete(requestId); });
    try { server.emit('request', req, res); }
    catch (error) { reject(error); }
  });
}
const createServer = http.createServer;
http.createServer = function(...args) {
  const server = createServer.apply(http, args);
  let binding = null;
  Object.defineProperty(server, 'listening', { configurable: true, get: () => binding !== null });
  server.listen = function(options, ...rest) {
    const port = Number(typeof options === 'object' ? options.port : options) || 9321;
    const callback = [options, ...rest].find(value => typeof value === 'function');
    if (servers.has(port) && servers.get(port) !== server) {
      queueMicrotask(() => server.emit('error', Object.assign(new Error('Duplicate service port'), { code: 'EADDRINUSE' })));
      return server;
    }
    binding = { address: '127.0.0.1', family: 'IPv4', port }; servers.set(port, server);
    queueMicrotask(() => { server.emit('listening'); callback?.(); if (port === 9321) parentPort.postMessage({ type: 'ready' }); });
    return server;
  };
  server.address = () => binding;
  server.close = callback => {
    if (binding) servers.delete(binding.port);
    binding = null; queueMicrotask(() => { server.emit('close'); callback?.(); }); return server;
  };
  server.closeAllConnections = () => {};
  return server;
};

function localUrl(input, options) {
  try {
    const value = input instanceof URL || typeof input === 'string' ? new URL(input) :
      new URL((input.protocol || 'http:') + '//' + (input.hostname || input.host || 'localhost') +
        (input.port ? ':' + input.port : '') + (input.path || '/'));
    return ['127.0.0.1','localhost','[::1]'].includes(value.hostname) && servers.has(Number(value.port)) ? value : null;
  } catch { return null; }
}
http.request = function(input, options, callback) {
  const url = localUrl(input, options);
  if (!url) return originalRequest.apply(http, arguments);
  if (typeof options === 'function') { callback = options; options = {}; }
  options = { ...(typeof input === 'object' && !(input instanceof URL) ? input : {}), ...options };
  const chunks = []; let length = 0;
  const request = new Writable({
    write(chunk, encoding, done) {
      length += chunk.length;
      if (length > MAX_BODY) return done(new Error('Request body limit exceeded'));
      chunks.push(Buffer.from(chunk)); done();
    },
    final(done) {
      done();
      dispatch(url.port, { method: options.method || 'GET', path: url.pathname + url.search,
        origin: url.origin, headers: options.headers, body: Buffer.concat(chunks).toString('base64') })
        .then(result => {
          const response = Readable.from([result.body]);
          response.statusCode = result.status; response.statusMessage = http.STATUS_CODES[result.status] || '';
          response.headers = result.headers;
          response.rawHeaders = Object.entries(result.headers).flatMap(([key,value]) =>
            (Array.isArray(value) ? value : [value]).flatMap(item => [key,String(item)]));
          response.httpVersion = '1.1'; response.req = request;
          callback?.(response); request.emit('response', response);
        }).catch(error => request.emit('error', error));
    },
  });
  request.setTimeout = () => request; request.abort = () => request.destroy();
  request.getHeader = key => options.headers?.[key];
  return request;
};
http.get = function(...args) { const request = http.request(...args); request.end(); return request; };
async function virtualFetch(input, options = {}, redirects = 0) {
  const url = localUrl(typeof input === 'string' || input instanceof URL ? input : input.url);
  if (!url) return originalFetch(input, options);
  if (redirects > 20) throw new Error('Internal redirect limit exceeded');
  const result = await dispatch(url.port, { method: options.method || 'GET', path: url.pathname + url.search,
    origin: url.origin, headers: options.headers, body: options.body ? Buffer.from(options.body).toString('base64') : '' });
  const location=result.headers.location;
  if(location && [301,302,303,307,308].includes(result.status) && options.redirect!=='manual') {
    if(options.redirect==='error')throw new Error('Unexpected internal redirect');
    const target=new URL(location,url);const next={...options};
    if(result.status===303 || ([301,302].includes(result.status) && options.method==='POST')){next.method='GET';delete next.body;}
    if(target.origin!==url.origin)next.headers=Object.fromEntries(Object.entries(next.headers||{}).filter(([k])=>!/^(authorization|cookie)$/i.test(k)));
    return virtualFetch(target.toString(),next,redirects+1);
  }
  let body=result.body;const encoding=String(result.headers['content-encoding']||'');
  if(encoding==='gzip')body=zlib.gunzipSync(body,{maxOutputLength:MAX_BODY});
  else if(encoding==='deflate')body=zlib.inflateSync(body,{maxOutputLength:MAX_BODY});
  else if(encoding==='br')body=zlib.brotliDecompressSync(body,{maxOutputLength:MAX_BODY});
  if(encoding){delete result.headers['content-encoding'];delete result.headers['content-length'];}
  return new Response([204,205,304].includes(result.status) ? null : body, { status: result.status, headers: result.headers });
}
if (originalFetch) globalThis.fetch = virtualFetch;

parentPort.on('message', async message => {
  if (message.type === 'request') {
    try {
      const result = await dispatch(9321, message.input, message.id);
      if (/\/api\/(?:logs|reqrecords)(?:[/?]|$)/.test(message.input.path)) {
        const sanitize = value => typeof value === 'string' ? redact(value) : Array.isArray(value)
          ? value.map(sanitize) : value && typeof value === 'object'
            ? Object.fromEntries(Object.entries(value).map(([k,v]) => [k,sanitize(v)])) : value;
        try { result.body = Buffer.from(JSON.stringify(sanitize(JSON.parse(result.body.toString('utf8'))))); }
        catch { result.body = Buffer.from(redact(result.body.toString('utf8'))); }
        delete result.headers['content-length'];
      }
      parentPort.postMessage({ type: 'response', id: message.id, status: result.status, headers: result.headers,
        body: result.body.toString('base64') });
    } catch { parentPort.postMessage({ type: 'response', id: message.id, status: 502, headers: {},
      body: Buffer.from('Upstream request failed').toString('base64') }); }
  } else if (message.type === 'abort') {
    const entry = pending.get(message.id);
    if (entry) { entry.req.aborted = true; entry.req.emit('aborted'); entry.req.emit('close'); entry.res.destroy(); pending.delete(message.id); }
  } else if (message.type === 'stop') {
    process.emit('SIGTERM');
    setTimeout(() => process.exit(0), 750).unref();
  }
});

try {
  const filename = path.join(root, 'danmu_api', 'utils', 'runtime.cjs');
  const loaded = new Module(filename, module); loaded.filename = filename; loaded.paths = [];
  loaded._compile(workerData.code, filename);
  if (typeof loaded.exports?.start === 'function') {
    Promise.resolve(loaded.exports.start({ name: 'coos-danmu', port: 9321, dataDir: root, log: console.log }))
      .catch(() => parentPort.postMessage({ type: 'failed', error: 'Upstream start failed' }));
  }
} catch (error) {
  parentPort.postMessage({ type: 'failed', error: redact(error).slice(0, 300) });
}
