import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
import { newNode, type Node, type Snapshot } from '../src/core/model.js';
import { group, linearGradient, glow, particles, project3D } from '../src/sdk/effects.js';
import { spring, progress, followPath, morphPoints } from '../src/sdk/motion.js';
let root: string, renderer: Renderer, snapshot: Snapshot;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-fx-'));
  await initProject(root);
  snapshot = await loadProject(root);
  snapshot.project.width = 160;
  snapshot.project.height = 90;
  snapshot.scenes[0].background = 'transparent';
  renderer = new Renderer(root);
});
afterEach(async () => {
  await renderer.close();
  await rm(root, { recursive: true, force: true });
});
async function draw(nodes: Node[], frame = 60, width = 160, height = 90) {
  snapshot.scenes[0].nodes = nodes;
  return renderer.render(snapshot, frame, { sceneId: 'intro', width, height });
}
it('applies group opacity once to overlapping children', async () => {
  const canvas = await draw(
    group(
      'fade',
      [
        newNode({ id: 'a', type: 'rect', x: 10, y: 10, width: 40, height: 40, fill: '#ff0000' }),
        newNode({ id: 'b', type: 'rect', x: 30, y: 10, width: 40, height: 40, fill: '#ff0000' }),
      ],
      { opacity: 0.5 },
    ),
  );
  const ctx = canvas.getContext('2d');
  expect(ctx.getImageData(20, 20, 1, 1).data[3]).toBeCloseTo(128, 0);
  expect(ctx.getImageData(40, 20, 1, 1).data[3]).toBeCloseTo(128, 0);
});
it('evaluates gradients in local coordinates under transforms', async () => {
  const canvas = await draw([
    newNode({
      id: 'ramp',
      type: 'rect',
      x: 20,
      y: 10,
      width: 100,
      height: 40,
      gradient: linearGradient({ x: 0, y: 0 }, { x: 100, y: 0 }, ['#ff0000', '#0000ff']),
    }),
  ]);
  const ctx = canvas.getContext('2d'),
    left = ctx.getImageData(25, 20, 1, 1).data,
    right = ctx.getImageData(115, 20, 1, 1).data;
  expect(left[0]).toBeGreaterThan(left[2]);
  expect(right[2]).toBeGreaterThan(right[0]);
});
it('creates a glow outside the shape and preserves its sharp center', async () => {
  const canvas = await draw([
    newNode({
      id: 'light',
      type: 'ellipse',
      x: 60,
      y: 25,
      width: 20,
      height: 20,
      fill: '#ffffff',
      effects: [glow('#4599ff', 9, 1)],
    }),
  ]);
  const ctx = canvas.getContext('2d');
  expect(ctx.getImageData(70, 35, 1, 1).data[3]).toBe(255);
  expect(ctx.getImageData(54, 35, 1, 1).data[3]).toBeGreaterThan(0);
});
it('executes effects in their declared order', async () => {
  const node = newNode({
    id: 'graded',
    type: 'rect',
    x: 40,
    y: 20,
    width: 60,
    height: 40,
    fill: '#ff0000',
    effects: [
      { type: 'color', brightness: 1, contrast: 1, saturation: 0, hue: 0 },
      glow('#0066ff', 8, 1, 0),
    ],
  });
  const after = await draw([node]),
    before = await draw([
      {
        ...node,
        effects: [
          glow('#0066ff', 8, 1, 0),
          { type: 'color', brightness: 1, contrast: 1, saturation: 0, hue: 0 },
        ],
      },
    ]);
  const a = after.getContext('2d').getImageData(35, 35, 1, 1).data,
    b = before.getContext('2d').getImageData(35, 35, 1, 1).data;
  expect(a[2]).toBeGreaterThan(a[0]);
  expect(Math.abs(b[2] - b[0])).toBeLessThan(3);
});
it('renders masks in generated hierarchies at different preview scales', async () => {
  const nodes = group(
    'moving',
    [
      newNode({
        id: 'paint',
        type: 'rect',
        width: 80,
        height: 50,
        fill: '#ff0000',
        maskId: 'mask',
      }),
      newNode({ id: 'mask', type: 'rect', width: 30, height: 50, fill: '#ffffff' }),
    ],
    { x: 20, y: 10 },
  );
  const canvas = await draw(nodes, 60, 320, 180),
    ctx = canvas.getContext('2d');
  expect(ctx.getImageData(60, 40, 1, 1).data[3]).toBe(255);
  expect(ctx.getImageData(120, 40, 1, 1).data[3]).toBe(0);
});
it('pins imported component JSON to the captured source revision', async () => {
  const source =
    "import data from './palette.json'; export default {name:'Pinned',parameters:{},render(){return [{id:'color',type:'rect',width:160,height:90,fill:data.color}];}}";
  await writeFile(path.join(root, 'components/palette.ts'), source);
  await writeFile(path.join(root, 'components/palette.json'), '{"color":"#0000ff"}');
  snapshot.files['components/palette.ts'] = source;
  snapshot.files['components/palette.json'] = '{"color":"#ff0000"}';
  const canvas = await draw([
      newNode({
        id: 'pinned',
        type: 'component',
        component: 'components/palette.ts',
        width: 160,
        height: 90,
      }),
    ]),
    pixel = canvas.getContext('2d').getImageData(80, 45, 1, 1).data;
  expect(pixel[0]).toBe(255);
  expect(pixel[2]).toBe(0);
});
it('fails clearly for cyclic generated hierarchy', async () => {
  await expect(
    draw([
      newNode({ id: 'a', type: 'group', parentId: 'b' }),
      newNode({ id: 'b', type: 'group', parentId: 'a' }),
    ]),
  ).rejects.toThrow('parent cycle');
});
it('reveals Unicode text deterministically by measured grapheme positions', async () => {
  const nodes = [
    newNode({
      id: 'title',
      type: 'text',
      text: '动画🙂',
      x: 8,
      y: 15,
      width: 150,
      height: 60,
      fontSize: 24,
      fill: '#ffffff',
      textMotion: {
        unit: 'grapheme',
        start: 0,
        duration: 15,
        stagger: 8,
        offsetX: 0,
        offsetY: 12,
        rotation: 0,
        scale: 0.9,
      },
    }),
  ];
  const empty = await draw(nodes, 0),
    visible = await draw(nodes, 45);
  expect(
    empty
      .getContext('2d')
      .getImageData(0, 0, 160, 90)
      .data.every((v) => v === 0),
  ).toBe(true);
  expect(
    visible
      .getContext('2d')
      .getImageData(0, 0, 160, 90)
      .data.some((v) => v > 0),
  ).toBe(true);
  const again = await draw(nodes, 45);
  expect((await visible.encode('png')).equals(await again.encode('png'))).toBe(true);
});
it('keeps procedural particles independent of evaluation order', () => {
  const ctx = { frame: 120, seconds: 4, fps: 30, width: 160, height: 90, seed: 77 },
    a = particles('dust', ctx, { count: 30 });
  particles('dust', { ...ctx, frame: 0, seconds: 0 }, { count: 30 });
  expect(particles('dust', ctx, { count: 30 })).toEqual(a);
  expect(particles('dust', { ...ctx, seed: 78 }, { count: 30 })).not.toEqual(a);
});
it('provides physical springs, repeat timing, arc-length paths and camera projection', () => {
  for (const damping of [8, 26.0768096208, 40]) {
    expect(spring({ frame: 0, fps: 30 }, { damping })).toBeCloseTo(0);
    expect(spring({ frame: 900, fps: 30 }, { damping })).toBeCloseTo(1);
  }
  expect(
    progress({ frame: 45, fps: 30 }, { duration: 30, loop: true, yoyo: true, easing: (t) => t }),
  ).toBe(0.5);
  expect(
    followPath(
      [
        { x: 0, y: 0 },
        { x: 100, y: 0 },
        { x: 100, y: 10 },
      ],
      0.5,
    ).x,
  ).toBeCloseTo(55);
  expect(
    morphPoints(
      [
        { x: 0, y: 0 },
        { x: 1, y: 1 },
      ],
      [
        { x: 2, y: 2 },
        { x: 3, y: 3 },
      ],
      0.5,
    )[0],
  ).toEqual({ x: 1, y: 1 });
  const camera = {
    position: { x: 0, y: 0, z: 10 },
    target: { x: 0, y: 0, z: 0 },
    width: 160,
    height: 90,
  };
  expect(project3D({ x: 0, y: 0, z: 0 }, camera)).toMatchObject({ x: 80, y: 45, visible: true });
  expect(project3D({ x: 0, y: 0, z: 20 }, camera).visible).toBe(false);
});
