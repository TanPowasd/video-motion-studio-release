import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode, sceneSchema } from '../src/core/model.js';
import { sceneTransition, transitionStyles } from '../src/sdk/transitions.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-transitions-'));
  await initProject(root, 'transitions', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        background: 'transparent',
        nodes: [
          newNode({
            id: 'a',
            type: 'rect',
            width: 320,
            height: 180,
            fill: '#ff0000',
            opacity: 0.5,
          }),
        ],
      },
    },
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'other',
        name: 'B',
        duration: 60,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'b',
            type: 'rect',
            width: 320,
            height: 180,
            fill: '#0000ff',
            opacity: 0.25,
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
it('uses isolated premultiplied additive crossfade and exact endpoints for every transition style', async () => {
  const render = async (style: (typeof transitionStyles)[number], p: number) => {
    const snapshot = structuredClone(app.service.snapshot),
      scene = sceneSchema.parse({
        id: 'test',
        name: 'test',
        duration: 60,
        background: 'transparent',
        nodes: sceneTransition({
          id: 'mix',
          fromSceneId: 'intro',
          toSceneId: 'other',
          style,
          progress: p,
          width: 320,
          height: 180,
        }),
      });
    snapshot.scenes.push(scene);
    const canvas = await app.renderer.render(snapshot, 0, {
      sceneId: 'test',
      width: 320,
      height: 180,
    });
    try {
      return [...canvas.getContext('2d').getImageData(100, 80, 1, 1).data];
    } finally {
      canvas.width = 1;
    }
  };
  const middle = await render('crossfade', 0.5);
  expect(middle[0]).toBeCloseTo(170, -1);
  expect(middle[2]).toBeCloseTo(85, -1);
  expect(middle[3]).toBeCloseTo(96, 0);
  const original = async (sceneId: string) => {
    const canvas = await app.renderer.render(app.service.snapshot, 0, {
      sceneId,
      width: 320,
      height: 180,
    });
    try {
      return [...canvas.getContext('2d').getImageData(100, 80, 1, 1).data];
    } finally {
      canvas.width = 1;
    }
  };
  const from = await original('intro'),
    to = await original('other');
  for (const style of transitionStyles) {
    expect(await render(style, 0)).toEqual(from);
    expect(await render(style, 1)).toEqual(to);
  }
});
it('plans multiple reusable scene transitions, declares references and shares candidate render/placement undo', async () => {
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('transitionPlan', {
      items: [
        {
          sceneId: 'wipe',
          fromSceneId: 'intro',
          toSceneId: 'other',
          style: 'wipe',
          duration: 30,
          placement: { trackId: 'visual', at: 30 },
        },
        { sceneId: 'iris', fromSceneId: 'intro', toSceneId: 'other', style: 'iris', duration: 20 },
      ],
    });
  expect(app.service.snapshot.revision).toBe(before);
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(
    app.service.snapshot.scenes.find((s) => s.id === 'wipe')!.nodes[0].sceneDependencies,
  ).toEqual(['intro', 'other']);
  const profile = await app.dispatch('renderProfile', {
    sceneId: 'iris',
    frames: [0, 10, 19],
    width: 320,
    repeat: 2,
  });
  expect(profile.determinism.mismatchFrames).toEqual([]);
  expect(profile.cache.surfaces.reuses).toBeGreaterThan(0);
  expect(profile.cache.components.compiles).toBe(1);
  expect(profile.summary.warmMeanMs).toBeGreaterThan(0);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files[plan.scenes[0].source]).toBeUndefined();
});
it('profiles accurate candidates without mutating the project and refuses stale requests', async () => {
  const before = app.service.snapshot.revision,
    plan = await app.dispatch('transitionPlan', {
      items: [
        { sceneId: 'move', fromSceneId: 'intro', toSceneId: 'other', style: 'push', duration: 20 },
      ],
    });
  const profile = await app.dispatch('renderProfile', {
    planId: plan.plan.planId,
    revision: before,
    sceneId: 'move',
    frames: [0, 19],
    width: 320,
    repeat: 2,
    encode: true,
  });
  expect(profile.revision).toBe(plan.candidateRevision);
  expect(profile.summary.meanEncodeMs).toBeGreaterThan(0);
  expect(app.service.snapshot.revision).toBe(before);
  await app.service.transact([{ type: 'updateProject', patch: { name: 'changed' } }]);
  await expect(app.dispatch('renderProfile', { planId: plan.plan.planId })).rejects.toThrow(
    'base changed',
  );
});
it('reports genuinely stateful components instead of hiding nondeterminism with a frame cache', async () => {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/state.ts',
      content:
        "import {defineComponent,rect} from '@vmotion/sdk';let count=0;export default defineComponent({name:'stateful',parameters:{},render(){return [rect('r',{x:count++*20,y:20,width:10,height:10})]}});",
    },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'state',
            type: 'component',
            component: 'components/state.ts',
            width: 320,
            height: 180,
          }),
        ],
      },
    },
  ]);
  const profile = await app.dispatch('renderProfile', {
    sceneId: 'intro',
    frames: [0],
    repeat: 2,
    width: 320,
  });
  expect(profile.determinism.mismatchFrames).toEqual([0]);
});
