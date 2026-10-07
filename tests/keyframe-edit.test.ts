import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newNode } from '../src/core/model.js';
import { editKeyframes, sampleAnimation } from '../src/core/keyframes.js';
import { evaluateNode, interpolate } from '../src/core/time.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
const layer = () =>
  newNode({
    id: 'a',
    type: 'rect',
    width: 60,
    height: 60,
    animations: [
      {
        property: 'x',
        keys: [
          { frame: 0, value: 10, easing: 'bezier', bezier: [0.2, 0.6, 0.8, 1.2] },
          { frame: 60, value: 110, easing: 'linear' },
        ],
      },
      {
        property: 'y',
        keys: [
          { frame: 0, value: 30, easing: 'linear' },
          { frame: 60, value: 90, easing: 'linear' },
        ],
      },
    ],
  });
it('retimes all selected channels and preserves normalized easing and value relationships', () => {
  const source = layer(),
    edited = editKeyframes(source, [
      { type: 'transform', timeScale: 2, timeOffset: 15, valueScale: 1.5, valueOffset: 7 },
    ]);
  expect(edited.animations[0].keys.map((k) => k.frame)).toEqual([15, 135]);
  expect(edited.animations[0].keys[0].bezier).toEqual([0.2, 0.6, 0.8, 1.2]);
  for (const frame of [0, 12, 30, 45, 60]) {
    const before = evaluateNode(source, frame),
      after = evaluateNode(edited, frame * 2 + 15);
    expect(after.x).toBeCloseTo(before.x * 1.5 + 7, 7);
    expect(after.y).toBeCloseTo(before.y * 1.5 + 7, 7);
  }
  expect(source.animations[0].keys[1].frame).toBe(60);
});
it('copies a range without deleting source keys, rejects collisions and rounding collapse', () => {
  const source = layer(),
    copied = editKeyframes(source, [
      { type: 'transform', properties: ['x'], range: [0, 60], timeOffset: 120, copy: true },
    ]);
  expect(copied.animations[0].keys.map((k) => k.frame)).toEqual([0, 60, 120, 180]);
  expect(copied.animations[1].keys).toHaveLength(2);
  expect(() =>
    editKeyframes(source, [{ type: 'transform', properties: ['x'], frames: [0], timeOffset: 60 }]),
  ).toThrow('collide');
  expect(() => editKeyframes(source, [{ type: 'transform', timeScale: 0.001 }])).toThrow('merged');
  expect(() => editKeyframes(source, [{ type: 'transform', timeOffset: -10 }])).toThrow(
    'nonnegative',
  );
  expect(() =>
    editKeyframes(source, [{ type: 'remove', properties: ['x'], frames: [99] }]),
  ).toThrow('no longer exist');
  const replaced = editKeyframes(source, [
    { type: 'transform', properties: ['x'], frames: [0], timeOffset: 60, collision: 'replace' },
  ]);
  expect(replaced.animations[0].keys).toHaveLength(1);
});
it('batch easing edits selected keys only and removes an empty channel', () => {
  const edited = editKeyframes(layer(), [
    { type: 'ease', properties: ['x'], frames: [0], easing: 'easeOut' },
    { type: 'remove', properties: ['y'] },
  ]);
  expect(edited.animations).toHaveLength(1);
  expect(edited.animations[0].keys[0].easing).toBe('easeOut');
  expect(edited.animations[0].keys[0].bezier).toBeUndefined();
  expect(edited.animations[0].keys[1].easing).toBe('linear');
  expect(() =>
    editKeyframes(layer(), [
      {
        type: 'upsert',
        property: 'x',
        keys: [
          { frame: 10, value: 2 },
          { frame: 10, value: 3 },
        ],
      },
    ]),
  ).toThrow('duplicate');
});
it('reports velocity in units per second using the project fps', () => {
  const samples = sampleAnimation(layer(), [30], 30, ['y']);
  expect(samples[0].values.y).toBe(60);
  expect(samples[0].velocityPerSecond.y).toBeCloseTo(30, 6);
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-keys-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('edits generated and native animations atomically and undo restores both', async () => {
  const source =
    "import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Keys',parameters:{},render(){return [rect('box',{x:0,y:0,width:30,height:30,animations:[{property:'x',keys:[{frame:0,value:0,easing:'linear'},{frame:60,value:60,easing:'linear'}]}]})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/keys.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          layer(),
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/keys.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision;
  await app.dispatch('animationEdit', {
    sceneId: 'intro',
    revision,
    edits: [
      { nodeId: 'a', actions: [{ type: 'transform', timeOffset: 20 }] },
      { nodeId: 'code/box', path: ['code'], actions: [{ type: 'transform', timeScale: 2 }] },
    ],
  });
  expect(app.service.snapshot.scenes[0].nodes[0].animations[0].keys[0].frame).toBe(20);
  expect(app.service.snapshot.scenes[0].nodes[1].overrides.box.animations?.[0].keys[1].frame).toBe(
    120,
  );
  const graph = await app.dispatch('animationInspect', {
    sceneId: 'intro',
    nodeId: 'code/box',
    path: ['code'],
    frames: [30, 60],
    properties: ['x'],
  });
  expect(graph.samples.map((s: any) => s.values.x)).toEqual([15, 30]);
  expect(graph.samples[0].velocityPerSecond.x).toBeCloseTo(15);
  expect(app.service.snapshot.files['components/keys.ts']).toBe(source);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[1].overrides).toEqual({});
}, 30000);
it('materializes component defaults to animate a nested numeric parameter and rejects an invalid batch without writes', async () => {
  const source =
    "import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Data',parameters:{origin:{type:'vec2',default:{x:20,y:30}},style:{type:'object',properties:{size:{type:'number',default:30,min:1,max:100}}}},render(ctx,p){return [rect('b',{x:p.origin.x,y:p.origin.y,width:p.style.size,height:p.style.size})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/data.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'data',
            type: 'component',
            component: 'components/data.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  await app.dispatch('animationEdit', {
    sceneId: 'intro',
    edits: [
      {
        nodeId: 'data',
        actions: [
          {
            type: 'upsert',
            property: 'params.style.size',
            keys: [
              { frame: 0, value: 30 },
              { frame: 60, value: 90 },
            ],
          },
        ],
      },
    ],
  });
  expect(
    (await app.dispatch('animationInspect', { sceneId: 'intro', nodeId: 'data', frames: [30] }))
      .samples[0].values['params.style.size'],
  ).toBe(60);
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('animationEdit', {
      sceneId: 'intro',
      revision,
      edits: [
        { nodeId: 'data', actions: [{ type: 'transform', timeOffset: 10 }] },
        { nodeId: 'missing', actions: [{ type: 'remove' }] },
      ],
    }),
  ).rejects.toThrow('not found');
  expect(app.service.snapshot.revision).toBe(revision);
  await expect(
    app.dispatch('animationEdit', {
      sceneId: 'intro',
      edits: [
        {
          nodeId: 'data',
          actions: [
            { type: 'upsert', property: 'params.style.size', keys: [{ frame: 60, value: 200 }] },
          ],
        },
      ],
    }),
  ).rejects.toThrow('at most');
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
