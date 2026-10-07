import { field, present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode, sceneSchema } from '../src/core/model.js';
import { storyboardBoundary } from '../src/core/storyboard.js';
import {
  sequenceSourcesAt,
  sequenceSampleCandidates,
  stratifiedFrames,
} from '../src/core/sequence-inspection.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-storyboard-'));
  await initProject(root, 'board', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 4,
  });
  app = await new Application(root).open(false);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        duration: 120,
        nodes: [
          newNode({
            id: 'heading',
            type: 'text',
            text: '完整镜头',
            x: 20,
            y: 20,
            width: 240,
            height: 40,
            fontSize: 22,
            fill: '#eeeeff',
          }),
        ],
      },
    },
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'other',
        name: 'other',
        duration: 120,
        nodes: [
          newNode({
            id: 'shape',
            type: 'rect',
            x: 30,
            y: 70,
            width: 140,
            height: 40,
            fill: '#88aadd',
          }),
        ],
      }),
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const clear = () => ({
  type: 'updateSequence',
  sequenceId: 'main',
  patch: { tracks: app.service.snapshot.sequences[0].tracks.map((t) => ({ ...t, clips: [] })) },
});
it('assembles chapters and stable shot IDs with cumulative rational frame boundaries and one exact undo', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { fps: { num: 30000, den: 1001 } } },
  ]);
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('storyboardPlan', {
      videoTrackId: 'visual',
      operations: [clear()],
      document: {
        kind: 'storyboard',
        version: 1,
        id: 'science',
        name: '分镜',
        unit: 'seconds',
        chapters: [
          { id: 'first', name: '第一章' },
          { id: 'second', name: '第二章' },
        ],
        shots: Array.from({ length: 10 }, (_, i) => ({
          id: `shot-${i}`,
          name: `镜头 ${i}`,
          chapterId: i < 5 ? 'first' : 'second',
          source: { type: 'scene', id: i % 2 ? 'other' : 'intro' },
          duration: 0.15,
        })),
      },
    });
  expect(app.service.snapshot.revision).toBe(before);
  expect(plan.shots[9].end).toBe(45);
  expect(plan.shots.map((s: any) => s.duration)).toContain(4);
  expect(plan.shots.map((s: any) => s.duration)).toContain(5);
  expect(plan.chapters).toHaveLength(2);
  const check = await app.dispatch('projectPreflight', plan.candidate);
  expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const clips = app.service.snapshot.sequences[0].tracks[0].clips;
  expect(clips[0].id).toBe('sb/science/shot-0/visual');
  expect(clips[9].start + clips[9].duration).toBe(
    storyboardBoundary(1.5, 'seconds', { num: 30000, den: 1001 }),
  );
  const page = await app.dispatch('storyboardInspect', {
    source: plan.source,
    offset: 5,
    limit: 2,
  });
  expect(page.shots.items[0].id).toBe('shot-5');
  expect(page.placements).toHaveLength(2);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
