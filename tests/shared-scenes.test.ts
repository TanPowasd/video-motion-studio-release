import { present } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newNode, sceneSchema, type Node } from '../src/core/model.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { transform, hitLayer, movePatch, parentDelta } from '../src/core/interaction.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-shared-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
async function main(nodes: Node[]) {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 320, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { background: 'transparent', duration: 90, nodes },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 90,
        tracks: [
          {
            id: 'v',
            name: 'visual',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'intro',
                sceneId: 'intro',
                start: 0,
                duration: 90,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    },
  ]);
}
async function source() {
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'source',
        name: 'Source',
        width: 160,
        height: 90,
        duration: 60,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'box',
            type: 'rect',
            x: 10,
            y: 15,
            width: 30,
            height: 20,
            fill: '#ff0000',
            animations: [
              {
                property: 'x',
                keys: [
                  { frame: 0, value: 10, easing: 'linear' },
                  { frame: 30, value: 30, easing: 'linear' },
                ],
              },
            ],
          }),
        ],
      }),
    },
  ]);
}
it('renders independent instances and maps nested geometry through source dimensions, camera and transform', async () => {
  await source();
  await main([
    newNode({
      id: 'ref',
      type: 'scene',
      sceneId: 'source',
      x: 40,
      y: 20,
      width: 80,
      height: 45,
      matrix: [1, 0, 0.2, 1, 0, 0],
    }),
  ]);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'source',
      patch: { camera: { x: 5, y: 0, zoom: 1, rotation: 0 } },
    },
  ]);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0),
    leaf = graph.layers.find((l) => l.node.id === 'ref/box')!;
  const world = transform(leaf.matrix, { x: 15, y: 10 }),
    c = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' }),
    pixel = c.getContext('2d').getImageData(Math.floor(world.x), Math.floor(world.y), 1, 1).data;
  expect([...pixel]).toEqual([255, 0, 0, 255]);
  expect(hitLayer(leaf, world)).toBe(true);
  expect(leaf.path).toEqual(['ref']);
  const scope = await app.dispatch('compositionInspect', {
    sceneId: 'intro',
    path: ['ref'],
    frame: 0,
  });
  expect(scope.width).toBe(160);
  expect(scope.height).toBe(90);
  expect(scope.scene.duration).toBe(60);
  expect(present(present(present(scope)).scene.camera).x).toBe(5);
  const isolated = await app.renderer.render(app.service.snapshot, 0, {
    sceneId: 'intro',
    path: ['ref'],
  });
  expect(isolated.width).toBe(160);
  expect(isolated.height).toBe(90);
}, 30000);
it('instance edits and animated dragging leave source JSON and other instances untouched', async () => {
  await main([]);
  await source();
  await app.dispatch('scenePlace', {
    sceneId: 'intro',
    sourceId: 'source',
    id: 'left',
    width: 160,
    height: 90,
  });
  await app.dispatch('scenePlace', {
    sceneId: 'intro',
    sourceId: 'source',
    id: 'right',
    x: 160,
    width: 160,
    height: 90,
  });
  const original = await readFile(path.join(root, 'scenes/source.json'), 'utf8'),
    before = app.service.snapshot.revision;
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 15),
    leaf = graph.layers.find((l) => l.node.id === 'left/box')!,
    delta = parentDelta(leaf, { x: 12, y: 6 })!,
    patch = movePatch(leaf.node, 15, delta);
  await app.dispatch('compositionTransactBatch', {
    sceneId: 'intro',
    frame: 15,
    edits: [{ nodeId: 'left/box', path: ['left'], patch: { ...patch, fill: '#0000ff' } }],
  });
  expect(await readFile(path.join(root, 'scenes/source.json'), 'utf8')).toBe(original);
  expect(app.service.snapshot.scenes[0].nodes[0].overrides.box.fill).toBe('#0000ff');
  const changed = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 15, [
      'left',
    ]),
    other = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 15, ['right']);
  expect(changed.scene.nodes[0].fill).toBe('#0000ff');
  expect(other.scene.nodes[0].fill).toBe('#ff0000');
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
}, 30000);
it('source edits synchronize all instances while explicit overrides remain authoritative', async () => {
  await main([]);
  await source();
  await app.dispatch('scenePlace', { sceneId: 'intro', sourceId: 'source', id: 'a' });
  await app.dispatch('scenePlace', { sceneId: 'intro', sourceId: 'source', id: 'b', x: 160 });
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['a'],
    nodeId: 'a/box',
    patch: { fill: '#0000ff' },
  });
  await app.service.transact([
    {
      type: 'updateNode',
      sceneId: 'source',
      nodeId: 'box',
      patch: { fill: '#00ff00', height: 28 },
    },
  ]);
  for (const id of ['a', 'b']) {
    const scope = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, [id]);
    expect(scope.scene.nodes[0].height).toBe(28);
    expect(scope.scene.nodes[0].fill).toBe(id === 'a' ? '#0000ff' : '#00ff00');
  }
  const refs = await app.dispatch('sceneReferences', { sourceId: 'source' });
  expect(refs.incoming.filter((r: { kind: string }) => r.kind === 'layer')).toHaveLength(2);
}, 30000);
it('resets native and generated instance overrides without touching source or placement and supports undo', async () => {
  await main([]);
  await source();
  await app.dispatch('scenePlace', { sceneId: 'intro', sourceId: 'source', id: 'a', x: 60 });
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['a'],
    nodeId: 'a/box',
    patch: { fill: '#0000ff' },
  });
  await app.dispatch('compositionStructure', {
    sceneId: 'intro',
    path: ['a'],
    action: { type: 'duplicate', ids: ['a/box'] },
  });
  const before = app.service.snapshot.revision;
  await app.dispatch('sceneReset', { sceneId: 'intro', nodeId: 'a' });
  expect(app.service.snapshot.scenes[0].nodes[0].x).toBe(60);
  expect(app.service.snapshot.scenes[0].nodes[0].structure).toBeUndefined();
  expect(
    (await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, ['a'])).scene.nodes,
  ).toHaveLength(1);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  const made = await app.dispatch('scenePrecompose', {
    sceneId: 'intro',
    nodeIds: ['a'],
    sourceId: 'outer',
    id: 'r',
  });
  expect(made.selection).toEqual(['r']);
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['r', 'r/a'],
    nodeId: 'r/a/box',
    patch: { fill: '#00ff00' },
  });
  await app.dispatch('sceneReset', { sceneId: 'intro', path: ['r'], nodeId: 'r/a' });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['a/box']).toBeUndefined();
  // The nested reference retains the defaults already stored in the shared source.
  expect(
    (await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, ['r', 'r/a'])).scene
      .nodes[0].fill,
  ).toBe('#0000ff');
}, 30000);
it('precomposes adjacent native layers and preserves random-frame pixels, masks, parent transforms and undo', async () => {
  await main([
    newNode({ id: 'g', type: 'group', x: 25, y: 30, rotation: 8 }),
    newNode({
      id: 'paint',
      parentId: 'g',
      type: 'rect',
      x: 10,
      y: 10,
      width: 60,
      height: 40,
      fill: '#fff',
      maskId: 'mask',
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 10, easing: 'linear' },
            { frame: 60, value: 50, easing: 'linear' },
          ],
        },
      ],
    }),
    newNode({
      id: 'mask',
      parentId: 'g',
      type: 'ellipse',
      x: 10,
      y: 10,
      width: 70,
      height: 50,
      fill: '#fff',
    }),
    newNode({ id: 'outside', type: 'rect', x: 200, y: 20, width: 40, height: 40, fill: '#00ff00' }),
  ]);
  const frames = [0, 15, 60],
    pixels = await Promise.all(frames.map(async (frame) => (await app.frame({ frame })).buffer)),
    before = app.service.snapshot.revision;
  const made = await app.dispatch('scenePrecompose', {
    sceneId: 'intro',
    path: ['g'],
    nodeIds: ['paint', 'mask'],
    sourceId: 'shared',
    id: 'ref',
  });
  expect(made.sharedScene.captureMode).toBe('native-graph');
  expect(made.selection).toEqual(['ref']);
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'ref')!.parentId).toBe('g');
  for (const [i, frame] of frames.entries())
    expect((await app.frame({ frame })).buffer.equals(pixels[i])).toBe(true);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files['scenes/shared.json']).toBeUndefined();
  await app.service.redo();
  expect(app.service.snapshot.scenes.some((s) => s.id === 'shared')).toBe(true);
}, 30000);
it('precomposes generated content and supports instance structure edits through a scene inside a component', async () => {
  const content = `import {defineComponent,rect,group} from '@vmotion/sdk';export default defineComponent({name:'Boxes',parameters:{},render:()=>group('row',[rect('a',{x:10,y:20,width:20,height:20,fill:'#ff0000'}),rect('b',{x:50,y:20,width:20,height:20,fill:'#00ff00'})],{x:5,y:5})});`;
  await app.service.transact([{ type: 'writeSource', path: 'components/boxes.ts', content }]);
  await main([
    newNode({
      id: 'code',
      type: 'component',
      component: 'components/boxes.ts',
      width: 320,
      height: 180,
    }),
  ]);
  const before = (await app.frame({ frame: 0 })).buffer;
  const made = await app.dispatch('scenePrecompose', {
    sceneId: 'intro',
    path: ['code'],
    nodeIds: ['code/row'],
    sourceId: 'shared',
    id: 'ref',
  });
  expect(made.sharedScene.captureMode).toBe('generated-graph');
  expect((await app.frame({ frame: 0 })).buffer.equals(before)).toBe(true);
  const scope = ['code', 'code/ref', 'code/ref/row'];
  await app.dispatch('compositionStructure', {
    sceneId: 'intro',
    path: scope,
    action: { type: 'duplicate', ids: ['code/ref/row/a'], offset: { x: 0, y: 30 } },
  });
  const inspected = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, scope);
  expect(inspected.scene.nodes).toHaveLength(3);
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: scope,
    nodeId: 'code/ref/row/b',
    patch: { fill: '#0000ff' },
  });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['ref/row/b'].fill).toBe('#0000ff');
  expect(app.service.snapshot.files['components/boxes.ts']).toBe(content);
  expect(
    app.service.snapshot.scenes.find((s) => s.id === 'shared')!.nodes.find((n) => n.id === 'row/b')!
      .fill,
  ).toBe('#00ff00');
}, 30000);
it('nested references preserve source dimensions when isolated from a differently sized component', async () => {
  await main([]);
  await source();
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'outer',
        name: 'Outer',
        width: 240,
        height: 120,
        duration: 90,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'inner',
            type: 'scene',
            sceneId: 'source',
            x: 10,
            y: 10,
            width: 80,
            height: 45,
          }),
        ],
      }),
    },
  ]);
  await app.dispatch('scenePlace', {
    sceneId: 'intro',
    sourceId: 'outer',
    id: 'ref',
    width: 240,
    height: 120,
  });
  const scope = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, [
    'ref',
    'ref/inner',
  ]);
  expect(scope.width).toBe(160);
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['ref', 'ref/inner'],
    nodeId: 'ref/inner/box',
    patch: { fill: '#0000ff' },
  });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['inner/box'].fill).toBe('#0000ff');
  const picture = await app.renderer.render(app.service.snapshot, 0, {
    sceneId: 'intro',
    path: ['ref'],
  });
  expect([...picture.getContext('2d').getImageData(20, 20, 1, 1).data]).toEqual([0, 0, 255, 255]);
}, 30000);
it('rejects reordered selections, missing external masks and nested cyclic/missing references before saving', async () => {
  await main([
    newNode({ id: 'a', type: 'rect' }),
    newNode({ id: 'middle', type: 'rect' }),
    newNode({ id: 'b', type: 'rect' }),
  ]);
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('scenePrecompose', { sceneId: 'intro', nodeIds: ['a', 'b'] }),
  ).rejects.toThrow('unselected');
  expect(app.service.snapshot.revision).toBe(before);
  await source();
  const revised = app.service.snapshot.revision;
  await expect(
    app.dispatch('scenePlace', { sceneId: 'source', sourceId: 'source' }),
  ).rejects.toThrow('validation');
  expect(app.service.snapshot.revision).toBe(revised);
  await expect(
    app.service.transact([
      {
        type: 'updateNode',
        sceneId: 'intro',
        nodeId: 'a',
        patch: {
          structure: {
            added: [newNode({ id: 'bad', type: 'scene', sceneId: 'intro' })],
            removed: [],
            parents: {},
            order: [],
            nested: {},
          },
        },
      },
    ]),
  ).rejects.toThrow('validation');
  await expect(
    app.service.transact([
      {
        type: 'updateNode',
        sceneId: 'intro',
        nodeId: 'a',
        patch: { overrides: { reference: { sceneId: 'missing' } } },
      },
    ]),
  ).rejects.toThrow('validation');
}, 30000);
it('visual audit traverses referenced text and reports the instance edit path', async () => {
  await main([]);
  await app.service.transact([
    {
      type: 'addScene',
      scene: sceneSchema.parse({
        id: 'text',
        name: 'Text',
        width: 320,
        height: 180,
        duration: 60,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'title',
            type: 'text',
            text: '第一行\n第二行',
            x: 30,
            y: 40,
            width: 250,
            height: 20,
            fontSize: 24,
            fill: '#fff',
          }),
        ],
      }),
    },
  ]);
  await app.dispatch('scenePlace', { sceneId: 'intro', sourceId: 'text', id: 'ref' });
  const audit = await app.dispatch('visualAudit', { sceneId: 'intro', frames: [0], images: false });
  const truncated = audit.findings.find((f: { code: string }) => f.code === 'TEXT_TRUNCATED');
  expect(present(truncated).nodeId).toBe('ref/title');
  expect(present(truncated).path).toEqual(['ref']);
}, 30000);
it('PNG export uses the same instance overrides and source dimensions as arbitrary preview seeks', async () => {
  await main([]);
  await source();
  await app.dispatch('scenePlace', {
    sceneId: 'intro',
    sourceId: 'source',
    id: 'ref',
    x: 40,
    y: 20,
    width: 200,
    height: 110,
  });
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['ref'],
    nodeId: 'ref/box',
    patch: { fill: '#0000ff' },
  });
  const output = path.join(root, 'export'),
    job = app.renders.start(app.service.snapshot, { output, format: 'png', end: 3 });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  for (const frame of [2, 0, 1])
    expect(
      (await readFile(path.join(output, `frame-${String(frame).padStart(8, '0')}.png`))).equals(
        (await app.frame({ frame })).buffer,
      ),
    ).toBe(true);
}, 30000);
