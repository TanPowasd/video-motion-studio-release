import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-mix-service-'));
  await initProject(root, 'mixed', { template: 'blank', durationSeconds: 4 });
  app = await new Application(root).open(false);
  const file = path.join(root, 'source.wav');
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
  await app.dispatch('assetPlace', {
    assetId: app.service.snapshot.project.assets[0].id,
    sequenceId: 'main',
    trackId: 'voice',
    frame: 0,
  });
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('auditions and audits an exact normalization candidate, applies once and undoes configuration', async () => {
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('audioMixPlan', {
      items: [
        {
          sequenceId: 'main',
          actions: [
            {
              type: 'master',
              patch: {
                normalization: { targetLufs: -16, truePeakDb: -1, targetLra: 11, mode: 'auto' },
              },
            },
          ],
        },
      ],
    });
  const preview = await app.dispatch('audioPreview', {
      planId: present(present(present(plan)).plan).planId,
      sampleCount: 48000,
      inline: true,
    }),
    audit = await app.dispatch('audioAudit', {
      planId: present(present(present(plan)).plan).planId,
    });
  expect(audit.passed).toBe(true);
  expect(audit.coverage.wholeSource).toBe(true);
  expect(audit.revision).toBe(plan.candidateRevision);
  expect(app.service.snapshot.revision).toBe(before);
  await app.dispatch('projectApply', plan.apply);
  expect((await app.dispatch('audioPreview', { sampleCount: 48000, inline: true })).data).toBe(
    preview.data,
  );
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
it('rejects missing bus/sidechain feedback and direct locked-track edits without saving', async () => {
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('audioMixPlan', {
      items: [
        {
          sequenceId: 'main',
          actions: [
            {
              type: 'track',
              trackId: 'voice',
              patch: { busId: 'room', ducking: { source: { type: 'bus', id: 'room' } } },
            },
            { type: 'bus', bus: { id: 'room' } },
          ],
        },
      ],
    }),
  ).rejects.toThrow('cycle');
  expect(app.service.snapshot.revision).toBe(before);
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: app.service.snapshot.sequences[0].tracks.map((t) =>
          t.id === 'voice' ? { ...t, locked: true } : t,
        ),
      },
    },
  ]);
  await expect(
    app.dispatch('audioMixPlan', {
      items: [
        {
          sequenceId: 'main',
          actions: [{ type: 'track', trackId: 'voice', patch: { gainDb: -5 } }],
        },
      ],
    }),
  ).rejects.toThrow('locked');
});