it('updates/reorders only owned generated clips, preserves manual content, and rejects overlap or locks', async () => {
  const document = {
    kind: 'storyboard',
    version: 1,
    id: 'board',
    name: 'board',
    start: 60,
    shots: [
      { id: 'a', name: 'A', source: { type: 'scene', id: 'intro' }, duration: 15 },
      { id: 'b', name: 'B', source: { type: 'scene', id: 'other' }, duration: 15 },
    ],
  };
  await expect(
    app.dispatch('storyboardPlan', { videoTrackId: 'visual', document }),
  ).rejects.toThrow('overlaps');
  const plan = await app.dispatch('storyboardPlan', {
    videoTrackId: 'visual',
    operations: [
      {
        type: 'updateClip',
        sequenceId: 'main',
        trackId: 'visual',
        clipId: 'intro-clip',
        patch: { duration: 30 },
      },
    ],
    document,
  });
  await app.dispatch('projectApply', plan.apply);
  const inspect = await app.dispatch('storyboardInspect', { source: plan.source }),
    edit = await app.dispatch('storyboardPlan', {
      source: plan.source,
      expectedHash: inspect.hash,
      videoTrackId: 'visual',
      actions: [{ type: 'order', shotIds: ['b', 'a'] }],
    });
  await app.dispatch('projectApply', edit.apply);
  const clips = app.service.snapshot.sequences[0].tracks[0].clips;
  expect(clips.find((c) => c.id === 'intro-clip')!.duration).toBe(30);
  expect(clips.find((c) => c.id === 'sb/board/b/visual')!.start).toBe(60);
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        tracks: app.service.snapshot.sequences[0].tracks.map((t) => ({ ...t, locked: true })),
      },
    },
  ]);
  await expect(
    app.dispatch('storyboardPlan', { source: plan.source, videoTrackId: 'visual' }),
  ).rejects.toThrow('locked');
});
it('audits structural errors and sampled source objects with exact candidate revisions and explicit coverage', async () => {
  const plan = await app.dispatch('storyboardPlan', {
      videoTrackId: 'visual',
      operations: [clear()],
      document: {
        kind: 'storyboard',
        version: 1,
        id: 'short',
        name: 'short',
        shots: [
          { id: 'a', name: 'A', source: { type: 'scene', id: 'intro' }, duration: 30 },
          { id: 'b', name: 'B', source: { type: 'scene', id: 'other' }, duration: 30 },
        ],
      },
    }),
    before = app.service.snapshot.revision,
    audit = await app.dispatch('sequenceAudit', {
      planId: plan.plan.planId,
      maxFrames: 6,
      images: true,
      width: 160,
    });
  expect(audit.revision).toBe(plan.candidateRevision);
  expect(audit.coverage.sampledFrames).toBe(6);
  expect(audit.coverage.omittedFrames).toBeGreaterThan(0);
  expect(audit.coverage.fullFrameCoverage).toBe(false);
  expect(audit.output).toMatch(/\.png$/);
  expect(app.service.snapshot.revision).toBe(before);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'bad-text',
            type: 'text',
            text: '这段文字高度被裁切\n第二行也需要显示',
            x: 20,
            y: 10,
            width: 200,
            height: 5,
            fontSize: 28,
          }),
        ],
      },
    },
    {
      type: 'updateClip',
      sequenceId: 'main',
      trackId: 'visual',
      clipId: 'intro-clip',
      patch: { duration: 180 },
    },
  ]);
  const failed = await app.dispatch('sequenceAudit', { frames: [0, 119], images: false });
  expect(failed.findings.some((f: any) => f.code === 'CLIP_OUTSIDE_SEQUENCE')).toBe(true);
  expect(
    failed.findings.some(
      (f: any) => f.code === 'TEXT_TRUNCATED' && f.locator.nodeId === 'bad-text',
    ),
  ).toBe(true);
});
it('uses nested source clocks/fades and samples the whole timeline rather than only early cuts', () => {
  const snapshot = structuredClone(app.service.snapshot);
  snapshot.sequences[0].tracks[0].clips = [
    {
      id: 'nested',
      sequenceId: 'child',
      start: 30,
      duration: 60,
      sourceIn: 10,
      speed: 0.5,
      volume: 1,
      fadeIn: 10,
      fadeOut: 0,
    },
  ];
  snapshot.sequences.push({
    id: 'child',
    name: 'child',
    duration: 120,
    tracks: [
      {
        id: 'v',
        name: 'v',
        type: 'video',
        muted: false,
        clips: [
          {
            id: 'inner',
            sceneId: 'other',
            start: 0,
            duration: 120,
            sourceIn: 2,
            speed: 2,
            volume: 1,
            fadeIn: 0,
            fadeOut: 0,
          },
        ],
      },
    ],
    markers: [],
  });
  const source = sequenceSourcesAt(snapshot, 'main', 35)[0];
  expect(source.frame).toBe(27);
  expect(source.opacity).toBe(0.5);
  const proposed = sequenceSampleCandidates(snapshot, 'main'),
    selected = stratifiedFrames(proposed, 4);
  expect(selected[0].frame).toBe(0);
  expect(selected[3].frame).toBe(119);
});
it('binds newly authored sound narration and storyboard clips in one candidate with source hash checks', async () => {
  const before = app.service.snapshot.revision,
    sound = await app.dispatch('soundPlan', {
      delivery: 'inline',
      items: [
        {
          assetId: 'draft-voice',
          document: {
            kind: 'sound',
            version: 1,
            id: 'draft-voice',
            name: '声音草稿',
            unit: 'seconds',
            duration: 0.5,
            tail: 0,
            tracks: [
              {
                id: 'tone',
                instrument: { type: 'synth' },
                events: [{ id: 'a', at: 0, duration: 0.5, note: 69 }],
              },
            ],
          },
        },
      ],
    });
  const plan = await app.dispatch('storyboardPlan', {
    videoTrackId: 'visual',
    audioTrackId: 'voice',
    operations: [...present(field(sound.candidate, 'operations')), clear()],
    document: {
      kind: 'storyboard',
      version: 1,
      id: 'spoken',
      name: '绑定草稿',
      shots: [
        {
          id: 'a',
          name: '镜头',
          source: { type: 'scene', id: 'intro' },
          duration: 30,
          narration: [{ id: 'line', assetId: 'draft-voice' }],
        },
      ],
    },
  });
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  const preview = await app.dispatch('audioPreview', {
    planId: plan.plan.planId,
    sampleCount: 24000,
  });
  expect(preview.metrics.rms).toBeGreaterThan(0);
  await app.dispatch('projectApply', plan.apply);
  const clips = app.service.snapshot.sequences[0].tracks.flatMap((t) => t.clips);
  expect(clips.find((c) => c.id === 'sb/spoken/a/audio-line')!.linkedGroup).toBe('sb/spoken/a');
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
});
