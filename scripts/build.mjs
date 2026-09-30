// COOS packaging adapter for huangxd-/danmu_api. Source collectors/UI remain upstream.
// The CJS adaptation strategy follows YYDS678/danmu_api build-for-uzn.mjs (AGPL-3.0).
import { build } from 'esbuild';
import { readFile, writeFile, mkdir, realpath } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { inspectArtifact } from '../src/compatibility.js';

const [sourceArg, outputArg, recipe, builderCommit] = process.argv.slice(2);
if (!sourceArg || !outputArg || !/^[a-f0-9]{64}$/.test(recipe) || !/^[a-f0-9]{40}$/.test(builderCommit)) {
  throw new Error('usage: build.mjs upstream-directory output-directory recipe-sha256 builder-commit');
}
const source = await realpath(resolve(sourceArg)), output = resolve(outputArg);
const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
const sourceRoot = join(source, 'danmu_api');
await mkdir(output, { recursive: true });
function replaceRequired(text, pattern, replacement, label) {
  let hits = 0;
  const next = text.replace(pattern, (...args) => { hits++; return typeof replacement === 'function' ? replacement(...args) : replacement; });
  if (!hits) throw new Error('Upstream packaging interface changed: ' + label);
  return next;
}
const outfile = join(output, 'danmu_api_server.cjs');
await build({
  entryPoints: [join(sourceRoot, 'server.js')], outfile, bundle: true, platform: 'node', format: 'cjs',
  target: 'node18', minify: true, legalComments: 'none', logLevel: 'warning',
  banner: { js: 'var __coos_bundle_url=require("node:url").pathToFileURL(__filename).href;' },
  plugins: [{ name: 'coos-upstream-cjs', setup(api) {
    api.onResolve({ filter: /esm-shim\.cjs$/ }, () => ({ path: 'shim', namespace: 'coos-shim' }));
    api.onLoad({ filter: /.*/, namespace: 'coos-shim' }, () => ({ contents: '', loader: 'js' }));
    api.onLoad({ filter: /\.js$/ }, async args => {
      if (!args.path.startsWith(sourceRoot + '/')) return;
      let text = (await readFile(args.path, 'utf8')).replace(/\bimport\.meta\.url\b/g, '__coos_bundle_url');
      if (args.path.endsWith('/node-handler.js')) {
        text = replaceRequired(text, /path\.join\(__dirname, '\.\.', '\.\.', '\.\.', 'config', '\.env'\)/g,
          "path.join(__dirname, '..', 'config', '.env')", 'configuration path');
        text = replaceRequired(text, /throw new Error\('\.env not found'\);/g,
          "fs.mkdirSync(path.dirname(envPath), { recursive: true }); fs.writeFileSync(envPath, '', { mode: 0o600 });", 'initial configuration');
        text = replaceRequired(text, /const envExists = fs\.existsSync\(envPath\);/g,
          'const envExists = true;', 'initial configuration branch');
        // Keep creation conditional while the following update branch sees the created file.
        text = text.replace(/if \(!envExists\) \{/g, 'if (!fs.existsSync(envPath)) {');
      }
      if (args.path.endsWith('/cache-util.js')) text = replaceRequired(text,
        /export function getDirname\(\)\s*\{[\s\S]*?return path\.join\(process\.cwd\(\),\s*(['"])danmu_api\1,\s*(['"])utils\2\);\s*\}/,
        "export function getDirname() { return path.join(process.cwd(), 'danmu_api', 'utils'); }", 'cache directory');
      if (args.path.endsWith('/handler-factory.js')) text = replaceRequired(text,
        /import\(\s*\[\s*(['"])\.\/node-handler\1\s*,\s*\1\.js\1\s*\]\s*\.\s*join\(\s*\1\1\s*\)\s*\)/g,
        "import('./node-handler.js')", 'node handler import');
      if (args.path.endsWith('/server.js')) text = replaceRequired(text,
        /if \(typeof global\.loadNodeFetch === 'function'\) \{\s*await global\.loadNodeFetch\(\);\s*\}/,
        '/* Node18 fetch is supplied by the host. */', 'ESM bootstrap');
      return { contents: text, loader: 'js' };
    });
  } }],
});
const bytes = await readFile(outfile);
const artifact = inspectArtifact(bytes);
const tag = 'danmu-' + commit + '-' + recipe.slice(0, 16);
const base = 'https://github.com/leotvgo/coos-danmu-runtime/releases/download/' + tag;
const manifest = {
  schema: 'coos.danmu-release', schemaVersion: 1, ...artifact,
  source: 'huangxd-/danmu_api', upstreamCommit: commit, builderCommit, recipeSha256: recipe,
  dependencyLockSha256: createHash('sha256').update(await readFile(join(source, 'package-lock.json'))).digest('hex'),
  artifactUrl: base + '/danmu_api_server.cjs', sourceUrl: base + '/source.tar.gz', tag,
};
manifest.schema = 'coos.danmu-release';
await writeFile(join(output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
await writeFile(outfile + '.md5', artifact.md5 + '\n');
await writeFile(join(output, 'LICENSE'), await readFile(join(source, 'LICENSE')));
await writeFile(join(output, 'NOTICE.md'), `Source: https://github.com/huangxd-/danmu_api/tree/${commit}\nCOOS packaging: https://github.com/leotvgo/coos-danmu-runtime/tree/${builderCommit}/scripts\nCJS adapter derived from YYDS678/danmu_api, AGPL-3.0. Complete corresponding source: ${manifest.sourceUrl}\n`);
console.log(JSON.stringify({ version: manifest.version, upstreamCommit: commit, sha256: artifact.sha256 }));
