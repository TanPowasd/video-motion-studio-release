import { present } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-structure-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const edit = (action: unknown, scope: string[] = []) =>
  app.dispatch('compositionStructure', {
    sceneId: 'intro',
    frame: 30,
    path: scope,
    action,
    revision: app.service.snapshot.revision,
  });
it('groups, copies and deletes generated children without changing source or animated rendering', async () => {
  const source =
    "import {defineComponent,rect,group} from '@vmotion/sdk';export default defineComponent({name:'Boxes',parameters:{},render(){return group('row',[rect('a',{x:10,y:10,width:30,height:30,fill:'#ff0000',animations:[{property:'x',keys:[{frame:0,value:10,easing:'linear'},{frame:60,value:30,easing:'linear'}]}]}),rect('b',{x:70,y:10,width:30,height:30,fill:'#00ff00'})],{x:8,y:8});}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/boxes.ts', content: source },
    { type: 'updateProject', patch: { width: 160, height: 90 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/boxes.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  const before = await Promise.all(
      [0, 30, 60].map((frame) => app.frame({ sceneId: 'intro', frame })),
    ),
    scope = ['code', 'code/row'];
  await edit(
    { type: 'group', ids: ['code/row/a', 'code/row/b'], id: 'paired', name: '组合' },
    scope,
  );
  for (const [i, frame] of [0, 30, 60].entries())
    expect((await app.frame({ sceneId: 'intro', frame })).buffer.equals(before[i].buffer)).toBe(
      true,
    );
  expect(app.service.snapshot.files['components/boxes.ts']).toBe(source);
  const inside = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    frame: 30,
    path: [...scope, 'code/paired'],
  });
  expect(inside.scene.nodes.map((n: any) => n.id)).toEqual(['code/row/a', 'code/row/b']);
  const copy = await edit(
      { type: 'duplicate', ids: ['code/paired'], offset: { x: 0, y: 40 } },
      scope,
    ),
    copyId = copy.selection[0];
  const copied = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    frame: 30,
    path: [...scope, copyId],
  });
  expect(copied.scene.nodes).toHaveLength(2);
  expect(copied.scene.nodes[0].animations[0].keys[1].value).toBe(30);
  await edit({ type: 'delete', ids: [copyId] }, scope);
  expect((await app.frame({ sceneId: 'intro', frame: 30 })).buffer.equals(before[1].buffer)).toBe(
    true,
  );
  await app.service.undo();
  expect(
    (
      await app.dispatch('compositionInspect', {
        sceneId: 'intro',
        frame: 30,
        path: [...scope, copyId],
      })
    ).scene.nodes,
  ).toHaveLength(2);
}, 30000);
it('edits added nodes and nested component structure, and duplicates that component with its edits', async () => {
  const source =
      "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Outer',parameters:{},render(){return [node({id:'inner',type:'component',component:'components/inner.ts',width:160,height:90})];}});",
    inner =
      "import {defineComponent,rect} from '@vmotion/sdk';export default defineComponent({name:'Inner',parameters:{},render(){return [rect('original',{width:20,height:20,fill:'#ff0000'})];}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/outer.ts', content: source },
    { type: 'writeSource', path: 'components/inner.ts', content: inner },
    { type: 'updateProject', patch: { width: 160, height: 90 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'code',
            type: 'component',
            component: 'components/outer.ts',
            width: 160,
            height: 90,
          }),
        ],
      },
    },
  ]);
  const scope = ['code', 'code/inner'];
  await edit(
    {
      type: 'add',
      node: { id: 'added', type: 'rect', x: 30, y: 30, width: 20, height: 20, fill: '#00ff00' },
    },
    scope,
  );
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    frame: 30,
    path: scope,
    nodeId: 'code/inner/added',
    patch: { x: 60, fill: '#0000ff' },
    revision: app.service.snapshot.revision,
  });
  let inside = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    frame: 30,
    path: scope,
  });
  expect(
    present(present(present(inside)).scene.nodes.find((n: any) => n.id.endsWith('/added'))).x,
  ).toBe(60);
  const copy = await edit({ type: 'duplicate', ids: ['code/inner'], offset: { x: 0, y: 0 } }, [
      'code',
    ]),
    copyId = copy.selection[0];
  inside = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    frame: 30,
    path: ['code', copyId],
  });
  expect(
    present(present(present(inside)).scene.nodes.find((n: any) => n.id.endsWith('/added'))).fill,
  ).toBe('#0000ff');
  expect(app.service.snapshot.files['components/outer.ts']).toBe(source);
}, 30000);
it('adds within a native group, reorders its children and rejects invalid cross-parent grouping atomically', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({ id: 'g', type: 'group', x: 80, y: 40 }),
          newNode({ id: 'a', type: 'rect', parentId: 'g' }),
          newNode({ id: 'outside', type: 'text' }),
        ],
      },
    },
  ]);
  await edit({ type: 'add', node: { id: 'b', type: 'rect', name: 'B' } }, ['g']);
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'b')!.parentId).toBe('g');
  await edit({ type: 'order', ids: ['a'], direction: 'front' }, ['g']);
  expect(
    (await app.dispatch('compositionInspect', { sceneId: 'intro', path: ['g'] })).scene.nodes.map(
      (n: any) => n.id,
    ),
  ).toEqual(['b', 'a']);
  const revision = app.service.snapshot.revision;
  await expect(edit({ type: 'group', ids: ['a', 'outside'] })).rejects.toThrow('同一父级');
  expect(app.service.snapshot.revision).toBe(revision);
  await edit({ type: 'delete', ids: ['a', 'b'] }, ['g']);
  expect(app.service.snapshot.scenes[0].nodes.map((n) => n.id)).toEqual(['g', 'outside']);
});
