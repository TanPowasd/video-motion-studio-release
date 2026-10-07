import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { newNode, type Node } from '../src/core/model.js';
import {
  repeatGraph,
  repeatGrid,
  repeatRadial,
  affineMatrix,
  repeaterMatrix,
  describeRepeater,
} from '../src/sdk/repeater.js';
import { transform, nodeMatrix, hitLayer } from '../src/core/interaction.js';
import { indexGraph } from '../src/core/graph.js';
import { NativeEvaluator } from '../src/core/native.js';
import { evaluateNode } from '../src/core/time.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';

it('maps pivots, shear and TRS combined with a full affine matrix without losing shear', () => {
  const matrix = affineMatrix({
    position: { x: 10, y: 20 },
    pivot: { x: 5, y: 6 },
    rotation: 90,
    scale: { x: 2, y: 3 },
    skew: 45,
  });
  const origin = transform(matrix, { x: 5, y: 6 });
  expect(origin.x).toBeCloseTo(15);
  expect(origin.y).toBeCloseTo(26);
  const mapped = transform(matrix, { x: 6, y: 7 });
  expect(mapped.x).toBeCloseTo(12);
  expect(mapped.y).toBeCloseTo(31);
  const node = newNode({ id: 'shape', type: 'rect', x: 100, y: 50, matrix: [1, 0, 0.5, 1, 3, 4] });
  expect(transform(nodeMatrix(node), { x: 20, y: 10 })).toEqual({ x: 128, y: 64 });
  expect(() => affineMatrix({ skew: 90 })).toThrow('Affine');
});
it('copies hierarchies and masks with stable IDs and independently editable data', () => {
  const source = [
    newNode({ id: 'group', type: 'group' }),
    newNode({ id: 'paint', type: 'rect', parentId: 'group', maskId: 'mask', params: { a: [1] } }),
    newNode({ id: 'mask', type: 'ellipse', parentId: 'group' }),
  ];
  const nodes = repeatGraph('r', source, { count: 3, position: { x: 40, y: 0 } });
  indexGraph(nodes);
  expect(nodes.find((n) => n.id === 'r/copy-1/paint')?.maskId).toBe('r/copy-1/mask');
  expect(nodes.find((n) => n.id === 'r/copy-1/group')?.parentId).toBe('r/copy-1');
  (nodes.find((n) => n.id === 'r/copy-1/paint')!.params.a as number[])[0] = 9;
  expect(source[1].params.a).toEqual([1]);
  expect(nodes.find((n) => n.id === 'r/copy-0/paint')!.params.a).toEqual([1]);
  const grown = repeatGraph('r', source, { count: 4, reverse: true });
  expect(grown.find((n) => n.id === 'r/copy-0/paint')?.id).toBe('r/copy-0/paint');
  expect(grown[1].id).toBe('r/copy-3');
});
it('fractional count only fades the final copy and supports opacity ramps and empty patterns', () => {
  const source = [newNode({ id: 'dot', type: 'ellipse' })],
    nodes = repeatGraph('r', source, { count: 2.5, startOpacity: 0.9, endOpacity: 0.1 });
  expect(nodes.find((n) => n.id === 'r/copy-0')!.opacity).toBeCloseTo(0.9);
  expect(nodes.find((n) => n.id === 'r/copy-1')!.opacity).toBeCloseTo(0.5);
  expect(nodes.find((n) => n.id === 'r/copy-2')!.opacity).toBeCloseTo(0.05);
  expect(repeatGraph('r', source, { count: 0 })).toEqual([]);
});
it('grid and radial layouts expose exact transforms and callback copy contexts', () => {
  const source = [newNode({ id: 'dot', type: 'ellipse' })];
  const grid = repeatGrid('g', source, { count: 5, columns: 2, gap: { x: 40, y: 30 } });
  expect(transform(grid.find((n) => n.id === 'g/copy-3')!.matrix, { x: 0, y: 0 })).toEqual({
    x: 40,
    y: 30,
  });
  const radial = repeatRadial('r', source, {
    count: 4,
    radius: 100,
    angleStep: 90,
    orientation: 'tangent',
  });
  const node = radial.find((n) => n.id === 'r/copy-1')!,
    at = transform(node.matrix, { x: 0, y: 0 }),
    tip = transform(node.matrix, { x: 1, y: 0 });
  expect(at.x).toBeCloseTo(0);
  expect(at.y).toBeCloseTo(100);
  expect(tip.x - at.x).toBeCloseTo(-1);
  const contexts: number[] = [];
  repeatGraph(
    'r',
    ({ transformIndex }) => {
      contexts.push(transformIndex);
      return source;
    },
    { count: 2, offset: 0.5 },
  );
  expect(contexts).toEqual([0.5, 1.5]);
  expect(repeaterMatrix({ scale: { x: -1, y: 1 } }, 1)[0]).toBe(-1);
  expect(repeaterMatrix({ scale: { x: -1, y: 1 } }, 2)[0]).toBe(1);
  expect(() => repeaterMatrix({ scale: { x: -1, y: 1 }, offset: 0.5 }, 0)).toThrow('integer');
  expect(
    repeaterMatrix({ position: { x: 20, y: 0 }, scale: { x: 2, y: 1 }, offset: 0.5 }, 0)[0],
  ).toBeCloseTo(Math.sqrt(2));
});
it('rejects invalid graphs and runaway expansion before returning misleading output', () => {
  const source = [newNode({ id: 'a', type: 'rect', maskId: 'outside' })];
  expect(() => repeatGraph('r', source)).toThrow('invalid mask');
  expect(() =>
    repeatGraph('r', [newNode({ id: 'a', type: 'rect' })], {
      count: 50,
      scale: { x: 100, y: 100 },
    }),
  ).toThrow('range');
  const large = Array.from({ length: 100 }, (_, i) => newNode({ id: `n${i}`, type: 'rect' }));
  expect(() => repeatGraph('r', large, { count: 300 })).toThrow('budget');
  expect(() => repeatGraph('r', large, { count: 513 })).toThrow();
});
it('pattern inspection predicts bounds and sampled transforms without expanding every source node', () => {
  const report = describeRepeater({
    parameters: { count: 3, position: { x: 40, y: 10 } },
    sourceBounds: { x: 5, y: 5, width: 20, height: 10 },
  });
  expect(report.bounds).toEqual({ x: 5, y: 5, width: 100, height: 30 });
  expect(report.copies.map((c) => c.id)).toEqual([
    'copies/copy-0',
    'copies/copy-1',
    'copies/copy-2',
  ]);
  expect(() => describeRepeater({ parameters: { count: 2 }, indices: [2] })).toThrow('outside');
  expect(describeRepeater({ parameters: { count: 0 } }).copies).toEqual([]);
});
it('Rust and TypeScript agree on animated affine coefficients after random seeking', async () => {
  const node = newNode({
      id: 'shear',
      type: 'rect',
      animations: [
        {
          property: 'matrix.2',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 0.8, easing: 'linear' },
          ],
        },
      ],
    }),
    native = new NativeEvaluator();
  try {
    for (const frame of [60, 0, 30, 10, 60])
      expect((await native.evaluate([node], frame))[0].matrix).toEqual(
        evaluateNode(node, frame).matrix,
      );
    expect(node.matrix).toEqual([1, 0, 0, 1, 0, 0]);
  } finally {
    native.close();
  }
});

