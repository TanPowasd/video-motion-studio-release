import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-driver-render-'));
  await initProject(root, 'drivers', {
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
it('renders the same expression/layout/path result as native interaction geometry, including time samples', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        background: 'transparent',
        nodes: [
          newNode({
            id: 'path',
            type: 'path',
            path: 'M40 90 C100 30 200 150 280 90',
            fill: 'transparent',
            stroke: '#224466',
            strokeWidth: 1,
          }),
          newNode({
            id: 'marker',
            type: 'rect',
            width: 12,
            height: 8,
            fill: '#ff0000',
            originX: 6,
            originY: 4,
            motionPath: { nodeId: 'path', autoRotate: true, anchor: 'origin' },
            expressions: { 'motionPath.progress': 'frame / 59' },
            effects: [{ type: 'motionBlur', samples: 4, shutterAngle: 180, phase: 0 }],
          }),
          newNode({
            id: 'panel',
            type: 'rect',
            width: 40,
            height: 20,
            fill: '#00ff00',
            layout: {
              reference: 'scene',
              x: { at: 'end', self: 'end', offset: -10 },
              y: { at: 'start', self: 'start', offset: 10 },
            },
            expressions: { width: '40 + time * 20' },
          }),
        ],
      },
    },
  ]);
  const snapshot = app.service.snapshot,
    first = await app.frame({ sceneId: 'intro', frame: 30, width: 320, height: 180 }),
    graph = await app.renderer.inspectInteractions(snapshot, 'intro', 30),
    marker = graph.layers.find((layer) => layer.node.id === 'marker')!;
  expect(marker.matrix[4]).toBeGreaterThan(120);
  expect(marker.matrix[4]).toBeLessThan(190);
  const panel = graph.layers.find((layer) => layer.node.id === 'panel')!;
  expect(panel.bounds.width).toBe(60);
  expect(panel.matrix[4]).toBe(250);
  await app.frame({ frame: 0, width: 320, height: 180 });
  expect(
    (await app.frame({ sceneId: 'intro', frame: 30, width: 320, height: 180 })).buffer,
  ).toEqual(first.buffer);
  const job = await app.dispatch('render', {
    format: 'png',
    revision: snapshot.revision,
    output: path.join(root, 'exports/frames'),
    start: 30,
    end: 31,
  });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  const { readFile } = await import('node:fs/promises');
  expect(await readFile(path.join(root, 'exports/frames/frame-00000030.png'))).toEqual(
    first.buffer,
  );
});
it('evaluates generated references at local clocks and nested component dimensions while preserving source syntax', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'responsive',parameters:{},render(ctx){return [node({id:'anchor',type:'rect',width:20,height:20,x:40,y:40,expressions:{x:'40 + time * 10'}}),node({id:'follower',type:'rect',width:20,height:20,y:40,expressions:{x:'layer(\"anchor\").x + 30'}}),node({id:'panel',type:'rect',height:20,layout:{width:{value:.5},x:{at:'center',self:'center'},y:{at:'end',self:'end',offset:-10}}})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/responsive.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'component',
        type: 'component',
        component: 'components/responsive.ts',
        width: 200,
        height: 100,
      },
    },
  ]);
  const layers = (await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 30)).layers;
  expect(layers.find((layer) => layer.node.id === 'component/follower')?.matrix[4]).toBe(80);
  expect(layers.find((layer) => layer.node.id === 'component/panel')?.bounds.width).toBe(100);
  expect(layers.find((layer) => layer.node.id === 'component/panel')?.matrix[4]).toBe(50);
  expect(
    (await app.frame({ sceneId: 'intro', frame: 30, width: 320, height: 180 })).buffer.length,
  ).toBeGreaterThan(100);
});
it('rejects invalid static driver graphs before saving while keeping valid project source', async () => {
  const revision = app.service.snapshot.revision;
  await expect(
    app.service.transact([
      {
        type: 'addNode',
        sceneId: 'intro',
        node: { id: 'cycle', type: 'rect', expressions: { x: 'self.x + 1' } },
      },
    ]),
  ).rejects.toThrow('validation');
  expect(app.service.snapshot.revision).toBe(revision);
});
it('preserves parent layout dimensions and outside driver references when a group is focused', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'outside', type: 'rect', x: 50, width: 20, height: 10 }),
          newNode({ id: 'group', type: 'group', width: 120, height: 80, x: 30, y: 20 }),
          newNode({
            id: 'inside',
            parentId: 'group',
            type: 'rect',
            height: 10,
            layout: { width: { value: 0.5 }, x: { at: 'center', self: 'center' } },
            expressions: { y: 'layer("outside").x / 5' },
          }),
        ],
      },
    },
  ]);
  const layers = (
    await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0, ['group'])
  ).layers;
  expect(layers[0].bounds.width).toBe(60);
  expect(layers[0].matrix[4]).toBe(30);
  expect(layers[0].matrix[5]).toBe(10);
  expect(
    (await app.frame({ sceneId: 'intro', frame: 0, path: ['group'], width: 320, height: 180 }))
      .buffer.length,
  ).toBeGreaterThan(100);
  const info = await app.dispatch('driversInspect', {
    sceneId: 'intro',
    path: ['group'],
    nodeIds: ['inside'],
  });
  expect(info.samples[0].layers[0].pose).toMatchObject({ width: 60, x: 30, y: 10 });
});
