import { execFileSync } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile, appendFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateReleaseManifest } from '../src/channel.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const work = resolve(process.argv[2] || '.');
if (work === root || work.startsWith(root + '/')) throw new Error('Use a scratch directory outside this repository');
await mkdir(work, { recursive: true });
const commit = execFileSync('git', ['ls-remote', 'https://github.com/huangxd-/danmu_api.git', 'refs/heads/main'], { encoding: 'utf8' }).split(/\s/)[0];
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error('Invalid upstream commit');
const hash = createHash('sha256');
for (const dir of ['scripts', 'src', 'test']) {
  for (const name of (await readdir(join(root, dir))).sort()) {
    const path = dir + '/' + name; hash.update(path).update(await readFile(join(root, path)));
  }
}
for (const path of ['package-lock.json']) hash.update(path).update(await readFile(join(root, path)));
const recipe = hash.digest('hex');
let previous;
const response = await fetch('https://github.com/leotvgo/coos-danmu-runtime/releases/download/danmu-stable/manifest.json', { signal: AbortSignal.timeout(30000) });
if (response.ok) previous = validateReleaseManifest(await response.json());
else if (response.status !== 404) throw new Error('Cannot check current channel: HTTP ' + response.status);
const needed = previous?.upstreamCommit !== commit || previous?.recipeSha256 !== recipe;
await writeFile(join(work, 'plan.json'), JSON.stringify({ commit, recipe, needed }));
if (process.env.GITHUB_OUTPUT) await appendFile(process.env.GITHUB_OUTPUT, `needed=${needed}\ncommit=${commit}\nrecipe=${recipe}\n`);
console.log(JSON.stringify({ commit, recipe, needed }));
if (needed) {
  const source = join(work, 'upstream');
  execFileSync('git', ['clone', '--filter=blob:none', '--no-checkout', 'https://github.com/huangxd-/danmu_api.git', source], { stdio: 'inherit' });
  execFileSync('git', ['-C', source, 'checkout', '--detach', commit], { stdio: 'inherit' });
  // The generated lock (including integrity hashes) is shipped with corresponding source.
  execFileSync('npm', ['install', '--ignore-scripts', '--no-audit', '--no-fund'], { cwd: source, stdio: 'inherit' });
}
