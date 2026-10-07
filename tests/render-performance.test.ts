import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { applyOperations } from '../src/service/operations.js';
import { SurfacePool } from '../src/core/surface-pool.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-performance-'));
  await initProject(root, 'performance', {
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
const source =
  "import {defineComponent,rect} from '@vmotion/sdk';import values from './data.json';export default defineComponent({name:'dependency',parameters:{},render(){return [rect('value',{x:values.x,width:80,height:40})]}});";
it('reuses matching dependencies, invalidates changed imports, and keeps snapshot source untouched', async () => {
  await app.service.transact([
    { type: 'writeSource', path: 'components/live.ts', content: source },
    { type: 'writeSource', path: 'components/data.json', content: '{"x":10}' },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'live', type: 'component', component: 'components/live.ts' },
    },
  ]);
  const snapshot = app.service.snapshot,
    first = await app.renderer.generatedNodes(snapshot, snapshot.scenes[0].nodes[0], 0),
    count = app.renderer.components.stats.compiles;
  const unrelated = applyOperations(root, snapshot, [
    { type: 'writeSource', path: 'components/unrelated.json', content: '{"value":42}' },
  ]);
  await app.renderer.generatedNodes(unrelated, unrelated.scenes[0].nodes[0], 0);
  expect(app.renderer.components.stats.compiles).toBe(count);
  const edited = applyOperations(root, unrelated, [
      { type: 'writeSource', path: 'components/data.json', content: '{"x":75}' },
    ]),
    second = await app.renderer.generatedNodes(edited, edited.scenes[0].nodes[0], 0);
  expect(app.renderer.components.stats.compiles).toBe(count + 1);
  expect(first[0].x).toBe(10);
  expect(second[0].x).toBe(75);
  expect(snapshot.files['components/data.json']).toBe('{"x":10}');
});
it('invalidates type diagnostics for imported JSON and missing directory/file resolution', async () => {
  const snapshot = applyOperations(root, app.service.snapshot, [
    { type: 'writeSource', path: 'components/live.ts', content: source },
    { type: 'writeSource', path: 'components/data.json', content: '{"x":10}' },
  ]);
  expect(app.renderer.components.typecheck(snapshot)).toEqual([]);
  const wrong = applyOperations(root, snapshot, [
    { type: 'writeSource', path: 'components/data.json', content: '{"x":"wrong"}' },
  ]);
  expect(app.renderer.components.typecheck(wrong).some((d) => d.code === 'TS2322')).toBe(true);
  const missing = applyOperations(root, snapshot, [
    {
      type: 'writeSource',
      path: 'components/missing.ts',
      content: "import data from './later/data.json';const value:number=data.x;",
    },
  ]);
  expect(app.renderer.components.typecheck(missing).some((d) => d.code === 'TS2307')).toBe(true);
  const repaired = applyOperations(root, missing, [
    { type: 'writeSource', path: 'components/later/data.json', content: '{"x":2}' },
  ]);
  expect(app.renderer.components.typecheck(repaired)).toEqual([]);
});
it('resets pixels, transforms, saved clips and styles on pooled reuse and enforces memory bounds', () => {
  const pool = new SurfacePool(64 * 64 * 4),
    first = pool.acquire(64, 64),
    ctx = first.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(0, 0, 64, 64);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, 1, 1);
  ctx.clip();
  ctx.translate(40, 40);
  ctx.globalAlpha = 0.1;
  pool.release(first);
  const next = pool.acquire(64, 64),
    paint = next.getContext('2d');
  expect(paint.getImageData(20, 20, 1, 1).data[3]).toBe(0);
  paint.fillStyle = '#00ff00';
  paint.fillRect(0, 0, 64, 64);
  expect([...paint.getImageData(20, 20, 1, 1).data]).toEqual([0, 255, 0, 255]);
  expect(pool.report().reuses).toBe(1);
  pool.release(next);
  pool.release(pool.acquire(32, 32));
  expect(pool.report().retainedBytes).toBeLessThanOrEqual(64 * 64 * 4);
  pool.clear();
  expect(pool.report().retainedBytes).toBe(0);
});
it('keeps raster output identical across pooled warm/cold rendering with masks and ordered effects', async () => {
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        nodes: [
          newNode({
            id: 'shape',
            type: 'rect',
            x: 40,
            y: 35,
            width: 120,
            height: 60,
            fill: '#88ccff',
            maskId: 'mask',
            effects: [
              { type: 'blur', radius: 3 },
              { type: 'glow', radius: 5, color: '#aa77ff', intensity: 1, threshold: 0.5 },
            ],
          }),
          newNode({
            id: 'mask',
            type: 'ellipse',
            x: 25,
            y: 20,
            width: 140,
            height: 100,
            fill: '#ffffff',
          }),
        ],
      },
    },
  ]);
  const first = await app.renderer.render(app.service.snapshot, 0, { width: 320, height: 180 }),
    pixels = first.getContext('2d').getImageData(0, 0, 320, 180).data;
  const second = await app.renderer.render(app.service.snapshot, 0, { width: 320, height: 180 });
  expect(second.getContext('2d').getImageData(0, 0, 320, 180).data).toEqual(pixels);
  expect(app.renderer.surfaces.report().reuses).toBeGreaterThan(0);
  first.width = 1;
  second.width = 1;
});
