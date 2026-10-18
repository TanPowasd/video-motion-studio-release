// Cross-platform entry for `npm run native:build`.
// Windows keeps the full PowerShell pipeline (core + DX12 GPU helper + audio host + notices).
// Linux/macOS build the vmotion-core evaluator/rasterizer and publish it to dist/native with the
// same content-hashed manifest layout the runtime resolves (src/core/native.ts resolveNativeBinary).
// The GPU helper is DX12-only (crates/vmotion-gpu features), so it is skipped off Windows and the
// runtime falls back to its CPU point path; the audio host is built separately (native-audio/).
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname), '..');
const run = (command, args) => {
  const result = spawnSync(command, args, { cwd: root, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
};

if (process.platform === 'win32') {
  run('powershell', [
    '-NoProfile',
    '-ExecutionPolicy',
    'Bypass',
    '-File',
    path.join(root, 'scripts/build-native.ps1'),
  ]);
  process.exit(0);
}

const homeCargo = path.join(os.homedir(), '.cargo/bin/cargo');
const cargo = process.env.CARGO ?? (existsSync(homeCargo) ? homeCargo : 'cargo');
run(cargo, ['build', '--manifest-path', 'crates/vmotion-core/Cargo.toml', '--release']);

const built = path.join(root, 'crates/vmotion-core/target/release/vmotion-core');
const hash = createHash('sha256').update(readFileSync(built)).digest('hex').slice(0, 16);
const executable = `vmotion-core-${hash}`;
const outDir = path.join(root, 'dist/native');
mkdirSync(outDir, { recursive: true });
const destination = path.join(outDir, executable);
if (!existsSync(destination)) copyFileSync(built, destination);
const manifest = {
  executable,
  version: '0.5.0',
  platform: `${process.platform}-${process.arch}`,
};
writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest));
console.log(
  `[native] ${manifest.platform}: dist/native/${executable} (GPU helper is DX12/Windows-only; skipped)`,
);
