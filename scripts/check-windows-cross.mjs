#!/usr/bin/env node
// Cross-target type check of the Windows-only Rust crates from Linux/macOS (no Windows needed).
//
//   node scripts/check-windows-cross.mjs            # cargo check --target x86_64-pc-windows-msvc
//   node scripts/check-windows-cross.mjs --install  # rustup target add first if it is missing
//   options: --target <triple> (default x86_64-pc-windows-msvc), --target-dir <dir>
//
// `cargo check` compiles every crate for the Windows target (DX12 wgpu-hal, windows-sys, d3d12, the
// WARP opt-in in vmotion-gpu) but never links, so it needs no MSVC CRT/Windows SDK: only the
// rust-std for the target plus a host C linker for build scripts. It catches cfg(windows) compile
// errors early; it does NOT prove the binaries link, start, or find a D3D12 device. Real linking
// (cargo-xwin + the MSVC CRT/SDK download) and running stay with the Windows CI workflow and the
// reference GPU machine. Exit 1 on any failure.
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { repoRootFromModuleUrl } from './repo-root.mjs';

const root = repoRootFromModuleUrl(import.meta.url);
const argv = process.argv.slice(2),
  option = (name, fallback) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : fallback;
  },
  target = option('--target', 'x86_64-pc-windows-msvc'),
  targetDir = path.resolve(option('--target-dir', path.join(root, 'artifacts/windows-cross'))),
  bin = (name) => {
    const home = path.join(process.env.CARGO_HOME ?? path.join(os.homedir(), '.cargo'), 'bin', name);
    return existsSync(home) ? home : name;
  },
  cargo = process.env.CARGO ?? bin('cargo'),
  rustup = bin('rustup');

const installed = spawnSync(rustup, ['target', 'list', '--installed'], { encoding: 'utf8' });
if (installed.status === 0 && !installed.stdout.split(/\s+/).includes(target)) {
  if (!argv.includes('--install')) {
    console.error(`rust-std for ${target} is not installed; rerun with --install or: rustup target add ${target}`);
    process.exit(1);
  }
  const add = spawnSync(rustup, ['target', 'add', target], { stdio: 'inherit' });
  if (add.status !== 0) process.exit(add.status ?? 1);
}

const crates = ['crates/vmotion-core', 'crates/vmotion-gpu'];
const results = [];
for (const crate of crates) {
  const started = Date.now();
  const run = spawnSync(
    cargo,
    [
      'check',
      '--locked',
      '--manifest-path',
      path.join(root, crate, 'Cargo.toml'),
      '--target',
      target,
      '--target-dir',
      targetDir,
    ],
    { stdio: 'inherit' },
  );
  results.push({ crate, target, ok: run.status === 0, seconds: Math.round((Date.now() - started) / 100) / 10 });
}
console.table(results);
if (results.some((r) => !r.ok)) process.exit(1);
console.log(`OK: ${crates.length} crates type-check for ${target} (compile only; not linked or run)`);