let root: string, app: Application;
beforeEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-repeat-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
const setNodes = async (nodes: Node[]) =>
  app.service.transact([
    { type: 'updateProject', patch: { width: 360, height: 180 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: { background: 'transparent', duration: 60, nodes },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 60,
        tracks: [
          {
            id: 'visual',
            name: 'pattern',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'pattern',
                sceneId: 'intro',
                start: 0,
                duration: 60,
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
it('integration: native rendering, selection and masks share affine transforms', async () => {
  await setNodes([
    newNode({
      id: 'paint',
      type: 'rect',
      x: 20,
      y: 20,
      width: 40,
      height: 30,
      fill: '#fff',
      matrix: [1, 0, 0.5, 1, 0, 0],
      maskId: 'matte',
    }),
    newNode({
      id: 'matte',
      type: 'rect',
      x: 20,
      y: 20,
      width: 20,
      height: 30,
      fill: '#fff',
      matrix: [1, 0, 0.5, 1, 0, 0],
    }),
  ]);
  const c = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' }),
    ctx = c.getContext('2d');
  expect(ctx.getImageData(37, 35, 1, 1).data[3]).toBe(255);
  expect(ctx.getImageData(57, 35, 1, 1).data[3]).toBe(0);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0),
    layer = graph.layers.find((n) => n.node.id === 'paint')!;
  expect(layer.matrix).toEqual([1, 0, 0.5, 1, 20, 20]);
  expect(hitLayer(layer, { x: 65, y: 45 })).toBe(true);
  expect(hitLayer(layer, { x: 22, y: 45 })).toBe(false);
}, 30000);
it('integration: creation can read temporarily transparent layers and their external masks without changing selection rules', async () => {
  await setNodes([
    newNode({
      id: 'paint',
      type: 'rect',
      x: 20,
      y: 30,
      width: 40,
      height: 20,
      fill: '#fff',
      opacity: 0,
      maskId: 'mask',
      animations: [
        {
          property: 'opacity',
          keys: [
            { frame: 0, value: 0, easing: 'hold' },
            { frame: 30, value: 1, easing: 'linear' },
          ],
        },
      ],
    }),
    newNode({ id: 'mask', type: 'rect', x: 20, y: 30, width: 20, height: 20, fill: '#fff' }),
  ]);
  const before = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0);
  expect(before.layers).toHaveLength(0);
  const made = await app.dispatch('repeatCreate', {
    sceneId: 'intro',
    nodeIds: ['paint', 'mask'],
    id: 'r',
    hideSources: true,
    parameters: { count: 2, position: { x: 60, y: 0 } },
  });
  expect(made.repeater.sourceNodes).toBe(2);
  const canvas = await app.renderer.render(app.service.snapshot, 30, { sceneId: 'intro' }),
    ctx = canvas.getContext('2d');
  expect(ctx.getImageData(25, 35, 1, 1).data[3]).toBe(255);
  expect(ctx.getImageData(45, 35, 1, 1).data[3]).toBe(0);
  expect(ctx.getImageData(85, 35, 1, 1).data[3]).toBe(255);
}, 30000);
it('integration: repeater creation is atomic, parameter-editable and retains source/native animation', async () => {
  await setNodes([
    newNode({
      id: 'dot',
      type: 'rect',
      x: 20,
      y: 30,
      width: 20,
      height: 20,
      fill: '#fff',
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 20, easing: 'linear' },
            { frame: 30, value: 30, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const before = app.service.snapshot.revision;
  const result = await app
    .dispatch('repeatCreate', {
      sceneId: 'intro',
      nodeIds: ['dot'],
      id: 'repeat',
      hideSources: true,
      parameters: { count: 3, position: { x: 60, y: 0 } },
    })
    .catch((e) => {
      throw new Error(JSON.stringify(e.details));
    });
  expect(result.selection).toEqual(['repeat']);
  expect(app.service.snapshot.scenes[0].nodes[0].visible).toBe(false);
  const file = result.repeater.sourceFile;
  expect(await readFile(path.join(root, file), 'utf8')).toContain('repeatGraph');
  const component = await app.dispatch('componentParameters', {
    sceneId: 'intro',
    nodeId: 'repeat',
  });
  expect(component.values.count).toBe(3);
  expect(component.channels.some((c: { path: string }) => c.path === 'rotation')).toBe(true);
  const frame = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' }),
    ctx = frame.getContext('2d');
  for (const x of [25, 85, 145]) expect(ctx.getImageData(x, 35, 1, 1).data[3]).toBe(255);
  const later = await app.renderer.render(app.service.snapshot, 30, { sceneId: 'intro' });
  expect(later.getContext('2d').getImageData(25, 35, 1, 1).data[3]).toBe(0);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files[file]).toBeUndefined();
  await app.service.redo();
  expect(app.service.snapshot.files[file]).toContain('repeatGraph');
}, 30000);
it('integration: generated-source repeaters allow persistent per-copy overrides without editing originals', async () => {
  const file = 'components/dots.ts',
    content = `import {defineComponent,ellipse} from '@vmotion/sdk';export default defineComponent({name:'Dots',parameters:{},render:()=>[ellipse('dot',{x:40,y:30,width:12,height:12,fill:'#fff'})]});`;
  await app.service.transact([{ type: 'writeSource', path: file, content }]);
  await setNodes([newNode({ id: 'source', type: 'component', component: file })]);
  const original = await readFile(path.join(root, file), 'utf8');
  const made = await app
    .dispatch('repeatCreate', {
      sceneId: 'intro',
      path: ['source'],
      nodeIds: ['source/dot'],
      id: 'r',
      hideSources: true,
      parameters: { count: 3, position: { x: 30, y: 0 } },
    })
    .catch((e) => {
      throw new Error(JSON.stringify(e.details));
    });
  expect(made.selection).toEqual(['source/r']);
  await app.dispatch('compositionTransactBatch', {
    sceneId: 'intro',
    frame: 0,
    edits: [
      {
        path: ['source', 'source/r'],
        nodeId: 'source/r/copies/copy-1/dot',
        patch: { fill: '#ff0000' },
      },
    ],
  });
  expect(app.service.snapshot.scenes[0].nodes[0].overrides['r/copies/copy-1/dot'].fill).toBe(
    '#ff0000',
  );
  expect(await readFile(path.join(root, file), 'utf8')).toBe(original);
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    path: ['source'],
    nodeId: 'source/r',
    updates: [{ path: 'count', value: 4 }],
  });
  const graph = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, [
    'source',
    'source/r',
  ]);
  expect(graph.scene.nodes.find((n) => n.id === 'source/r/copies/copy-1/dot')?.fill).toBe(
    '#ff0000',
  );
}, 30000);
it('integration: invalid expansion leaves no new source, and PNG export matches arbitrary preview seeks', async () => {
  await setNodes([
    newNode({ id: 'dot', type: 'ellipse', x: 30, y: 40, width: 16, height: 16, fill: '#fff' }),
  ]);
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('repeatCreate', {
      sceneId: 'intro',
      nodeIds: ['dot'],
      parameters: { count: 100, scale: { x: 100, y: 1 } },
    }),
  ).rejects.toThrow();
  expect(app.service.snapshot.revision).toBe(before);
  expect(Object.keys(app.service.snapshot.files).some((f) => f.includes('repeater-'))).toBe(false);
  await app.dispatch('repeatCreate', {
    sceneId: 'intro',
    nodeIds: ['dot'],
    id: 'r',
    hideSources: true,
    parameters: { count: 3, position: { x: 30, y: 0 } },
  });
  await app.dispatch('animationEdit', {
    sceneId: 'intro',
    edits: [
      {
        nodeId: 'r',
        actions: [
          {
            type: 'upsert',
            property: 'params.rotation',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 3, value: 30, easing: 'linear' },
            ],
          },
        ],
      },
    ],
  });
  const output = path.join(root, 'exports'),
    job = app.renders.start(app.service.snapshot, { output, format: 'png', end: 3 });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  for (const at of [2, 0, 1])
    expect(
      (await readFile(path.join(output, `frame-${String(at).padStart(8, '0')}.png`))).equals(
        (await app.frame({ frame: at })).buffer,
      ),
    ).toBe(true);
}, 30000);
