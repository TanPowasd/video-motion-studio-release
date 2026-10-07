import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { runProcess, ffmpegBinary, probe } from '../src/media/ffmpeg.js';
import { prepareSequenceMix, sequenceMixReport } from '../src/media/audio-mix-cache.js';
import { mixAudioSamples } from '../src/media/audio.js';
import { measureLoudness } from '../src/media/audio-loudness.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-mix-cache-'));
  await initProject(root, 'mix', { template: 'blank', durationSeconds: 4 });
  app = await new Application(root).open(false);
  const file = path.join(root, 'tone.wav');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.2*sin(2*PI*1000*t):s=48000:d=4',
    '-c:a',
    'pcm_f32le',
    file,
  ]);
  await app.dispatch('import', { path: file, type: 'audio' });
  const asset = app.service.snapshot.project.assets[0];
  await app.service.transact([
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: {
        id: 'tone',
        assetId: asset.id,
        start: 0,
        duration: 120,
        sourceIn: 0,
        speed: 1,
        volume: 1,
        fadeIn: 0,
        fadeOut: 0,
      },
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('shares full-history effects between arbitrary preview ranges and reuses equivalent audio after visual edits', async () => {
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        mix: {
          tracks: {
            voice: { effects: [{ type: 'delay', seconds: 0.08, feedback: 0.3, mix: 0.35 }] },
          },
          master: { effects: [{ type: 'limiter', ceilingDb: -2 }] },
        } as any,
      },
    },
  ]);
  const first = await prepareSequenceMix(root, app.service.snapshot, 'main'),
    full = await mixAudioSamples(root, app.service.snapshot, 0, 192000),
    middle = await mixAudioSamples(root, app.service.snapshot, 25003, 16555);
  expect(middle.buffer).toEqual(full.buffer.subarray(25003 * 8, (25003 + 16555) * 8));
  await app.service.transact([
    { type: 'updateScene', sceneId: 'intro', patch: { name: 'visual changed' } },
  ]);
  expect(await prepareSequenceMix(root, app.service.snapshot, 'main')).toBe(first);
});
it('normalizes the actual mixed output with two passes, verifies loudness/true peak and rejects impossible linear targets', async () => {
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        mix: {
          master: {
            normalization: { targetLufs: -16, targetLra: 11, truePeakDb: -1, mode: 'auto' },
          },
        } as any,
      },
    },
  ]);
  const file = await prepareSequenceMix(root, app.service.snapshot, 'main'),
    report = await sequenceMixReport(file),
    measurement = await measureLoudness(file);
  expect(measurement.measurement.integratedLufs).toBeCloseTo(-16, 0);
  expect(measurement.measurement.truePeakDb!).toBeLessThanOrEqual(-0.8);
  expect(report.normalization.actualMode).toBe('linear');
  expect(Number((await probe(file)).format.duration)).toBe(4);
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        mix: {
          master: {
            normalization: { targetLufs: -5, targetLra: 11, truePeakDb: -9, mode: 'linear' },
          },
        } as any,
      },
    },
  ]);
  await expect(prepareSequenceMix(root, app.service.snapshot, 'main')).rejects.toThrow(
    'Linear gain',
  );
});
it('applies nested child processing before parent gain/fades and preserves cancellation recovery', async () => {
  const snapshot = app.service.snapshot,
    child = structuredClone(snapshot.sequences[0]);
  child.id = 'child';
  child.name = 'nested';
  child.mix = { tracks: { voice: { gainDb: -6 } } } as any;
  await app.service.transact([
    {
      type: 'updateProject',
      patch: { sequences: ['sequences/main.json', 'sequences/child.json'] },
    },
    {
      type: 'editFiles',
      edits: [
        {
          type: 'replace',
          path: 'sequences/child.json',
          content: JSON.stringify(child),
          expectedHash: null,
        },
      ],
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: [
          {
            id: 'nested',
            name: 'nested',
            type: 'audio',
            muted: false,
            clips: [
              {
                id: 'child-use',
                sequenceId: 'child',
                start: 0,
                duration: 120,
                sourceIn: 0,
                speed: 1,
                volume: 0.5,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    },
  ]);
  const result = await mixAudioSamples(root, app.service.snapshot, 0, 48000),
    sample = result.buffer.readFloatLE(12 * 8);
  expect(sample).toBeCloseTo(0.2 * 10 ** (-6 / 20) * 0.5, 5);
  const controller = new AbortController();
  controller.abort();
  await expect(
    prepareSequenceMix(root, app.service.snapshot, 'main', controller.signal),
  ).rejects.toThrow('cancelled');
  expect(
    (await readFile(await prepareSequenceMix(root, app.service.snapshot, 'main'))).length,
  ).toBeGreaterThan(44);
});
