import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-layer-plan-'));
  await initProject(root, 'layers', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const component =
  "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Card',parameters:{},render(){return[node({id:'box',type:'rect',x:30,y:30,width:50,height:40,fill:'#7799ff'})]}});";
it('creates scoped stacks, pages keys and commits exact native/generated edits with one undo', async () => {
  await app.service.transact([
    { type: 'writeSource', path: 'components/card.ts', content: component },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'native', type: 'rect', x: 30, y: 30, width: 50, height: 40 }),
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/card.ts',
            width: 320,
            height: 180,
          }),
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    layer = {
      id: 'offset',
      blend: 'add',
      channels: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 0 },
            { frame: 20, value: 30 },
          ],
          after: 'pingpong',
        },
      ],
    },
    plan = await app.dispatch('animationLayersPlan', {
      revision,
      targets: [
        { sceneId: 'intro', nodeId: 'native', actions: [{ type: 'append', layer }] },
        {
          sceneId: 'intro',
          path: ['code'],
          nodeId: 'code/box',
          actions: [{ type: 'append', layer }],
        },
      ],
    });
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const info = await app.dispatch('animationLayersInspect', {
    sceneId: 'intro',
    path: ['code'],
    nodeId: 'code/box',
    frames: [10, 30],
    includeKeys: true,
    keyLimit: 1,
  });
  expect(info.layers[0].channels[0].keys).toHaveLength(1);
  expect(info.layers[0].channels[0].nextKeyOffset).toBe(1);
  expect(info.samples.map((s: any) => s.values.x)).toEqual([45, 45]);
  const native = await app.dispatch('animationInspect', {
    sceneId: 'intro',
    nodeId: 'native',
    frames: [10, 30],
  });
  expect(native.sampleSource).toBe('keys-and-layers');
  expect(native.samples.map((s: any) => s.values.x)).toEqual([45, 45]);
  const beforeBad = app.service.snapshot.revision;
  await expect(
    app.dispatch('animationLayersPlan', {
      revision: beforeBad,
      targets: [
        { sceneId: 'intro', nodeId: 'native', actions: [{ type: 'remove', id: 'missing' }] },
      ],
    }),
  ).rejects.toMatchObject({ code: 'ANIMATION_LAYER_ID' });
  expect(app.service.snapshot.revision).toBe(beforeBad);
  expect(await readFile(path.join(root, 'components/card.ts'), 'utf8')).toBe(component);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('uses existing motion templates for overlapping layers, keeps original keys and captures native/cache parity', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'box',
        type: 'rect',
        x: 100,
        y: 40,
        width: 50,
        height: 30,
        opacity: 0.8,
        animations: [
          {
            property: 'x',
            keys: [
              { frame: 0, value: 100, easing: 'linear' },
              { frame: 59, value: 150, easing: 'linear' },
            ],
          },
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    plan = await app.dispatch('motionPlan', {
      revision,
      output: 'layers',
      cues: [
        {
          id: 'slide',
          template: { builtin: 'fadeSlide' },
          parameters: { dx: 20, dy: 0 },
          start: 0,
          duration: 20,
          blend: 'add',
        },
        {
          id: 'fade',
          template: { builtin: 'fadeOut' },
          parameters: { dx: 0, dy: 0 },
          start: 10,
          duration: 30,
          blend: 'multiply',
        },
      ],
      targets: [{ sceneId: 'intro', nodeId: 'box' }],
    });
  expect(plan.layers[0].output).toBe('layers');
  const checked = await app.dispatch('projectPreflight', plan.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  const node = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'box')!;
  expect(node.animations).toHaveLength(1);
  expect(node.animationLayers).toHaveLength(2);
  const comparison = await app.dispatch('renderCompare', {
    sceneId: 'intro',
    width: 320,
    height: 180,
    frames: [0, 10, 30, 45],
    repeat: 2,
    baseline: { nativeCache: false },
    optimized: { nativeCache: true },
  });
  expect(comparison.equivalence.matched).toBe(true);
  expect(comparison.optimized.nativeAnimation.definitionBytesSent).toBeLessThan(
    comparison.baseline.nativeAnimation.definitionBytesSent,
  );
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('remaps layered parameter-array channels and validates the final component parameter domain', async () => {
  const source =
    "import{defineComponent,node}from'@vmotion/sdk';export default defineComponent({name:'Array',parameters:{items:{type:'array',items:{type:'number',default:10,min:0,max:100},default:[10,20],maxLength:4}},render(ctx,p){return[node({id:'r',type:'rect',width:Number(p.items[0]),height:30})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/array.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: newNode({
        id: 'array',
        type: 'component',
        component: 'components/array.ts',
        width: 320,
        height: 180,
        params: { items: [10, 20] },
        animationLayers: [
          {
            id: 'array-layer',
            channels: [
              {
                property: 'params.items.0',
                keys: [
                  { frame: 0, value: 0 },
                  { frame: 10, value: 5 },
                ],
              },
            ],
          },
        ],
      }),
    },
  ]);
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'array',
    arrays: [{ type: 'move', path: 'items', from: 0, to: 1 }],
  });
  const node = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'array')!;
  expect(node.animationLayers![0].channels[0].property).toBe('params.items.1');
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('animationLayersPlan', {
      revision,
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'array',
          actions: [
            {
              type: 'append',
              layer: {
                id: 'bad',
                channels: [{ property: 'params.items.0', keys: [{ frame: 0, value: 500 }] }],
              },
            },
          ],
        },
      ],
    }),
  ).rejects.toThrow();
  expect(app.service.snapshot.revision).toBe(revision);
});
