import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { mediaBinary } from '../src/media/ffmpeg.js';
import { runtimeDirectory, configureBundledCompiler } from '../src/core/bundled-runtime.js';
it('locates portable media/compiler from its own runtime, preserves explicit overrides and rejects incomplete bundles', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-runtime-')),
    original = {
      runtime: process.env.VMOTION_RUNTIME,
      ffmpeg: process.env.VMOTION_FFMPEG,
      compiler: process.env.ESBUILD_BINARY_PATH,
    };
  try {
    process.env.VMOTION_RUNTIME = path.join(root, '移动 目录/runtime');
    delete process.env.VMOTION_FFMPEG;
    delete process.env.ESBUILD_BINARY_PATH;
    await mkdir(path.join(process.env.VMOTION_RUNTIME, 'media/bin'), { recursive: true });
    await mkdir(path.join(root, '移动 目录/compiler'), { recursive: true });
    const binary = path.join(
      process.env.VMOTION_RUNTIME,
      'media/bin',
      process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    );
    await writeFile(binary, 'test');
    expect(runtimeDirectory()).toBe(process.env.VMOTION_RUNTIME);
    expect(mediaBinary('ffmpeg')).toBe(binary);
    expect(() => mediaBinary('ffprobe')).toThrow(/missing/);
    process.env.VMOTION_FFMPEG = 'custom';
    expect(mediaBinary('ffmpeg')).toBe('custom');
    const compiler = path.join(root, '移动 目录/compiler/esbuild.exe');
    await writeFile(compiler, 'test');
    configureBundledCompiler();
    expect(process.env.ESBUILD_BINARY_PATH).toBe(compiler);
    process.env.ESBUILD_BINARY_PATH = 'explicit';
    configureBundledCompiler();
    expect(process.env.ESBUILD_BINARY_PATH).toBe('explicit');
  } finally {
    for (const [key, value] of Object.entries({
      VMOTION_RUNTIME: original.runtime,
      VMOTION_FFMPEG: original.ffmpeg,
      ESBUILD_BINARY_PATH: original.compiler,
    }))
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    await rm(root, { recursive: true, force: true });
  }
});
