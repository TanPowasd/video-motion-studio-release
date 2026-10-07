import { beforeEach, afterEach, it, expect } from 'vitest';
import { Path2D, createCanvas } from '@napi-rs/canvas';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  booleanPath,
  trimPath,
  outlinePath,
  pathGeometry,
  shapePath,
  shapeBounds,
  trimNativePath,
} from '../src/core/vector.js';
import { newNode, type Node } from '../src/core/model.js';
import { evaluateNode } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';

const a = 'M0 0H100V100H0Z',
  b = 'M50 0H150V100H50Z';
function alpha(svg: string, x: number, y: number) {
  const canvas = createCanvas(180, 120),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fill(new Path2D(svg));
  return ctx.getImageData(x, y, 1, 1).data[3];
}
it('native boolean operations preserve holes and operand ordering after SVG serialization', () => {
  for (const [operation, expected] of [
    ['union', [255, 255, 255]],
    ['intersect', [0, 255, 0]],
    ['difference', [255, 0, 0]],
    ['xor', [255, 0, 255]],
    ['reverseDifference', [0, 0, 255]],
  ] as const) {
    const svg = booleanPath([a, b], operation);
    expect([alpha(svg, 25, 50), alpha(svg, 75, 50), alpha(svg, 125, 50)]).toEqual(expected);
  }
  const hole = booleanPath([a, 'M25 25H75V75H25Z'], 'difference');
  expect(alpha(hole, 50, 50)).toBe(0);
  expect(alpha(hole, 10, 10)).toBe(255);
  const evenodd = pathGeometry({ paths: [{ path: a + 'M25 25H75V75H25Z', fillRule: 'evenodd' }] });
  expect(alpha(evenodd.path, 50, 50)).toBe(0);
});
it('trim wraps offsets and uses cumulative length across unequal contours without mutating inputs', () => {
  const source = new Path2D('M0 0L100 0'),
    before = source.toSVGString();
  const wrapped = trimNativePath(source, { start: 0.75, end: 0.25, offset: 0 });
  expect(wrapped.toSVGString()).toBe('M75 0L100 0M0 0L25 0');
  expect(source.toSVGString()).toBe(before);
  expect(trimPath(before, { start: 0.25, end: 0.75, offset: 0.5 })).toBe(wrapped.toSVGString());
  expect(trimPath(before, { start: 0.25, end: 0.75, offset: -0.5 })).toBe(wrapped.toSVGString());
  expect(trimPath(before, { start: 0, end: 1, offset: 2.5 })).toBe(before);
  expect(trimPath(before, { start: 0.5, end: 0.5 })).toBe('');
  expect(trimPath('M0 0L100 0M0 100L300 100', { start: 0.25, end: 0.75 })).toBe('M0 100L200 100');
  expect(
    pathGeometry({ paths: [{ path: before }], operation: 'trim', trim: { start: 0.25, end: 0.75 } })
      .bounds,
  ).toEqual({ x: 25, y: 0, width: 50, height: 0 });
});
it('solid outlines respect caps and tight bounds include actual miter extents', () => {
  const outlined = pathGeometry({
    paths: [{ path: 'M10 40L90 40' }],
    operation: 'outline',
    stroke: { width: 10, cap: 'square' },
  });
  expect(outlined.bounds).toEqual({ x: 5, y: 35, width: 90, height: 10 });
  expect(alpha(outlinePath('M10 40L90 40', { width: 10, cap: 'round' }), 7, 40)).toBe(255);
  const node = newNode({
    id: 'acute',
    type: 'path',
    path: 'M10 90L50 10L90 90',
    fill: 'transparent',
    stroke: '#fff',
    strokeWidth: 20,
    strokeJoin: 'miter',
    strokeMiterLimit: 10,
  });
  expect(shapeBounds(node).y).toBeLessThan(-10);
  expect(shapeBounds({ ...node, strokeJoin: 'bevel' }).y).toBeGreaterThan(0);
  expect(shapeBounds({ ...node, pathTrim: { start: 0, end: 0, offset: 0 } }).width).toBe(0);
});
it('reports invalid geometry and operand counts without silently replacing it', () => {
  expect(() => pathGeometry({ paths: [{ path: 'not SVG' }] })).toThrow('Invalid SVG');
  expect(() => booleanPath([a], 'union')).toThrow('require');
  expect(() => pathGeometry({ paths: [{ path: a }, { path: b }], operation: 'outline' })).toThrow(
    'one path',
  );
  expect(() => newNode({ id: 'bad', type: 'path', strokeDash: [0, 0] })).toThrow();
  expect(pathGeometry({ paths: [{ path: '' }] }).empty).toBe(true);
});
it('rounded and simplified geometry keeps interiors while changing corner contours', () => {
  const rounded = pathGeometry({
    paths: [{ path: 'M10 10H100V100H10Z' }],
    operation: 'round',
    radius: 16,
  });
  expect(rounded.path).not.toBe('M10 10H100V100H10Z');
  expect(alpha(rounded.path, 11, 11)).toBe(0);
  expect(alpha(rounded.path, 50, 50)).toBe(255);
  const simplified = pathGeometry({
    paths: [{ path: 'M10 10L100 100L10 100L100 10Z' }],
    operation: 'simplify',
  });
  expect(alpha(simplified.path, 50, 25)).toBe(255);
  expect(alpha(simplified.path, 15, 50)).toBe(0);
});
it('Rust and TypeScript evaluate trim, dash and stroke channels identically in random order', async () => {
  const node = newNode({
      id: 'animated',
      type: 'path',
      path: 'M0 0H100',
      strokeDash: [10, 8],
      animations: [
        'pathTrim.start',
        'pathTrim.end',
        'pathTrim.offset',
        'strokeDashOffset',
        'strokeWidth',
        'strokeDash.1',
      ].map((property) => ({
        property,
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 60, value: property === 'strokeDashOffset' ? 30 : 1, easing: 'linear' },
        ],
      })),
    }),
    native = new NativeEvaluator();
  try {
    for (const frame of [60, 0, 30, 59, 15, 30]) {
      const actual = (await native.evaluate([node], frame))[0],
        expected = evaluateNode(node, frame);
      for (const key of ['pathTrim', 'strokeDash', 'strokeDashOffset', 'strokeWidth'] as const)
        expect(actual[key]).toEqual(expected[key]);
    }
    expect(node.pathTrim).toEqual({ start: 0, end: 1, offset: 0 });
    expect(node.strokeDash).toEqual([10, 8]);
  } finally {
    native.close();
  }
});

