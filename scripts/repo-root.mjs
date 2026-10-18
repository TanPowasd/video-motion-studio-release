// Resolve the repository root from a script's import.meta.url.
// Never use `new URL(import.meta.url).pathname`: on Windows it yields `/E:/repo/scripts/x.mjs`,
// and path.resolve() turns that into `E:\E:\repo` (double drive letter). fileURLToPath handles
// drive letters, UNC hosts and percent-encoding (spaces, CJK) on every platform.
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * @param {string | URL} moduleUrl import.meta.url of a file directly inside scripts/
 * @param {{ windows?: boolean }} [options] force Windows/POSIX semantics (tests); defaults to the host
 */
export const repoRootFromModuleUrl = (moduleUrl, { windows = process.platform === 'win32' } = {}) => {
  const paths = windows ? path.win32 : path.posix;
  return paths.resolve(paths.dirname(fileURLToPath(moduleUrl, { windows })), '..');
};
