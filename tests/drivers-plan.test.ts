import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-drivers-plan-'));
  await initProject(root, 'batch', {
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
it('plans expressions/layout/path in one generated batch with exact candidate pictures and atomic undo', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'linked',parameters:{},render(){return [node({id:'curve',type:'path',path:'M40 100 C90 20 240 150 280 60',fill:'transparent',stroke:'#447799',strokeWidth:2}),node({id:'marker',type:'rect',width:14,height:10}),node({id:'panel',type:'rect',width:50,height:30}),node({id:'label',type:'text',text:'联动标签',fontSize:18,width:110,height:32})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/batch.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'component',
        type: 'component',
        component: 'components/batch.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const revision = app.service.snapshot.revision,
    plan = await app.dispatch('driversPlan', {
      revision,
      targets: [
        {
          sceneId: 'intro',
          nodeId: 'component/marker',
          path: ['component'],
          motionPath: { nodeId: 'curve', anchor: 'center', autoRotate: true },
          expressions: { 'motionPath.progress': 'frame / 59' },
        },
        {
          sceneId: 'intro',
          nodeId: 'component/panel',
          path: ['component'],
          layout: {
            reference: 'scene',
            width: { value: 0.3 },
            height: { value: 28, unit: 'pixels' },
            x: { at: 'end', self: 'end', offset: -10 },
            y: { at: 'start', self: 'start', offset: 10 },
          },
        },
        {
          sceneId: 'intro',
          nodeId: 'component/label',
          path: ['component'],
          expressions: { x: 'layer("panel").x', y: 'layer("panel").y + 3' },
        },
      ],
    });
  expect(app.service.snapshot.revision).toBe(revision);
  const checked = await app.dispatch('projectPreflight', { ...plan.candidate, inline: true });
  expect(checked.valid).toBe(true);
  expect(checked.data).toBeTruthy();
  await app.dispatch('projectApply', plan.apply);
  const info = await app.dispatch('driversInspect', {
    sceneId: 'intro',
    path: ['component'],
    nodeIds: ['component/panel', 'component/label'],
    frames: [30],
  });
  expect(info.samples[0].layers[0].pose).toMatchObject({ width: 96, height: 28, x: 214, y: 10 });
  expect(info.samples[0].layers[1].pose).toMatchObject({ x: 214, y: 13 });
  const animation = await app.dispatch('animationInspect', {
    sceneId: 'intro',
    path: ['component'],
    nodeId: 'component/label',
    frame: 30,
  });
  expect(animation.sampleSource).toBe('keys-and-drivers');
  expect(animation.samples[0].values).toMatchObject({ x: 214, y: 13 });
  expect(app.service.snapshot.files['components/batch.ts']).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('checks the final combined candidate rather than rejecting temporary dependency states in an edit batch', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'a', type: 'rect', x: 30 }),
          newNode({ id: 'b', type: 'rect', x: 80 }),
        ],
      },
    },
  ]);
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('driversPlan', {
      revision,
      targets: [
        { sceneId: 'intro', nodeId: 'a', expressions: { x: 'layer("b").x' } },
        { sceneId: 'intro', nodeId: 'b', expressions: { x: 'layer("a").x' } },
      ],
    }),
  ).rejects.toMatchObject({ code: 'DRIVER_CYCLE' });
  expect(app.service.snapshot.revision).toBe(revision);
  await app.service.transact([
    {
      type: 'updateNode',
      sceneId: 'intro',
      nodeId: 'b',
      patch: { expressions: { x: 'layer("a").x+10' } },
    },
  ]);
  const swap = await app.dispatch('driversPlan', {
    revision: app.service.snapshot.revision,
    targets: [
      { sceneId: 'intro', nodeId: 'a', expressions: { x: 'layer("b").x+10' } },
      { sceneId: 'intro', nodeId: 'b', resetExpressions: true },
    ],
  });
  await app.dispatch('projectApply', swap.apply);
  expect(
    (await app.dispatch('driversInspect', { sceneId: 'intro', nodeIds: ['a'] })).samples[0]
      .layers[0].pose.x,
  ).toBe(90);
});
it('removes driver configurations and their own numeric channels explicitly without losing unrelated animation', async () => {
  await app.service.transact([
    {
      type: 'addNode',
      sceneId: 'intro',
      node: newNode({
        id: 'a',
        type: 'rect',
        motionPath: { path: 'M10 20 L200 20' },
        animations: [
          {
            property: 'motionPath.progress',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 59, value: 1, easing: 'linear' },
            ],
          },
          {
            property: 'opacity',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 59, value: 1, easing: 'linear' },
            ],
          },
        ],
      }),
    },
  ]);
  const plan = await app.dispatch('driversPlan', {
    revision: app.service.snapshot.revision,
    targets: [
      { sceneId: 'intro', nodeId: 'a', motionPath: null, removeChannels: ['motionPath.progress'] },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.scenes[0].nodes[0].motionPath).toBeNull();
  expect(
    app.service.snapshot.scenes[0].nodes[0].animations.map((channel) => channel.property),
  ).toEqual(['opacity']);
});
