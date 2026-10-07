import path from 'node:path';
import { readFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { initializeBundledFonts } from './bundled-fonts.js';
const digest = (data: string | Buffer) => createHash('sha256').update(data).digest('hex');
const entry =
    typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
      ? fileURLToPath(import.meta.url)
      : String(import.meta.url),
  directory = path.dirname(entry);
async function codeIdentity() {
  if (/\.(mjs|cjs)$/.test(entry)) return { bundle: digest(await readFile(entry)) };
  const sourceRoot = path.resolve(directory, '..'),
    records: Array<[string, string]> = [];
  const visit = async (relative: string) => {
    for (const item of await readdir(path.join(sourceRoot, relative), { withFileTypes: true })) {
      const name = relative + '/' + item.name;
      if (item.isDirectory()) await visit(name);
      else if (item.name.endsWith('.ts'))
        records.push([name, digest(await readFile(path.join(sourceRoot, name)))]);
    }
  };
  await Promise.all(['core', 'sdk', 'media'].map(visit));
  records.sort(([a], [b]) => a.localeCompare(b, 'en'));
  return { source: digest(JSON.stringify(records)) };
}
// Project reloads do not hot-replace the renderer code of this running process.
const code = codeIdentity();
export async function renderRuntimeFingerprint(nativeBinary: string, gpu?: unknown) {
  const sdk = existsSync(path.resolve(directory, '../sdk/index.mjs'))
      ? path.resolve(directory, '../sdk/index.mjs')
      : path.resolve(directory, '../../dist/sdk/index.mjs'),
    require = createRequire(path.join(directory, 'runtime-require.cjs')),
    canvasEntry = require.resolve('@napi-rs/canvas'),
    signature = {
      ...(await code),
      sdk: existsSync(sdk) ? digest(await readFile(sdk)) : 'source-sdk',
      native: existsSync(nativeBinary)
        ? digest(await readFile(nativeBinary))
        : 'typescript-fallback',
      canvas: digest(await readFile(path.join(path.dirname(canvasEntry), 'package.json'))),
      node: process.versions.node,
      platform: process.platform,
      arch: process.arch,
      gpu,
      bundledFont: initializeBundledFonts(),
    };
  return { fingerprint: digest(JSON.stringify(signature)), signature };
}
