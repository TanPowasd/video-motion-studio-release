import { present, field } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { soundPreset, compileSound, SOUND_RATE } from '../src/core/sound.js';
import { pcmWave } from '../src/media/audio.js';
import { soundRange, audioSourceFile } from '../src/media/sound-source.js';
import { collectAssets, loadProject } from '../src/service/project.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-sound-'));
  await initProject(root, 'sound', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 3,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const document = (id = 'music') => ({
  kind: 'sound',
  version: 1,
  id,
  name: 'music',
  unit: 'seconds',
  duration: 0.5,
  tail: 0.2,
  tracks: [
    {
      id: 'lead',
      instrument: soundPreset('bell'),
      events: [
        { id: 'a', at: 0, duration: 0.25, note: 'A4', velocity: 0.8 },
        { id: 'b', at: 0.25, duration: 0.25, note: 'C5', velocity: 0.8 },
      ],
      effects: [{ type: 'delay', seconds: 0.12, feedback: 0.3, mix: 0.2 }],
    },
  ],
  master: { effects: [{ type: 'limiter', ceilingDb: -2 }] },
});
it('auditions an exact stored candidate, applies score and placement atomically, then undo restores both', async () => {
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('soundPlan', {
      items: [
        {
          assetId: 'music',
          document: document(),
          placement: { trackId: 'score', createTrack: '乐曲', start: 0 },
        },
      ],
    });
  expect(app.service.snapshot.revision).toBe(before);
  const preview = await app.dispatch('soundPreview', {
    planId: present(present(present(plan)).plan).planId,
    assetId: 'music',
    sampleCount: 24000,
    inline: true,
  });
  expect(preview.metrics.rms).toBeGreaterThan(0.005);
  expect(preview.fullMix.peak).toBeLessThanOrEqual(10 ** (-2 / 20) + 1e-5);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid).toBe(true);
  expect(checked.candidateRevision).toBe(plan.candidateRevision);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.project.assets[0].soundSource).toMatch(/^components\/sounds/);
  expect(
    app.service.snapshot.sequences[0].tracks.find((t) => t.id === 'score')!.clips,
  ).toHaveLength(1);
  const accepted = await app.dispatch('soundPreview', {
    assetId: 'music',
    sampleCount: 24000,
    inline: true,
  });
  expect(accepted.data).toBe(preview.data);
  const timeline = await app.dispatch('audioPreview', { sampleCount: 24000, inline: true });
  expect(timeline.data).toBe(accepted.data);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.project.assets).toHaveLength(0);
});
it('keeps random-seek ranges sample-identical including delay/reverb history and rejects stale candidates', async () => {
  const plan = await app.dispatch('soundPlan', {
    items: [{ assetId: 'music', document: document() }],
  });
  await app.dispatch('projectApply', plan.apply);
  const snapshot = app.service.snapshot,
    asset = snapshot.project.assets[0],
    whole = await soundRange(root, snapshot, asset, 0, 33600),
    middle = await soundRange(root, snapshot, asset, 10003, 10555);
  expect(middle.buffer).toEqual(whole.buffer.subarray(10003 * 8, (10003 + 10555) * 8));
  const edit = await app.dispatch('soundPlan', {
    items: [
      {
        assetId: 'music',
        actions: [{ type: 'transformEvents', trackId: 'lead', transpose: 7, quantize: 0.125 }],
      },
    ],
  });
  await app.service.transact([{ type: 'updateProject', patch: { name: 'changed' } }]);
  await expect(
    app.dispatch('soundPreview', {
      planId: present(present(present(edit)).plan).planId,
      assetId: 'music',
    }),
  ).rejects.toThrow('base changed');
});
it('validates stable event edits and bus conflicts without modifying the accepted resource', async () => {
  const plan = await app.dispatch('soundPlan', {
    items: [{ assetId: 'music', document: document() }],
  });
  await app.dispatch('projectApply', plan.apply);
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('soundPlan', {
      items: [
        {
          assetId: 'music',
          actions: [
            {
              type: 'settings',
              patch: {
                buses: [
                  { id: 'a', busId: 'b' },
                  { id: 'b', busId: 'a' },
                ],
              },
            },
          ],
        },
      ],
    }),
  ).rejects.toThrow('cycle');
  expect(app.service.snapshot.revision).toBe(before);
  const edit = await app.dispatch('soundPlan', {
    items: [
      {
        assetId: 'music',
        actions: [
          { type: 'removeEvents', trackId: 'lead', eventIds: ['b'] },
          {
            type: 'transformEvents',
            trackId: 'lead',
            duplicate: true,
            offset: 0.25,
            transpose: 12,
          },
        ],
      },
    ],
  });
  await app.dispatch('projectApply', edit.apply);
  const info = await app.dispatch('soundInspect', { assetId: 'music', limit: 1 });
  expect(info.events.total).toBe(2);
  expect(info.events.hasMore).toBe(true);
  expect(info.events.items[0].note).toBe(69);
});
it('processes long disk-paged sample windows, pins changes and packs editable scores with sample media', async () => {
  const count = 31 * SOUND_RATE,
    pcm = Buffer.alloc(count * 8);
  for (let i = 0; i < count; i++) {
    const v = 0.2 * Math.sin((2 * Math.PI * 440 * i) / SOUND_RATE);
    pcm.writeFloatLE(v, i * 8);
    pcm.writeFloatLE(v, i * 8 + 4);
  }
  const file = path.join(root, 'sample.wav');
  await writeFile(file, pcmWave(pcm));
  await app.dispatch('import', { path: file, type: 'audio', copy: true });
  const sample = app.service.snapshot.project.assets[0];
  const raw = {
    ...document(),
    tracks: [
      {
        id: 'sample',
        instrument: {
          type: 'sample',
          assetId: sample.id,
          sourceDuration: 31,
          rootNote: 'A4',
          gain: 0.5,
        },
        events: [{ id: 'a', at: 0, duration: 0.5, note: 'A4' }],
        effects: [{ type: 'filter', mode: 'lowpass', frequency: 2000 }],
      },
    ],
  };
  const plan = await app.dispatch('soundPlan', { items: [{ assetId: 'music', document: raw }] });
  expect(plan.assetChecks).toHaveLength(1);
  const preview = await app.dispatch('soundPreview', {
    planId: present(present(present(plan)).plan).planId,
    assetId: 'music',
  });
  expect(preview.metrics.rms).toBeGreaterThan(0.03);
  await app.dispatch('projectApply', plan.apply);
  const snapshot = app.service.snapshot,
    asset = snapshot.project.assets.find((a) => a.id === 'music')!,
    fileA = await audioSourceFile(root, snapshot, asset),
    packed = path.join(root, 'packed');
  await collectAssets(root, packed, snapshot);
  const copy = await loadProject(packed),
    fileB = await audioSourceFile(
      packed,
      copy,
      copy.project.assets.find((a) => a.id === 'music')!,
    );
  expect(await readFile(fileB)).toEqual(await readFile(fileA));
  const edit = await app.dispatch('soundPlan', {
    items: [{ assetId: 'music', actions: [{ type: 'settings', patch: { name: 'next' } }] }],
  });
  await writeFile(path.resolve(root, sample.path), pcmWave(Buffer.alloc(48000 * 8)));
  await expect(app.dispatch('projectApply', edit.apply)).rejects.toThrow('no project changes');
});
it('exports editable MIDI and imports it into a separate candidate without touching original source', async () => {
  const plan = await app.dispatch('soundPlan', {
    items: [{ assetId: 'music', document: document() }],
  });
  await app.dispatch('projectApply', plan.apply);
  const midi = path.join(root, 'music.mid'),
    exported = await app.dispatch('soundMidi', {
      action: 'export',
      assetId: 'music',
      output: midi,
    });
  expect(present(present(present(exported)).warnings).length).toBeGreaterThan(0);
  const imported = await app.dispatch('soundMidi', {
    action: 'import',
    assetId: 'copy',
    input: midi,
  });
  expect(present(field(imported, 'midi')).notes).toBe(2);
  expect(app.service.snapshot.project.assets).toHaveLength(1);
  await app.dispatch('projectApply', field(imported, 'apply'));
  expect(app.service.snapshot.project.assets).toHaveLength(2);
});
