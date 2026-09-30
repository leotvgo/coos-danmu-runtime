import { createHash } from 'node:crypto';
import { Script } from 'node:vm';
import { unicodeRanges } from './unicode-ranges.js';
export const ADAPTER_VERSION = 1;
export const MAX_ARTIFACT_BYTES = 24 * 1024 * 1024;
export function digest(bytes, algorithm = 'sha256') { return createHash(algorithm).update(bytes).digest('hex'); }
export function compatibleSource(input) {
  let source = String(input);
  const slash = String.fromCharCode(92);
  const marker = slash + String.fromCharCode(112, 123);
  let position = source.indexOf(marker);
  while (position !== -1) {
    const end = source.indexOf('}', position);
    const name = source.slice(position + marker.length, end);
    const range = unicodeRanges[name];
    if (!range || end === -1) throw new Error('运行包包含尚未支持的 Unicode 表达式');
    let begin = position;
    while (begin > 0 && source[begin - 1] === slash) begin -= 1;
    const escapes = position - begin + 1;
    const inClass = source.lastIndexOf('[', begin) > source.lastIndexOf(']', begin);
    const replacement = (inClass ? range : '[' + range + ']').split(slash).join(slash.repeat(escapes));
    source = source.slice(0, begin) + replacement + source.slice(end + 1);
    position = source.indexOf(marker, begin + replacement.length);
  }
  return source;
}
export function inspectArtifact(bytes, expected = {}) {
  if (!Buffer.isBuffer(bytes)) bytes = Buffer.from(bytes);
  if (bytes.length < 128 || bytes.length > MAX_ARTIFACT_BYTES) throw new Error('弹幕运行包大小无效');
  const sha256 = digest(bytes); const md5 = digest(bytes, 'md5');
  if (expected.sha256 && expected.sha256 !== sha256) throw new Error('弹幕运行包 SHA-256 校验失败');
  if (expected.md5 && expected.md5.toLowerCase() !== md5) throw new Error('弹幕运行包 MD5 校验失败');
  const code = compatibleSource(bytes.toString('utf8'));
  new Script('(function(require,module,exports,__filename,__dirname){\n' + code + '\n})', { filename: 'danmu-runtime.cjs' });
  const version = /VERSION\s*:\s*["']([^"']{1,80})["']/.exec(code)?.[1] || expected.version || sha256.slice(0, 12);
  return { schema: 1, version, sha256, md5, size: bytes.length, adapter: ADAPTER_VERSION,
    source: expected.source || 'huangxd-/danmu_api',
    ...Object.fromEntries(['upstreamCommit','builderCommit','recipeSha256','sourceUrl','artifactUrl'].filter(key => typeof expected[key] === 'string').map(key => [key, expected[key]])), installedAt: new Date().toISOString() };
}
