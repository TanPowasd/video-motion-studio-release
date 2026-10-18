import { describe, it, expect } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  ELECTRON_FIX_COMMAND,
  electronBinaryStatus,
  electronMissingMessage,
  ensureElectronBinary,
} from '../scripts/electron-binary.js';

// Windows verification: `npm ci` left node_modules/electron/dist empty (Electron 44 has no
// postinstall), so packaging failed until `node node_modules/electron/install.js` was run.
describe('electron binary preflight', () => {
  it('reports a missing binary with the exact fix command and accepts an installed one', () => {
    const root = mkdtempSync(path.join(os.tmpdir(), 'vmotion-electron-'));
    try {
      const pkg = path.join(root, 'node_modules/electron');
      expect(electronBinaryStatus(root, 'win32')).toMatchObject({ ok: false });
      mkdirSync(pkg, { recursive: true });
      writeFileSync(path.join(pkg, 'package.json'), '{"name":"electron"}');
      const missing = electronBinaryStatus(root, 'win32');
      expect(missing.ok).toBe(false);
      expect(missing.reason).toContain('electron.exe');
      expect(electronMissingMessage(missing)).toContain(ELECTRON_FIX_COMMAND);
      expect(ELECTRON_FIX_COMMAND).toBe('node node_modules/electron/install.js');
      expect(() => ensureElectronBinary(root, { install: false, platform: 'win32' })).toThrow(ELECTRON_FIX_COMMAND);
      writeFileSync(path.join(pkg, 'path.txt'), 'electron');
      expect(electronBinaryStatus(root, 'win32').reason).toContain('path.txt');
      mkdirSync(path.join(pkg, 'dist'));
      writeFileSync(path.join(pkg, 'dist/electron.exe'), '');
      writeFileSync(path.join(pkg, 'path.txt'), 'electron.exe');
      expect(ensureElectronBinary(root, { install: false, platform: 'win32' })).toBe(path.join(pkg, 'dist/electron.exe'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
