import { MAX_ARTIFACT_BYTES, digest, inspectArtifact } from './compatibility.js';
export const UPDATE_URL = 'https://github.com/leotvgo/coos-danmu-runtime/releases/download/danmu-stable/manifest.json';
function allowed(value) {
  const url = new URL(value);
  return url.protocol==='https:' && (!url.port || url.port==='443') && !url.username && !url.password &&
    (url.hostname==='github.com' && url.pathname.startsWith('/leotvgo/coos-danmu-runtime/releases/download/danmu-') ||
      ['release-assets.githubusercontent.com','objects.githubusercontent.com'].includes(url.hostname));
}
async function download(url, fetchImpl, maximum, signal) {
  const controller=new AbortController();const abort=()=>controller.abort();
  if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  const timer=setTimeout(abort,60_000);
  try {
  for (let redirect=0;redirect<6;redirect++) {
    if (!allowed(url)) throw new Error('更新源重定向不受信任');
    const response = await fetchImpl(url, { redirect: 'manual', signal: controller.signal, headers: { 'Cache-Control':'no-cache' } });
    if (response.status>=300 && response.status<400 && response.headers.get('location')) {
      const next = new URL(response.headers.get('location'),url).toString();
      await response.body?.cancel?.(); url=next; continue;
    }
    if (!response.ok) throw new Error('更新源 HTTP '+response.status);
    if (Number(response.headers.get('content-length'))>maximum) { await response.body?.cancel?.(); throw new Error('更新包超过大小限制'); }
    const chunks=[]; let length=0;
    if (response.body?.getReader) {
      const reader=response.body.getReader();
      try {
        while (true) { const {done,value}=await reader.read(); if(done)break; length+=value.byteLength;
          if(length>maximum)throw new Error('更新包超过大小限制'); chunks.push(Buffer.from(value)); }
      } finally { await reader.cancel().catch(()=>{}); reader.releaseLock(); }
      return Buffer.concat(chunks);
    }
    const bytes=Buffer.from(await response.arrayBuffer());
    if(bytes.length>maximum)throw new Error('更新包超过大小限制'); return bytes;
  }
  throw new Error('更新源重定向次数过多');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
export function validateReleaseManifest(value) {
  if (value?.schema !== 'coos.danmu-release' || value.schemaVersion !== 1 || value.source !== 'huangxd-/danmu_api' ||
      !/^[a-f0-9]{40}$/.test(value.upstreamCommit) || !/^[a-f0-9]{40}$/.test(value.builderCommit) ||
      !/^[a-f0-9]{64}$/.test(value.recipeSha256) || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !/^[a-f0-9]{32}$/.test(value.md5) || !Number.isInteger(value.size) || value.size < 128 || value.size > MAX_ARTIFACT_BYTES ||
      typeof value.version !== 'string' || !value.version || value.version.length > 80 || value.adapter !== 1) {
    throw new Error('更新清单无效或适配器版本不兼容');
  }
  const tag = 'danmu-' + value.upstreamCommit + '-' + value.recipeSha256.slice(0, 16);
  const base = 'https://github.com/leotvgo/coos-danmu-runtime/releases/download/' + tag;
  if (value.tag !== tag || value.artifactUrl !== base + '/danmu_api_server.cjs' || value.sourceUrl !== base + '/source.tar.gz') {
    throw new Error('更新包来源不受信任');
  }
  return value;
}
export async function fetchRelease(fetchImpl = globalThis.fetch, progress = () => {}, signal) {
  progress('checking');
  const first = await download(UPDATE_URL, fetchImpl, 16384, signal);
  const manifest = validateReleaseManifest(JSON.parse(first.toString('utf8')));
  progress('downloading');
  const bytes = await download(manifest.artifactUrl, fetchImpl, MAX_ARTIFACT_BYTES, signal);
  const second = await download(UPDATE_URL, fetchImpl, 16384, signal);
  if (!first.equals(second)) throw new Error('发布清单正在变化，请稍后重试');
  if (bytes.length !== manifest.size) throw new Error('更新包大小不匹配');
  const actual = inspectArtifact(bytes, manifest);
  if (actual.version !== manifest.version) throw new Error('更新包版本与清单不一致');
  return { bytes, manifest };
}