let root: string, app: Application;
beforeEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-vector-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
async function setNodes(nodes: Node[]) {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 180, height: 120 } },
    { type: 'updateScene', sceneId: 'intro', patch: { background: 'transparent', nodes } },
  ]);
}
it('integration: renderer and picking share trim geometry; dash phase survives random seeks', async () => {
  await setNodes([
    newNode({
      id: 'dash',
      type: 'path',
      path: 'M10 40H150',
      fill: 'transparent',
      stroke: '#ffffff',
      strokeWidth: 8,
      strokeCap: 'butt',
      strokeDash: [10, 10],
      pathTrim: { start: 0, end: 0.5, offset: 0 },
      animations: [
        {
          property: 'strokeDashOffset',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 30, value: 10, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const render = async (frame: number) =>
    app.renderer.render(app.service.snapshot, frame, { sceneId: 'intro' });
  const first = await render(0),
    ctx = first.getContext('2d');
  expect(ctx.getImageData(15, 40, 1, 1).data[3]).toBe(255);
  expect(ctx.getImageData(25, 40, 1, 1).data[3]).toBe(0);
  expect(ctx.getImageData(95, 40, 1, 1).data[3]).toBe(0);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0, []);
  expect(graph.layers[0].bounds).toEqual({ x: 10, y: 36, width: 70, height: 8 });
  const later = await render(30);
  expect(later.getContext('2d').getImageData(15, 40, 1, 1).data[3]).toBe(0);
  expect((await first.encode('png')).equals(await (await render(0)).encode('png'))).toBe(true);
}, 30000);
it('integration: sibling path baking preserves transformed sources with a single undo step', async () => {
  await setNodes([
    newNode({ id: 'a', type: 'rect', x: 10, y: 10, width: 80, height: 80, fill: '#fff' }),
    newNode({ id: 'b', type: 'rect', x: 50, y: 10, width: 80, height: 80, fill: '#fff' }),
  ]);
  const revision = app.service.snapshot.revision;
  const baked = await app.dispatch('vectorBake', {
    sceneId: 'intro',
    nodeIds: ['a', 'b'],
    operation: 'difference',
    id: 'result',
    hideSources: true,
    revision,
  });
  const nodes = app.service.snapshot.scenes[0].nodes;
  expect(baked.selection).toEqual(['result']);
  expect(nodes.slice(0, 2).every((n) => !n.visible)).toBe(true);
  expect(nodes[2].path).toBeTruthy();
  expect(baked.geometry.bounds).toEqual({ x: 10, y: 10, width: 40, height: 80 });
  const c = await app.renderer.render(app.service.snapshot, 0, { sceneId: 'intro' });
  expect(c.getContext('2d').getImageData(30, 40, 1, 1).data[3]).toBe(255);
  expect(c.getContext('2d').getImageData(70, 40, 1, 1).data[3]).toBe(0);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes).toHaveLength(2);
  await expect(
    app.dispatch('vectorBake', {
      sceneId: 'intro',
      nodeIds: ['a', 'b'],
      operation: 'union',
      revision: 'stale',
    }),
  ).rejects.toThrow('changed');
}, 30000);
it('integration: baking generated vectors persists structure and visibility overrides without touching code', async () => {
  const source = 'components/shapes.ts',
    content = `import {defineComponent,rect,ellipse} from '@vmotion/sdk';
    export default defineComponent({name:'Shapes',parameters:{},render:()=>[
      rect('a',{x:10,y:10,width:80,height:80,fill:'#ffffff'}),
      ellipse('b',{x:50,y:10,width:80,height:80,fill:'#ffffff'})]});`;
  await app.service.transact([{ type: 'writeSource', path: source, content }]).catch((e) => {
    throw new Error(JSON.stringify(e.details));
  });
  await setNodes([newNode({ id: 'shapes', type: 'component', component: source })]);
  const original = await readFile(path.join(root, source), 'utf8'),
    revision = app.service.snapshot.revision;
  const baked = await app
    .dispatch('vectorBake', {
      sceneId: 'intro',
      path: ['shapes'],
      nodeIds: ['shapes/a', 'shapes/b'],
      operation: 'union',
      hideSources: true,
      id: 'result',
    })
    .catch((e) => {
      throw new Error(JSON.stringify(e.details));
    });
  expect(baked.selection).toEqual(['shapes/result']);
  const owner = app.service.snapshot.scenes[0].nodes[0];
  expect(owner.structure?.added[0].id).toBe('result');
  expect(owner.overrides.a.visible).toBe(false);
  expect(await readFile(path.join(root, source), 'utf8')).toBe(original);
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
  expect(app.service.snapshot.scenes[0].nodes[0].structure).toBeUndefined();
}, 30000);
it('integration: invalid path transactions keep the active project and PNG export matches preview pixels', async () => {
  await setNodes([
    newNode({
      id: 'circle',
      type: 'ellipse',
      x: 20,
      y: 20,
      width: 80,
      height: 80,
      fill: 'transparent',
      stroke: '#fff',
      strokeWidth: 8,
      strokeCap: 'round',
      strokeDash: [10, 4],
      animations: [
        {
          property: 'pathTrim.end',
          keys: [
            { frame: 0, value: 0.15, easing: 'linear' },
            { frame: 3, value: 0.75, easing: 'linear' },
          ],
        },
      ],
    }),
  ]);
  const revision = app.service.snapshot.revision;
  await expect(
    app.service.transact([
      {
        type: 'addNode',
        sceneId: 'intro',
        node: newNode({ id: 'bad', type: 'path', path: 'not SVG' }),
      },
    ]),
  ).rejects.toThrow('validation');
  expect(app.service.snapshot.revision).toBe(revision);
  const output = path.join(root, 'export');
  const job = app.renders.start(app.service.snapshot, { output, format: 'png', start: 0, end: 3 });
  const done = await app.renders.wait(job.id);
  expect(done.status).toBe('completed');
  for (const frame of [2, 0, 1]) {
    const exported = await readFile(
      path.join(output, `frame-${String(frame).padStart(8, '0')}.png`),
    );
    const preview = await app.frame({ frame });
    expect(exported.equals(preview.buffer)).toBe(true);
  }
}, 30000);
