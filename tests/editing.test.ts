import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { newNode, sequenceSchema, type Snapshot, type Clip } from '../src/core/model.js';
import { editSequence } from '../src/core/editing.js';
import { clipGain } from '../src/core/clip-window.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { mixAudioSamples } from '../src/media/audio.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-editing-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const clip = (id: string, start: number, duration: number, extra: Partial<Clip> = {}) => ({
  id,
  sceneId: 'intro',
  start,
  duration,
  sourceIn: 0,
  speed: 1,
  volume: 1,
  fadeIn: 0,
  fadeOut: 0,
  ...extra,
});
const sequence = () =>
  sequenceSchema.parse({
    id: 'main',
    name: 'Edit',
    duration: 120,
    tracks: [
      {
        id: 'v',
        name: 'Video',
        type: 'video',
        muted: false,
        clips: [clip('a', 0, 60), clip('b', 60, 60)],
      },
    ],
    markers: [{ id: 'm', frame: 80, label: 'marker' }],
  });
it('splits fractional-rate sources without resetting fade windows and leaves input unchanged', () => {
  const input = sequence();
  input.tracks[0].clips[0].speed = 1.5;
  input.tracks[0].clips[0].fadeIn = 30;
  input.tracks[0].clips[0].fadeOut = 30;
  const edited = editSequence(app.service.snapshot, input, [
    { type: 'split', clipIds: ['a'], frame: 15 },
  ]);
  const [left, right] = edited.sequence.tracks[0].clips;
  expect(left.duration).toBe(15);
  expect(right.sourceIn).toBe(22.5);
  expect(right.duration).toBe(45);
  expect(clipGain(right, 0)).toBeCloseTo(clipGain(input.tracks[0].clips[0], 15));
  expect(clipGain(left, 14)).toBeCloseTo(clipGain(input.tracks[0].clips[0], 14));
  expect(input.tracks[0].clips).toHaveLength(2);
});
it('linked split parts form independent groups so deleting the right side keeps the left side', () => {
  const input = sequence();
  input.tracks[0].clips[0].linkedGroup = 'av';
  input.tracks.push({
    id: 'audio',
    name: 'Audio',
    type: 'audio',
    muted: false,
    clips: [clip('sound', 0, 60, { linkedGroup: 'av' })],
  });
  const split = editSequence(app.service.snapshot, input, [
      { type: 'split', clipIds: ['a'], frame: 30 },
    ]),
    right = split.sequence.tracks[0].clips[1];
  expect(right.linkedGroup).not.toBe('av');
  expect(split.sequence.tracks[1].clips[1].linkedGroup).toBe(right.linkedGroup);
  const removed = editSequence(app.service.snapshot, split.sequence, [
    { type: 'remove', clipIds: [right.id] },
  ]);
  expect(removed.sequence.tracks[0].clips.map((c) => c.id)).toEqual(['a', 'b']);
  expect(removed.sequence.tracks[1].clips.map((c) => c.id)).toEqual(['sound']);
});
it('ripple deletion removes time across tracks, trims crossing audio and moves markers and work area', () => {
  const input = sequence();
  input.tracks.push({
    id: 'audio',
    name: 'Audio',
    type: 'audio',
    muted: false,
    clips: [clip('bed', 0, 120)],
  });
  input.workArea = { start: 20, end: 100 };
  const edited = editSequence(app.service.snapshot, input, [
    { type: 'deleteRange', start: 30, end: 60 },
  ]);
  expect(edited.sequence.duration).toBe(90);
  expect(
    edited.sequence.tracks[0].clips.map((c) => ({ start: c.start, duration: c.duration })),
  ).toEqual([
    { start: 0, duration: 30 },
    { start: 30, duration: 60 },
  ]);
  expect(edited.sequence.tracks[1].clips).toHaveLength(2);
  expect(edited.sequence.tracks[1].clips[1].sourceIn).toBe(60);
  expect(edited.sequence.markers[0].frame).toBe(50);
  expect(edited.sequence.workArea).toEqual({ start: 20, end: 70 });
});
it('locked tracks and source handles reject edits atomically', () => {
  const input = sequence();
  input.tracks[0].locked = true;
  expect(() =>
    editSequence(app.service.snapshot, input, [{ type: 'deleteRange', start: 10, end: 20 }]),
  ).toThrow('Unlock');
  expect(input.duration).toBe(120);
  input.tracks[0].locked = false;
  expect(() =>
    editSequence(app.service.snapshot, input, [{ type: 'slip', clipIds: ['a'], delta: -1 }]),
  ).toThrow('source');
});
it('beat markers use rational FPS positions without accumulated rounding drift and replace their group', () => {
  const input = sequence();
  const snapshot = {
    ...app.service.snapshot,
    project: { ...app.service.snapshot.project, fps: { num: 30000, den: 1001 } },
  } as Snapshot;
  const edited = editSequence(snapshot, input, [
    { type: 'workflow', mode: 'remix' },
    { type: 'beatGrid', bpm: 120, start: 0, end: 120 },
    { type: 'beatGrid', bpm: 120, start: 0, end: 120 },
  ]);
  const beats = edited.sequence.markers.filter((m) => m.kind === 'beat');
  expect(beats.map((m) => m.frame)).toEqual([0, 15, 30, 45, 60, 75, 90, 105]);
  expect(edited.sequence.workflow).toBe('remix');
});
it('timeline commands are revision checked and undo the whole edit batch', async () => {
  await app.service.transact([{ type: 'updateSequence', sequenceId: 'main', patch: sequence() }]);
  const before = app.service.snapshot.revision;
  await app.dispatch('sequenceEdit', {
    sequenceId: 'main',
    revision: before,
    actions: [
      { type: 'split', clipIds: ['a'], frame: 20 },
      { type: 'rangeIn', frame: 10 },
      { type: 'rangeOut', frame: 49 },
    ],
  });
  expect(app.service.snapshot.sequences[0].tracks[0].clips).toHaveLength(3);
  expect(app.service.snapshot.sequences[0].workArea).toEqual({ start: 10, end: 50 });
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  await expect(
    app.dispatch('sequenceEdit', {
      sequenceId: 'main',
      revision: 'stale',
      actions: [{ type: 'split', clipIds: ['a'], frame: 20 }],
    }),
  ).rejects.toThrow();
}, 30000);
it('native frame output is unchanged by a split inside a fade at fractional speed', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        duration: 180,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'box',
            type: 'rect',
            x: 0,
            y: 30,
            width: 50,
            height: 50,
            fill: '#fff',
            animations: [
              {
                property: 'x',
                keys: [
                  { frame: 0, value: 0, easing: 'linear' },
                  { frame: 179, value: 180, easing: 'linear' },
                ],
              },
            ],
          }),
        ],
      },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        ...sequence(),
        tracks: [
          {
            id: 'v',
            name: 'Video',
            type: 'video',
            muted: false,
            clips: [clip('a', 0, 60, { speed: 1.5, fadeIn: 30, fadeOut: 30 })],
          },
        ],
      },
    },
  ]);
  const frames = [0, 14, 15, 30, 59],
    before = await Promise.all(frames.map(async (frame) => (await app.frame({ frame })).buffer));
  await app.dispatch('sequenceEdit', {
    sequenceId: 'main',
    actions: [{ type: 'split', clipIds: ['a'], frame: 15 }],
  });
  for (const [i, frame] of frames.entries())
    expect((await app.frame({ frame })).buffer.equals(before[i])).toBe(true);
}, 30000);
it.each([1, 1.5, 0.75])(
  'audio samples remain continuous and identical when splitting inside a fade at speed %s',
  async (speed) => {
    const file = path.join(root, 'tone.wav');
    await runProcess(ffmpegBinary(), [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'sine=frequency=317:sample_rate=48000:duration=4',
      file,
    ]);
    await app.dispatch('import', { path: file, type: 'audio' });
    const asset = app.service.snapshot.project.assets.find((a) => a.type === 'audio')!;
    await app.service.transact([
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          ...sequence(),
          duration: 60,
          tracks: [
            {
              id: 'audio',
              name: 'Audio',
              type: 'audio',
              muted: false,
              clips: [
                {
                  ...clip('a', 0, 60, { speed, fadeIn: 30, fadeOut: 30 }),
                  sceneId: undefined,
                  assetId: asset.id,
                },
              ],
            },
          ],
        },
      },
    ]);
    const before = await mixAudioSamples(root, app.service.snapshot, 0, 48000 * 2, 'main');
    await app.dispatch('sequenceEdit', {
      sequenceId: 'main',
      actions: [{ type: 'split', clipIds: ['a'], frame: 15 }],
    });
    const after = await mixAudioSamples(root, app.service.snapshot, 0, 48000 * 2, 'main');
    let max = 0,
      changed = 0;
    for (let i = 0; i < before.buffer.length; i += 4) {
      const delta = Math.abs(before.buffer.readFloatLE(i) - after.buffer.readFloatLE(i));
      max = Math.max(max, delta);
      if (delta > 1e-6) changed++;
    }
    expect({ max, changed }).toEqual({ max: 0, changed: 0 });
  },
  30000,
);
