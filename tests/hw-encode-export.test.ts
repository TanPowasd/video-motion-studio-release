import { describe, it, expect, beforeAll, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { Renderer } from '../src/core/renderer.js';
import { probe } from '../src/media/ffmpeg.js';
import { resetEncoderProbeCache } from '../src/media/video-encoder.js';
import { writeFakeFfmpeg } from './fake-ffmpeg.js';

const posix = process.platform !== 'win32';
const realFfmpeg = process.env.VMOTION_FFMPEG ?? 'ffmpeg';
let root: string, app: Application, fake: string, log: string;
const sha = async (file: string) =>
  createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const original = { ffmpeg: process.env.VMOTION_FFMPEG, encoder: process.env.VMOTION_ENCODER };
const snapshotAt = (fps: number) => {
  const copy = structuredClone(app.service.snapshot);
  copy.project.fps = { num: fps, den: 1 };
  return copy;
};
const lines = async () =>
  (await readFile(log, 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l) as string[]);
const segmentCodecs = async () =>
  (await lines())
    .filter((a) => a.some((x) => /segment-\d+\.mp4\.partial$/.test(x)))
    .map((a) => a[a.indexOf('-c:v') + 1]);

beforeAll(async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'vmotion-hwenc-fake-'));
  fake = await writeFakeFfmpeg(dir);
  log = path.join(dir, 'log.jsonl');
});
beforeEach(async () => {
  resetEncoderProbeCache();
  delete process.env.VMOTION_ENCODER;
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-hwenc-export-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
  for (const key of Object.keys(process.env))
    if (key.startsWith('FAKE_FFMPEG_')) delete process.env[key];
  if (original.ffmpeg === undefined) delete process.env.VMOTION_FFMPEG;
  else process.env.VMOTION_FFMPEG = original.ffmpeg;
  if (original.encoder !== undefined) process.env.VMOTION_ENCODER = original.encoder;
  resetEncoderProbeCache();
});

describe('hardware encode export pipeline', () => {
  it('auto on a machine without a working GPU encoder matches the software path byte-for-byte', async () => {
    const run = async (name: string, encoder?: string) => {
      const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, name),
        format: 'mp4',
        end: 8,
        width: 320,
        height: 180,
        encoder,
        resume: false,
      });
      const done = await app.renders.wait(job.id);
      expect(done.error).toBeUndefined();
      return done;
    };
    const auto = await run('auto.mp4'),
      software = await run('software.mp4', 'software');
    expect(software.encoder).toMatchObject({ mode: 'software', hardware: false });
    expect(auto.encoder?.requested).toBe('auto');
    if (auto.encoder?.hardware) return; // a real GPU encoder exists here: nothing to compare
    expect(auto.encoder?.fallbackReason).toBeTruthy();
    expect(auto.encoder?.used).toBe(software.encoder?.used);
    expect(await sha(path.join(root, 'auto.mp4'))).toBe(await sha(path.join(root, 'software.mp4')));
    // The historical explicit FFmpeg name path still produces the same bytes.
    const legacy = await run('legacy.mp4', software.encoder!.used);
    expect(legacy.encoder?.mode).toBe('custom');
    expect(await sha(path.join(root, 'legacy.mp4'))).toBe(
      await sha(path.join(root, 'software.mp4')),
    );
    expect(software.encoder).toMatchObject({ segments: 1, encodedSegments: 1, resumedSegments: 0 });
  }, 60000);

  it('exports HEVC software with an hvc1-tagged stream and project defaults', async () => {
    const snap = structuredClone(app.service.snapshot);
    snap.project.videoExport = {
      encoder: 'software',
      codec: 'hevc',
      quality: { crf: 26, preset: 'speed' },
    };
    const job = app.renders.start(snap, {
      output: path.join(root, 'hevc.mp4'),
      format: 'mp4',
      end: 6,
      width: 320,
      height: 180,
    });
    const done = await app.renders.wait(job.id);
    if (done.error?.includes('No software HEVC')) return; // FFmpeg without libx265
    expect(done.error).toBeUndefined();
    expect(done.encoder).toMatchObject({ used: 'libx265', codec: 'hevc', mode: 'software' });
    const info = await probe(path.join(root, 'hevc.mp4'));
    const video = info.streams.find((s) => s.codec_type === 'video') as any;
    expect(video.codec_name).toBe('hevc');
    expect(video.codec_tag_string).toBe('hvc1');
  }, 60000);

  it('profile and compare report the encoder used and encode wall time', async () => {
    const profile = (await app.dispatch('renderProfile', {
      frames: [0, 3],
      repeat: 1,
      width: 320,
      encoder: 'software',
      encodeFrames: 24,
    })) as any;
    expect(profile.videoEncode).toMatchObject({
      used: expect.any(String),
      hardware: false,
      frames: 24,
    });
    expect(profile.videoEncode.wallMs).toBeGreaterThan(0);
    const plain = (await app.dispatch('renderProfile', {
      frames: [0],
      repeat: 1,
      width: 320,
    })) as any;
    expect(plain.videoEncode).toBeUndefined();
    const compare = (await app.dispatch('renderCompare', {
      frames: [0],
      repeat: 1,
      width: 320,
      encodeFrames: 12,
      optimized: { encoder: 'auto' },
    })) as any;
    expect(compare.configurations.baseline.encoder).toBe('software');
    expect(compare.baseline.videoEncode.mode).toBe('software');
    expect(compare.optimized.videoEncode.requested).toBe('auto');
    expect(compare.difference.encode).toMatchObject({
      beforeMs: expect.any(Number),
      afterMs: expect.any(Number),
    });
  }, 60000);
});

