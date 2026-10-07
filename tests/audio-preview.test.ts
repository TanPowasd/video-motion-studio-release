import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { ffmpegBinary, runProcess } from '../src/media/ffmpeg.js';
import {
  audioClips,
  mixAudioSamples,
  sampleAtFrame,
  audioEnvelopeAt,
  AUDIO_SAMPLE_RATE,
} from '../src/media/audio.js';
import { audioMetrics } from '../src/media/audio-preview.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-audio-preview-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
async function tone(expression = '0.2') {
  const file = path.join(root, 'source.wav');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    `aevalsrc=${expression}:s=48000:d=12`,
    '-c:a',
    'pcm_f32le',
    file,
  ]);
  await app.dispatch('import', { path: file, type: 'audio' });
  return app.service.snapshot.project.assets[0];
}
const clip = (id: string, assetId: string, patch: Record<string, unknown> = {}) => ({
  id,
  assetId,
  start: 0,
  duration: 300,
  sourceIn: 0,
  speed: 1,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...patch,
});
const left = (buffer: Buffer, at: number) => buffer.readFloatLE(Math.floor(at * 48000) * 8);
it('mixes range samples with continuous fades rather than restarting fade-in at every chunk', async () => {
  const asset = await tone();
  await app.service.transact([
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: clip('tone', asset.id, { fadeIn: 60, fadeOut: 60, volume: 0.5 }) as any,
    },
  ]);
  const full = await app.audioPreview.range(app.service.snapshot, {
      startSample: 0,
      sampleCount: 480000,
    }),
    middle = await app.audioPreview.range(app.service.snapshot, {
      startSample: 48000,
      sampleCount: 96000,
    });
  expect(full.buffer.length).toBe(480000 * 8);
  expect(left(full.buffer, 1.5)).toBeCloseTo(0.075, 3);
  expect(left(middle.buffer, 0.5)).toBeCloseTo(left(full.buffer, 1.5), 5);
  expect(left(full.buffer, 9.5)).toBeCloseTo(0.025, 3);
  expect(audioMetrics(full.buffer).peak).toBeCloseTo(0.1, 3);
}, 30000);
it('nested volume and fade envelopes survive trimming and speed conversion', async () => {
  const asset = await tone();
  const snapshot = app.service.snapshot,
    child = {
      id: 'child',
      name: 'Child',
      duration: 300,
      tracks: [
        {
          id: 'voice-child',
          name: 'Child audio',
          type: 'audio',
          muted: false,
          clips: [clip('tone', asset.id, { volume: 0.5, fadeIn: 120 })],
        },
      ],
      markers: [],
    },
    manifest = { ...snapshot.project, sequences: ['sequences/main.json', 'sequences/child.json'] },
    main = {
      ...snapshot.sequences[0],
      tracks: [
        {
          id: 'parent',
          name: 'Parent',
          type: 'audio',
          muted: false,
          clips: [
            {
              id: 'nested',
              sequenceId: 'child',
              start: 30,
              duration: 120,
              sourceIn: 30,
              speed: 2,
              volume: 0.5,
              fadeIn: 60,
              fadeOut: 30,
            },
          ],
        },
      ],
    };
  const edited = { ...snapshot, project: manifest, sequences: [main, child] as any },
    collected = audioClips(edited);
  expect(collected[0].volume).toBe(0.25);
  expect(collected[0].speed).toBe(2);
  expect(audioEnvelopeAt(collected[0], 60)).toBeCloseTo(0.09375);
  const range = await mixAudioSamples(root, edited, 0, 48000 * 6);
  expect(left(range.buffer, 2)).toBeCloseTo(0.01875, 3);
  expect(left(range.buffer, 4.5)).toBeCloseTo(0.025, 3);
  expect(left(range.buffer, 5.2)).toBeCloseTo(0, 5);
}, 30000);
it('preview audio matches exported WAV and mute changes invalidate the preview cache', async () => {
  const asset = await tone('0.2*sin(2*PI*220*t)');
  await app.service.transact([
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: clip('tone', asset.id, { duration: 120, fadeIn: 15, fadeOut: 15, speed: 1.5 }) as any,
    },
  ]);
  const preview = await app.audioPreview.range(app.service.snapshot, {
      startSample: 0,
      sampleCount: 192000,
    }),
    file = path.join(root, 'mix.wav'),
    job = app.renders.start(app.service.snapshot, {
      output: file,
      format: 'wav',
      start: 0,
      end: 120,
    });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  const exported = await runProcess(ffmpegBinary(), [
    '-v',
    'error',
    '-i',
    file,
    '-ac',
    '2',
    '-ar',
    '48000',
    '-f',
    'f32le',
    'pipe:1',
  ]);
  expect(exported.length).toBe(preview.buffer.length);
  let error = 0;
  for (let i = 0; i < exported.length; i += 8)
    error += Math.abs(exported.readFloatLE(i) - preview.buffer.readFloatLE(i));
  expect(error / (exported.length / 8)).toBeLessThan(0.00004);
  const previous = app.service.snapshot.revision;
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: app.service.snapshot.sequences[0].tracks.map((track) =>
          track.id === 'voice' ? { ...track, muted: true } : track,
        ),
      },
    },
  ]);
  expect(
    audioMetrics(
      (await app.audioPreview.range(app.service.snapshot, { startSample: 0, sampleCount: 48000 }))
        .buffer,
    ).peak,
  ).toBe(0);
  await expect(
    app.audioPreview.range(app.service.snapshot, {
      revision: previous,
      startSample: 0,
      sampleCount: 48000,
    }),
  ).rejects.toThrow('changed');
}, 30000);
it('fractional frame-rate preview pieces return exact sample counts and queue cancellation does not hang', async () => {
  const asset = await tone();
  await app.service.transact([
    { type: 'updateProject', patch: { fps: { num: 30000, den: 1001 } } },
    { type: 'addClip', sequenceId: 'main', trackId: 'voice', clip: clip('tone', asset.id) as any },
  ]);
  const end = sampleAtFrame(300, app.service.snapshot.project.fps),
    request = { startSample: end - 12345, sampleCount: 192000 },
    range = await app.audioPreview.range(app.service.snapshot, request);
  expect(range.sampleCount).toBe(12345);
  expect(range.buffer.length).toBe(12345 * 8);
  expect(range.duration).toBe(12345 / 48000);
  const controller = new AbortController();
  controller.abort();
  await expect(
    app.audioPreview.range(
      app.service.snapshot,
      { startSample: 0, sampleCount: 48000 },
      controller.signal,
    ),
  ).rejects.toThrow('cancelled');
}, 30000);
it('reuses a source in overlapping clips without double-normalizing and preserves range levels', async () => {
  const asset = await tone();
  await app.service.transact([
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: clip('a', asset.id, { duration: 120, volume: 0.5 }) as any,
    },
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: clip('b', asset.id, { start: 30, duration: 120, sourceIn: 60, volume: 0.25 }) as any,
    },
  ]);
  const data = await app.audioPreview.range(app.service.snapshot, {
    startSample: 0,
    sampleCount: 240000,
  });
  expect(left(data.buffer, 0.5)).toBeCloseTo(0.1, 3);
  expect(left(data.buffer, 2)).toBeCloseTo(0.15, 3);
  expect(left(data.buffer, 4.5)).toBeCloseTo(0.05, 3);
  const middle = await app.audioPreview.range(app.service.snapshot, {
    startSample: 48000 * 2,
    sampleCount: 48000,
  });
  expect(left(middle.buffer, 0.2)).toBeCloseTo(0.15, 3);
}, 30000);
it('records audio metadata and places its actual length on the track instead of a fixed five seconds', async () => {
  const asset = await tone();
  expect(asset.metadata.duration).toBe(12);
  expect(asset.metadata.sampleRate).toBe(48000);
  expect(asset.metadata.channels).toBe(1);
  await app.service.transact([
    { type: 'updateSequence', sequenceId: 'main', patch: { duration: 600 } },
  ]);
  const placed = await app.dispatch('assetPlace', {
    assetId: asset.id,
    sequenceId: 'main',
    frame: 30,
  });
  expect(
    app.service.snapshot.sequences[0].tracks
      .flatMap((track) => track.clips)
      .find((clip) => clip.id === placed.clipId)!.duration,
  ).toBe(360);
});
it('previews a silent sequence without invoking an unavailable media runtime', async () => {
  const original = process.env.VMOTION_FFMPEG;
  process.env.VMOTION_FFMPEG = 'vmotion-missing-ffmpeg-for-silence';
  try {
    const range = await app.audioPreview.range(app.service.snapshot, { sampleCount: 24000 });
    expect(range.clipCount).toBe(0);
    expect(range.buffer.length).toBe(192000);
    expect(audioMetrics(range.buffer).peak).toBe(0);
  } finally {
    if (original === undefined) delete process.env.VMOTION_FFMPEG;
    else process.env.VMOTION_FFMPEG = original;
  }
});
it.each([1, 1.5, 0.75])(
  'keeps adjacent pieces at speed %s sample-aligned with one continuous mix',
  async (speed) => {
    const asset = await tone('0.2*sin(2*PI*220*t)');
    await app.service.transact([
      {
        type: 'addClip',
        sequenceId: 'main',
        trackId: 'voice',
        clip: clip('tone', asset.id, { duration: 240, fadeIn: 15, fadeOut: 15, speed }) as any,
      },
    ]);
    const whole = await app.audioPreview.range(app.service.snapshot, {
        startSample: 0,
        sampleCount: 384000,
      }),
      second = await app.audioPreview.range(app.service.snapshot, {
        startSample: 192000,
        sampleCount: 192000,
      });
    let error = 0;
    for (let index = 0; index < second.buffer.length; index += 8)
      error += Math.abs(
        second.buffer.readFloatLE(index) - whole.buffer.readFloatLE(192000 * 8 + index),
      );
    expect(error / 192000).toBeLessThan(0.00005);
  },
  30000,
);
