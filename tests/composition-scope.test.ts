import { present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
import { movePatch, parentDelta, pickLayer, transform } from '../src/core/interaction.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-scope-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('enters a raw group and excludes its siblings from the isolated timeline and preview', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'g', type: 'group', name: 'Group', x: 500, y: 500 }),
          newNode({
            id: 'inside',
            type: 'rect',
            parentId: 'g',
            name: 'Inside',
            x: 10,
            y: 10,
            width: 40,
            height: 40,
            fill: '#ff0000',
          }),
          newNode({ id: 'outside', type: 'text', text: 'Do not show' }),
        ],
      },
    },
  ]);
  const scope = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    path: ['g'],
    frame: 0,
  });
  expect(scope.scene.nodes.map((n: any) => n.id)).toEqual(['inside']);
  expect(scope.scene.nodes[0].parentId).toBeUndefined();
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['g'],
    nodeId: 'inside',
    frame: 0,
    patch: { x: 30 },
    revision: app.service.snapshot.revision,
  });
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'inside')!.x).toBe(30);
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'inside')!.parentId).toBe('g');
});
it('enters generated component groups and saves stable-ID overrides without altering source', async () => {
  const source =
    "import {defineComponent,node,group} from '@vmotion/sdk'; export default defineComponent({name:'Boxes',parameters:{},render(){return group('nested',[node({id:'child',type:'rect',name:'Child',x:10,y:10,width:40,height:40,fill:'#ff0000'})],{x:20,y:20});}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/boxes.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            name: 'Code',
            component: 'components/boxes.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  const scope = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    path: ['code', 'code/nested'],
    frame: 0,
  });
  expect(scope.scene.nodes.map((n: any) => n.id)).toEqual(['code/nested/child']);
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['code', 'code/nested'],
    nodeId: 'code/nested/child',
    frame: 0,
    patch: { fill: '#0000ff', x: 25 },
    revision: app.service.snapshot.revision,
  });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['nested/child']).toEqual({
    fill: '#0000ff',
    x: 25,
  });
  expect(app.service.snapshot.files['components/boxes.ts']).toBe(source);
  const updated = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    path: ['code', 'code/nested'],
    frame: 0,
  });
  expect(updated.scene.nodes[0].x).toBe(25);
  const canvas = await app.renderer.render(app.service.snapshot, 0, {
    sceneId: 'intro',
    path: ['code', 'code/nested'],
    width: 160,
    height: 90,
  });
  expect(canvas.getContext('2d').getImageData(35, 20, 1, 1).data[2]).toBe(255);
  await app.service.undo();
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({});
}, 30000);
it('moves multiple generated and native layers atomically and restores all of them with one undo', async () => {
  const source =
    "import {defineComponent,text,group} from '@vmotion/sdk'; export default defineComponent({name:'Pair',parameters:{},render(){return [...group('rot',[text('first','甲',{x:10,y:20,width:200,height:60})],{x:100,y:100,rotation:90,scaleX:2}),text('second','乙',{x:300,y:20,width:200,height:60})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/pair.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/pair.ts',
            width: 1920,
            height: 1080,
            overrides: { second: { fill: '#ffcc88' } },
          }),
          newNode({ id: 'native', type: 'rect', x: 600, y: 200, width: 40, height: 40 }),
        ],
      },
    },
  ]);
  const graph = await app.dispatch('compositionInteractions', { sceneId: 'intro', frame: 0 }),
    selected = graph.layers.filter((l: any) =>
      ['code/rot/first', 'code/second', 'native'].includes(l.node.id),
    ),
    delta = { x: 22, y: 36 },
    edits = selected.map((l: any) => ({
      path: l.path,
      nodeId: l.node.id,
      patch: movePatch(l.node, 0, parentDelta(l, delta)!),
    })),
    revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('compositionTransactBatch', {
      sceneId: 'intro',
      frame: 0,
      revision,
      edits: [edits[0], { ...edits[1], nodeId: 'missing' }],
    }),
  ).rejects.toThrow('Composition layer not found');
  expect(app.service.snapshot.revision).toBe(revision);
  const preview = await app.frame({
    sceneId: 'intro',
    frame: 0,
    width: 320,
    height: 180,
    draft: edits,
  });
  expect(app.service.snapshot.revision).toBe(revision);
  await app.dispatch('compositionTransactBatch', { sceneId: 'intro', frame: 0, revision, edits });
  const after = await app.dispatch('compositionInteractions', { sceneId: 'intro', frame: 0 });
  for (const before of selected) {
    const current = after.layers.find((l: any) => l.node.id === before.node.id);
    expect(present(current).matrix[4] - before.matrix[4]).toBeCloseTo(delta.x, 2);
    expect(present(current).matrix[5] - before.matrix[5]).toBeCloseTo(delta.y, 2);
  }
  expect(app.service.snapshot.scenes[0].nodes[0].overrides.second.fill).toBe('#ffcc88');
  expect(
    (await app.frame({ sceneId: 'intro', frame: 0, width: 320, height: 180 })).buffer.equals(
      preview.buffer,
    ),
  ).toBe(true);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({
    second: { fill: '#ffcc88' },
  });
  expect(app.service.snapshot.scenes[0].nodes[1].x).toBe(600);
}, 30000);
it('directly drags nested generated text from a scene, previews without writes, saves and undoes once', async () => {
  const source =
    "import {defineComponent,text,group} from '@vmotion/sdk'; export default defineComponent({name:'Nested',parameters:{},render(){return group('nested',[text('title','可拖动文字',{x:10,y:12,width:600,height:60,fontSize:32})],{x:80,y:60,rotation:90,scaleX:2,scaleY:1});}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/nested.ts', content: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/nested.ts',
            width: 1920,
            height: 1080,
          }),
        ],
      },
    },
  ]);
  const graph = await app.dispatch('compositionInteractions', { sceneId: 'intro', frame: 0 }),
    target = graph.layers.find((l: any) => l.node.type === 'text'),
    inside = transform(present(target).matrix, {
      x: present(target).bounds.x + present(target).bounds.width / 2,
      y: present(target).bounds.y + present(target).bounds.height / 2,
    });
  expect(pickLayer(graph.layers, inside)?.node.id).toBe('code/nested/title');
  expect(present(target).path).toEqual(['code']);
  const delta = parentDelta(present(target), { x: 20, y: 40 })!,
    draft = {
      path: present(target).path,
      nodeId: present(target).node.id,
      patch: { x: present(target).node.x + delta.x, y: present(target).node.y + delta.y },
    },
    revision = app.service.snapshot.revision;
  const before = await app.frame({ sceneId: 'intro', frame: 0, width: 320, height: 180 }),
    preview = await app.frame({ sceneId: 'intro', frame: 0, width: 320, height: 180, draft });
  expect(preview.buffer.equals(before.buffer)).toBe(false);
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({});
  await app.dispatch('compositionTransact', { sceneId: 'intro', frame: 0, ...draft, revision });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['nested/title']).toEqual(draft.patch);
  expect(
    (await app.frame({ sceneId: 'intro', frame: 0, width: 320, height: 180 })).buffer.equals(
      preview.buffer,
    ),
  ).toBe(true);
  expect(app.service.snapshot.files['components/nested.ts']).toBe(source);
  await app.service.undo();
  expect(app.service.snapshot.scenes[0].nodes[0].overrides).toEqual({});
  expect(
    (await app.frame({ sceneId: 'intro', frame: 0, width: 320, height: 180 })).buffer.equals(
      before.buffer,
    ),
  ).toBe(true);
}, 30000);
it('bounds a transformed path group around its current content instead of the default origin rectangle', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'outer',
            type: 'group',
            x: 120,
            y: 80,
            rotation: 30,
            scaleX: 1.5,
            scaleY: 0.8,
          }),
          newNode({
            id: 'cube',
            type: 'group',
            parentId: 'outer',
            x: 20,
            y: 30,
            rotation: -15,
            originX: 10,
            originY: 20,
          }),
          newNode({
            id: 'edge',
            type: 'path',
            parentId: 'cube',
            path: 'M 300 210 L 360 210 L 360 270 Z',
            fill: 'transparent',
            stroke: '#79b6ff',
            strokeWidth: 2,
            animations: [
              {
                property: 'x',
                keys: [
                  { frame: 0, value: 0, easing: 'linear' },
                  { frame: 60, value: 30, easing: 'linear' },
                ],
              },
            ],
          }),
        ],
      },
    },
  ]);
  for (const frame of [0, 30, 60]) {
    const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', frame),
      group = graph.layers.find((l) => l.node.id === 'cube')!;
    // The 45-degree corners extend to the miter intersection, beyond half-width padding.
    expect(group.bounds.x).toBeCloseTo(299 - Math.SQRT2 + frame / 2, 4);
    expect(group.bounds.y).toBeCloseTo(209, 4);
    expect(group.bounds.width).toBeCloseTo(62 + Math.SQRT2, 4);
    expect(group.bounds.height).toBeCloseTo(62 + Math.SQRT2, 4);
    const centre = transform(group.matrix, { x: group.bounds.x + group.bounds.width / 2, y: 240 });
    expect(centre.x).toBeGreaterThan(300);
  }
});
