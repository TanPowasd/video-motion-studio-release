import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
import { newNode, type Snapshot } from '../src/core/model.js';
import { chromaKey, displacement } from '../src/sdk/post.js';
let root: string, s: Snapshot, r: Renderer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-composite-'));
  await initProject(root);
  s = await loadProject(root);
  s.project.width = 160;
  s.project.height = 90;
  s.scenes[0].background = 'transparent';
  r = new Renderer(root);
});
afterEach(async () => {
  await r.close();
  await rm(root, { recursive: true, force: true });
});
it('native rendering executes chroma key on a composited group', async () => {
  s.scenes[0].nodes = [
    newNode({ id: 'keyed', type: 'group', effects: [chromaKey()] }),
    newNode({
      id: 'green',
      parentId: 'keyed',
      type: 'rect',
      width: 160,
      height: 90,
      fill: '#00ff00',
    }),
    newNode({
      id: 'subject',
      parentId: 'keyed',
      type: 'rect',
      x: 40,
      y: 20,
      width: 50,
      height: 40,
      fill: '#ff3344',
    }),
  ];
  const canvas = await r.render(s, 0, { sceneId: 'intro' }),
    ctx = canvas.getContext('2d');
  expect(ctx.getImageData(10, 10, 1, 1).data[3]).toBe(0);
  expect(ctx.getImageData(60, 40, 1, 1).data[3]).toBe(255);
});
it('luma and inverted alpha mattes operate in a shared parent space', async () => {
  s.scenes[0].nodes = [
    newNode({
      id: 'target',
      type: 'rect',
      width: 160,
      height: 90,
      fill: '#ffffff',
      maskId: 'matte',
      maskMode: 'luma',
    }),
    newNode({ id: 'matte', type: 'rect', width: 80, height: 90, fill: '#808080' }),
  ];
  let canvas = await r.render(s, 0, { sceneId: 'intro' }),
    ctx = canvas.getContext('2d');
  expect(ctx.getImageData(30, 30, 1, 1).data[3]).toBeCloseTo(55, 0);
  expect(ctx.getImageData(110, 30, 1, 1).data[3]).toBe(0);
  s.scenes[0].nodes[0].maskMode = 'alphaInverted';
  canvas = await r.render(s, 0, { sceneId: 'intro' });
  ctx = canvas.getContext('2d');
  expect(ctx.getImageData(30, 30, 1, 1).data[3]).toBe(0);
  expect(ctx.getImageData(110, 30, 1, 1).data[3]).toBe(255);
});
it('mask feather produces intermediate alpha at the boundary', async () => {
  s.scenes[0].nodes = [
    newNode({
      id: 'target',
      type: 'rect',
      width: 160,
      height: 90,
      fill: '#ffffff',
      maskId: 'matte',
      maskFeather: 6,
    }),
    newNode({ id: 'matte', type: 'rect', width: 80, height: 90, fill: '#ffffff' }),
  ];
  const canvas = await r.render(s, 0, { sceneId: 'intro' }),
    alpha = canvas.getContext('2d').getImageData(80, 40, 1, 1).data[3];
  expect(alpha).toBeGreaterThan(0);
  expect(alpha).toBeLessThan(255);
});
it('changing a native animated distortion channel changes the picture after seeking', async () => {
  s.scenes[0].nodes = [
    newNode({
      id: 'distort',
      type: 'rect',
      x: 50,
      y: 20,
      width: 50,
      height: 50,
      fill: '#99bbff',
      effects: [displacement({ scale: 30, amountX: 14, amountY: 14 })],
      animations: [
        {
          property: 'effects.0.evolution',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 2, easing: 'linear' },
          ],
        },
      ],
    }),
  ];
  const first = await r.render(s, 0, { sceneId: 'intro' }),
    later = await r.render(s, 30, { sceneId: 'intro' }),
    again = await r.render(s, 0, { sceneId: 'intro' });
  expect((await first.encode('png')).equals(await later.encode('png'))).toBe(false);
  expect((await first.encode('png')).equals(await again.encode('png'))).toBe(true);
});
