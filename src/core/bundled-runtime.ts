import path from 'node:path';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
const directory = path.dirname(
  typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
    ? fileURLToPath(import.meta.url)
    : String(import.meta.url),
);
export function runtimeDirectory() {
  if (process.env.VMOTION_RUNTIME) return path.resolve(process.env.VMOTION_RUNTIME);
  const candidates = [
    ...(typeof (process as any).resourcesPath === 'string'
      ? [path.join((process as any).resourcesPath, 'runtime')]
      : []),
    path.resolve(directory, '../../../runtime'),
    path.resolve(directory, '../../dist/runtime'),
  ];
  return candidates.find((candidate) => existsSync(path.join(candidate, 'manifest.json')));
}
export function runtimeFile(relative: string) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => part === '..'))
    throw new Error('Runtime path must be relative');
  const directory = runtimeDirectory();
  return directory ? path.join(directory, relative) : undefined;
}
export function configureBundledCompiler() {
  if (process.env.ESBUILD_BINARY_PATH) return;
  const runtime = runtimeDirectory();
  if (!runtime) return;
  const file = path.resolve(runtime, '../compiler/esbuild.exe');
  if (existsSync(file)) process.env.ESBUILD_BINARY_PATH = file;
}