describe.skipIf(!posix)('hardware encode with a fake FFmpeg device', () => {
  const useFake = (encoders: string[], fail: string[] = []) => {
    process.env.VMOTION_FFMPEG = fake;
    process.env.FAKE_FFMPEG_REAL = realFfmpeg;
    process.env.FAKE_FFMPEG_LOG = log;
    process.env.FAKE_FFMPEG_ENCODERS = encoders.join(',');
    process.env.FAKE_FFMPEG_FAIL = fail.join(',');
  };
  beforeEach(async () => writeFile(log, ''));
  const start = (extra: Record<string, unknown> = {}) =>
    app.renders.start(snapshotAt(2), {
      output: path.join(root, 'hw.mp4'),
      format: 'mp4',
      end: 24,
      width: 320,
      height: 180,
      ...extra,
    });

  it('uses a probed hardware encoder, reports it and maps quality flags', async () => {
    useFake(['libx264', 'h264_nvenc', 'h264_vaapi']);
    const done = await app.renders.wait(start({ quality: { crf: 21, keyframeInterval: 10 } }).id);
    expect(done.error).toBeUndefined();
    expect(done.encoder).toMatchObject({
      requested: 'auto',
      used: 'h264_nvenc',
      hardware: true,
      segments: 3,
      encodedSegments: 3,
    });
    expect(done.encoder!.segmentWallMs).toBeGreaterThan(0);
    const segment = (await lines()).find((a) =>
      a.some((x) => x.endsWith('segment-000000.mp4.partial')),
    )!;
    expect(segment.join(' ')).toContain(
      '-c:v h264_nvenc -preset p4 -tune hq -rc vbr -cq 21 -b:v 0',
    );
    expect(segment.join(' ')).toContain('-g 10');
    expect(Number((await probe(path.join(root, 'hw.mp4'))).format.duration)).toBeCloseTo(12, 0);
    expect(app.renders.jobs.get(done.id)?.encoder?.probe?.[0]).toMatchObject({
      encoder: 'h264_nvenc',
      ok: true,
    });
  }, 90000);

  it('fails mid-export without mixing encoders and pins resume to the started encoder', async () => {
    useFake(['libx264', 'h264_nvenc']);
    process.env.FAKE_FFMPEG_FAIL_SEGMENT = 'segment-000001';
    const failed = await app.renders.wait(start().id);
    expect(failed.status).toBe('failed');
    expect(failed.error).toMatch(/h264_nvenc .*segment 1|h264_nvenc exited/);
    expect(failed.encoder?.encodedSegments).toBe(1);
    const cacheRoot = path.join(root, '.vmotion/renders'),
      [cache] = await readdir(cacheRoot),
      checkpoint = JSON.parse(
        await readFile(path.join(cacheRoot, cache, 'checkpoint.json'), 'utf8'),
      ),
      identity = JSON.parse(await readFile(path.join(cacheRoot, cache, 'encoder.json'), 'utf8'));
    expect(checkpoint.completed).toEqual([0]);
    expect(checkpoint.encoder).toMatch(/^[a-f0-9]{64}$/);
    expect(identity).toMatchObject({ used: 'h264_nvenc', mode: 'auto' });
    expect(await segmentCodecs()).toEqual(['h264_nvenc', 'h264_nvenc']);

    // Same device healthy again: resume keeps h264_nvenc and only renders the missing frames.
    delete process.env.FAKE_FFMPEG_FAIL_SEGMENT;
    await writeFile(log, '');
    const spy = vi.spyOn(Renderer.prototype, 'render');
    try {
      const resumed = await app.renders.wait(start().id);
      expect(resumed.error).toBeUndefined();
      expect(resumed.encoder).toMatchObject({
        used: 'h264_nvenc',
        resumedSegments: 1,
        encodedSegments: 2,
      });
      expect(spy).toHaveBeenCalledTimes(14);
      expect(await segmentCodecs()).toEqual(['h264_nvenc', 'h264_nvenc']);
    } finally {
      spy.mockRestore();
    }

    // Device now gone: auto falls back to software in a fresh checkpoint, never reusing nvenc segments.
    useFake(['libx264', 'h264_nvenc'], ['h264_nvenc']);
    resetEncoderProbeCache();
    await writeFile(log, '');
    const spy2 = vi.spyOn(Renderer.prototype, 'render');
    try {
      const fallback = await app.renders.wait(start().id);
      expect(fallback.error).toBeUndefined();
      expect(fallback.encoder).toMatchObject({
        used: 'libx264',
        hardware: false,
        resumedSegments: 0,
        encodedSegments: 3,
      });
      expect(fallback.encoder?.fallbackReason).toContain(
        'h264_nvenc probe failed (No capable devices found)',
      );
      expect(spy2).toHaveBeenCalledTimes(24);
      expect(await segmentCodecs()).toEqual(['libx264', 'libx264', 'libx264']);
    } finally {
      spy2.mockRestore();
    }
    expect(await readdir(cacheRoot)).toHaveLength(2);
  }, 120000);

  it('explicit hardware fails before rendering pixels when the device is unavailable', async () => {
    useFake(['libx264', 'h264_qsv'], ['h264_qsv']);
    const spy = vi.spyOn(Renderer.prototype, 'render');
    try {
      const missing = await app.renders.wait(start({ encoder: 'nvenc' }).id);
      expect(missing.status).toBe('failed');
      expect(missing.error).toContain('h264_nvenc is not built into this FFmpeg');
      const broken = await app.renders.wait(start({ encoder: 'qsv' }).id);
      expect(broken.error).toContain('h264_qsv failed its probe encode: No capable devices found');
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  }, 60000);
});

it('fake FFmpeg helper is executable', async () => {
  if (!posix) return;
  process.env.FAKE_FFMPEG_ENCODERS = 'h264_nvenc';
  expect(execFileSync(fake, ['-hide_banner', '-encoders']).toString()).toContain('h264_nvenc');
  delete process.env.FAKE_FFMPEG_ENCODERS;
});
