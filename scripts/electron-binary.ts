// Electron 44 has no npm postinstall: `npm ci` installs only the JS shim, and the binary is
// downloaded lazily the first time `electron` runs (or by its install.js). The packager copies
// node_modules/electron/dist directly, so it must make sure the binary is there first.
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ELECTRON_FIX_COMMAND = 'node node_modules/electron/install.js';

const platformExecutable = (platform: NodeJS.Platform) =>
  platform === 'win32'
    ? 'electron.exe'
    : platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron';

export interface ElectronBinaryStatus {
  ok: boolean;
  executable: string;
  reason?: string;
}

export function electronBinaryStatus(
  root: string,
  platform: NodeJS.Platform = process.platform,
): ElectronBinaryStatus {
  const pkg = path.join(root, 'node_modules/electron');
  const expected = platformExecutable(platform);
  const executable = path.join(pkg, 'dist', expected);
  if (!existsSync(path.join(pkg, 'package.json')))
    return { ok: false, executable, reason: 'the electron package is not installed (run npm ci)' };
  const pathFile = path.join(pkg, 'path.txt');
  const recorded = existsSync(pathFile) ? readFileSync(pathFile, 'utf8').trim() : undefined;
  if (recorded !== undefined && recorded !== expected)
    return { ok: false, executable, reason: `node_modules/electron/path.txt points at ${recorded}, not ${expected}` };
  if (!existsSync(executable))
    return { ok: false, executable, reason: `the Electron binary is missing (${path.relative(root, executable)})` };
  return { ok: true, executable };
}

export const electronMissingMessage = (status: ElectronBinaryStatus) =>
  `Electron binary not available: ${status.reason}.\n` +
  `npm ci does not download it (Electron has no postinstall step). From the repository root run:\n` +
  `  ${ELECTRON_FIX_COMMAND}\n` +
  `then retry. Behind a proxy/mirror set ELECTRON_MIRROR or electron_config_cache first.`;

/** Returns the Electron executable, downloading it with electron's own installer when missing. */
export function ensureElectronBinary(
  root: string,
  { install = true, platform = process.platform }: { install?: boolean; platform?: NodeJS.Platform } = {},
): string {
  let status = electronBinaryStatus(root, platform);
  if (status.ok) return status.executable;
  const installer = path.join(root, 'node_modules/electron/install.js');
  if (install && existsSync(installer)) {
    console.log(`[electron] ${status.reason}; running ${ELECTRON_FIX_COMMAND}`);
    spawnSync(process.execPath, [installer], { cwd: root, stdio: 'inherit' });
    status = electronBinaryStatus(root, platform);
    if (status.ok) return status.executable;
  }
  throw new Error(electronMissingMessage(status));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  console.log(ensureElectronBinary(path.resolve('.'), { install: !process.argv.includes('--check') }));
