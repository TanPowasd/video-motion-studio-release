import { present, field } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, stat, appendFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { ffmpegBinary, runProcess } from '../src/media/ffmpeg.js';
import { clipSchema, sequenceSchema } from '../src/core/model.js';
import { audioClips } from '../src/media/audio.js';
import { loadImage } from '@napi-rs/canvas';
let root: string, app: Application, assetId: string, file: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-agent-media-'));
  await initProject(root);
  file = path.join(root, 'source.mp4');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=160x90:rate=30:duration=2',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:v',
    'mpeg4',
    '-c:a',
    'aac',
    '-shortest',
    file,
  ]);
  app = await new Application(root).open(false);
  const imported = await app.dispatch('import', { path: file, type: 'video', copy: false });
  assetId = present(present(present(imported)).snapshot.project.assets.at(-1)).id;
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: sequenceSchema.parse({
        id: 'main',
        name: 'Assembly',
        duration: 60,
        tracks: [
          { id: 'v', name: 'Video', type: 'video', clips: [] },
          { id: 'a', name: 'Audio', type: 'audio', clips: [] },
        ],
      }),
    },
  ]);
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
const item = (patch: Record<string, unknown> = {}) => ({
  source: { type: 'asset', id: assetId },
  trackId: 'v',
  sourceIn: 0,
  sourceOut: 30,
  ...patch,
});
const setupLinked = async () => {
  const video = clipSchema.parse({
    id: 'original-v',
    assetId,
    start: 0,
    duration: 60,
    sourceOut: 60,
    linkedGroup: 'av',
    audioEnabled: false,
    fadeIn: 20,
    fadeOut: 15,
  });
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: [
          { id: 'v', name: 'Video', type: 'video', muted: false, clips: [video] },
          {
            id: 'a',
            name: 'Audio',
            type: 'audio',
            muted: false,
            clips: [{ ...video, id: 'original-a', audioEnabled: true }],
          },
        ],
        markers: [{ id: 'marker', frame: 35, label: 'Keep sync' }],
        workArea: { start: 30, end: 60 },
      },
    },
  ]);
};
it('samples actual source frames with evidence, without modifying history or racing preview', async () => {
  const revision = app.service.snapshot.revision,
    undo = app.service.state().canUndo;
  const [sample, preview] = await Promise.all([
    app.dispatch('mediaSample', { assetId, frames: [40, 0, 15], width: 160, inline: true }),
    app.frame({ sceneId: 'intro', frame: 30, width: 160, height: 90 }),
  ]);
  expect(sample.sourceEnd).toBeCloseTo(60);
  expect(sample.metadata.hasAudio).toBe(true);
  expect(sample.samples.map((s: any) => s.frame)).toEqual([40, 0, 15]);
  expect(new Set(sample.samples.map((s: any) => s.pixelHash)).size).toBe(3);
  expect((await loadImage(Buffer.from(present(sample.data), 'base64'))).width).toBe(480);
  expect((await stat(sample.output)).size).toBeGreaterThan(100);
  expect(preview.stale).toBe(false);
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.state().canUndo).toBe(undo);
  await expect(app.dispatch('mediaSample', { assetId, frames: [60] })).rejects.toThrow('sourceEnd');
}, 30000);
it('plans fractional source boundaries, preflights and commits exact IDs once, then undoes the batch', async () => {
  const revision = app.service.snapshot.revision,
    source = await app.dispatch('mediaInspect', { assetId });
  const plan = await app.dispatch('sequencePlan', {
    revision,
    assetChecks: [source.assetCheck],
    items: [item({ sourceOut: 25.1, speed: 1.5, audioTrackId: 'a' })],
  });
  expect(app.service.snapshot.revision).toBe(revision);
  const [video, audio] = present(
    field(present(field(plan.candidate.operations[0], 'patch')), 'tracks'),
  ).map((t) => t.clips[0]);
  expect(video.duration).toBe(17);
  expect(video.sourceOut).toBe(25.1);
  expect(video.audioEnabled).toBe(false);
  expect(audio.audioEnabled).toBe(true);
  expect(video.linkedGroup).toBe(audio.linkedGroup);
  expect(plan.apply.expectedCandidateRevision).toBe(plan.candidateRevision);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  expect(checked.candidateRevision).toBe(plan.candidateRevision);
  const applied = await app.dispatch('projectApply', plan.apply);
  expect(applied.revision).toBe(plan.candidateRevision);
  expect(field(applied, 'snapshot')).toBeUndefined();
  const sound = audioClips(app.service.snapshot);
  expect(sound).toHaveLength(1);
  expect(sound[0].duration).toBeCloseTo(25.1 / 1.5);
  const preview = await app.dispatch('audioPreview', {
    startSample: 0,
    sampleCount: 32000,
    inline: true,
  });
  const wav = Buffer.from(present(preview.data), 'base64');
  // Exclusive sourceOut leaves silence in the fractional final timeline frame.
  for (let i = 30000; i < 32000; i++) expect(wav.readInt16LE(44 + i * 4)).toBe(0);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.sequences[0].tracks[0].clips).toHaveLength(0);
}, 30000);
it('inserts through linked footage while preserving source, fade clocks, markers and range', async () => {
  await setupLinked();
  const before = await app.frame({ frame: 35, width: 160, height: 90 });
  const plan = await app.dispatch('sequencePlan', {
    items: [item({ mode: 'insert', at: 30, sourceIn: 6, sourceOut: 12, audioTrackId: 'a' })],
  });
  await app.dispatch('projectApply', plan.apply);
  const sequence = app.service.snapshot.sequences[0],
    v = sequence.tracks[0].clips.at(-1)!,
    a = sequence.tracks[1].clips.at(-1)!;
  expect(sequence.duration).toBe(66);
  expect(sequence.markers[0].frame).toBe(41);
  expect(sequence.workArea).toEqual({ start: 36, end: 66 });
  expect(v.start).toBe(36);
  expect(v.sourceIn).toBe(30);
  expect(v.fadeWindow).toEqual({ offset: 30, duration: 60 });
  expect(v.linkedGroup).toBe(a.linkedGroup);
  expect(v.linkedGroup).not.toBe('av');
  expect(
    (await app.frame({ frame: 41, width: 160, height: 90 })).buffer.equals(before.buffer),
  ).toBe(true);
}, 30000);
it('blocks partial linked overwrites and locked-track inserts; preserves both sides of an AV overwrite', async () => {
  await setupLinked();
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('sequencePlan', { items: [item({ mode: 'overwrite', at: 20, sourceOut: 10 })] }),
  ).rejects.toThrow('linked partner');
  expect(app.service.snapshot.revision).toBe(revision);
  const plan = await app.dispatch('sequencePlan', {
    items: [item({ mode: 'overwrite', at: 20, sourceOut: 10, audioTrackId: 'a' })],
  });
  const tracks = field(present(field(plan.candidate.operations[0], 'patch')), 'tracks');
  expect(present(tracks)[0].clips.map((c: any) => [c.start, c.duration, c.sourceIn])).toEqual([
    [0, 20, 0],
    [20, 10, 0],
    [30, 30, 30],
  ]);
  expect(present(tracks)[0].clips[2].linkedGroup).toBe(present(tracks)[1].clips[2].linkedGroup);
  expect(present(tracks)[0].clips[2].linkedGroup).not.toBe(present(tracks)[0].clips[0].linkedGroup);
  await app.dispatch('sequenceEdit', {
    actions: [{ type: 'trackLock', trackId: 'a', locked: true }],
  });
  await expect(
    app.dispatch('sequencePlan', { items: [item({ mode: 'insert', at: 30 })] }),
  ).rejects.toThrow('locked track');
}, 30000);
it('rejects changed source evidence before planning, preflight and apply without saving candidate edits', async () => {
  const source = await app.dispatch('mediaInspect', { assetId }),
    revision = app.service.snapshot.revision,
    plan = await app.dispatch('sequencePlan', { items: [item()] });
  await appendFile(file, Buffer.from([0, 0, 0, 0]));
  await expect(
    app.dispatch('sequencePlan', { assetChecks: [source.assetCheck], items: [item()] }),
  ).rejects.toThrow('changed');
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid).toBe(false);
  expect(checked.diagnostics.some((d: any) => d.code === 'ASSET_CHANGED')).toBe(true);
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toThrow(
    'no project changes saved',
  );
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
it('rechecks media inside the commit queue after asynchronous candidate validation', async () => {
  const plan = await app.dispatch('sequencePlan', { items: [item()] }),
    revision = app.service.snapshot.revision;
  const validator = app.service.extraValidation;
  let changed = false;
  app.service.extraValidation = async (snapshot) => {
    if (!changed && snapshot.revision === plan.candidateRevision) {
      changed = true;
      await appendFile(file, Buffer.from([0]));
    }
    return (await validator?.(snapshot)) ?? [];
  };
  await expect(app.dispatch('projectApply', plan.apply)).rejects.toThrow('changed');
  expect(changed).toBe(true);
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
it('pins freshly probed duration so a reviewed source range is not clamped by stale import metadata', async () => {
  await app.service.transact([
    {
      type: 'updateProject',
      patch: {
        assets: app.service.snapshot.project.assets.map((a) =>
          a.id === assetId ? { ...a, metadata: { ...a.metadata, duration: 0.5 } } : a,
        ),
      },
    },
  ]);
  const plan = await app.dispatch('sequencePlan', {
    items: [item({ sourceIn: 40, sourceOut: 55 })],
  });
  expect(
    plan.apply.operations.some(
      (o: any) =>
        o.type === 'updateProject' &&
        o.patch.assets.some((a: any) => a.id === assetId && a.metadata.duration === 2),
    ),
  ).toBe(true);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.project.assets.find((a) => a.id === assetId)?.metadata.duration).toBe(
    2,
  );
}, 30000);
