// This runs in the separate publication job; it never executes the downloaded component.
import { readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { validateReleaseManifest } from '../src/channel.js';
const dir = resolve(process.argv[2]);
const manifest = validateReleaseManifest(JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')));
const bytes = await readFile(join(dir, 'danmu_api_server.cjs'));
if (bytes.length !== manifest.size || createHash('sha256').update(bytes).digest('hex') !== manifest.sha256) throw new Error('Publication artifact mismatch');
const repo = 'leotvgo/coos-danmu-runtime';
function gh(...args) { return execFileSync('gh', [...args, '--repo', repo], { encoding: 'utf8' }); }
function exists(tag) {
  const r = spawnSync('gh', ['api', `repos/${repo}/releases/tags/${tag}`], { encoding: 'utf8' });
  if (r.status === 0) return true;
  if (r.stderr.includes('HTTP 404')) return false;
  throw new Error('Cannot query release state');
}
const notes = join(dir, 'release-notes.md');
await writeFile(notes, `Complete danmu component built from [huangxd-/danmu_api ${manifest.upstreamCommit}](https://github.com/huangxd-/danmu_api/commit/${manifest.upstreamCommit}).\n\nVersion: ${manifest.version}\n\nVerified on Node 18.17.1 and Node 24. Includes the original management UI, COOS CJS adaptation and corresponding source.\n\nSHA-256: ${manifest.sha256}\n`);
if (!exists(manifest.tag)) {
  gh('release', 'create', manifest.tag, '--target', manifest.builderCommit, '--latest=false',
    '--title', `Danmu ${manifest.version} (${manifest.upstreamCommit.slice(0,8)})`, '--notes-file', notes,
    ...['danmu_api_server.cjs', 'danmu_api_server.cjs.md5', 'manifest.json', 'source.tar.gz', 'LICENSE', 'NOTICE.md'].map(n => join(dir,n)));
} else {
  const existing=JSON.parse(execFileSync('gh',['api',`repos/${repo}/releases/tags/${manifest.tag}`],{encoding:'utf8'}));
  for(const name of ['danmu_api_server.cjs','danmu_api_server.cjs.md5','manifest.json','source.tar.gz','LICENSE','NOTICE.md']) {
    if(!existing.assets.some(asset=>asset.name===name)) gh('release','upload',manifest.tag,join(dir,name));
  }
  const metadata=await fetch(manifest.artifactUrl.replace('danmu_api_server.cjs','manifest.json'),{signal:AbortSignal.timeout(30000)});
  if(!metadata.ok || validateReleaseManifest(await metadata.json()).sha256!==manifest.sha256) throw new Error('Immutable release manifest differs');
  const response = await fetch(manifest.artifactUrl, { signal: AbortSignal.timeout(60000) });
  if (!response.ok || createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex') !== manifest.sha256) {
    throw new Error('Immutable release already exists with different bytes');
  }
}
// The only mutable asset is this small manifest. It points at the immutable release above.
if (!exists('danmu-stable')) {
  gh('release','create','danmu-stable','--target',manifest.builderCommit,'--latest=false',
    '--title','Verified danmu component channel','--notes-file',notes,join(dir,'manifest.json'));
} else gh('release','upload','danmu-stable',join(dir,'manifest.json'),'--clobber');
console.log('Published verified component: ' + manifest.tag);
