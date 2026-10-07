import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
import { newNode, type Snapshot } from '../src/core/model.js';
import { motionBlur, echo } from '../src/sdk/post.js';
import { TemporalPixels } from '../src/core/temporal-effect.js';
let root: string, snapshot: Snapshot, renderer: Renderer;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-layer-time-'));
  await initProject(root, 'time', { template: 'blank', width: 160, height: 90 });
  snapshot = await loadProject(root);
  snapshot.scenes[0].background = 'transparent';
  renderer = new Renderer(root);
});
afterEach(async () => {
  await renderer.close();
  await rm(root, { recursive: true, force: true });
});
const pixels = async (frame: number, options = { sceneId: 'intro' }) =>
  (await renderer.render(snapshot, frame, options)).getContext('2d').getImageData(0, 0, 160, 90)
    .data;
const pixel = (data: Uint8ClampedArray, x: number, y = 25) =>
  Array.from(data.subarray((y * 160 + x) * 4, (y * 160 + x) * 4 + 4));
const moving = (effects: any[]) =>
  newNode({
    id: 'moving',
    type: 'rect',
    x: 0,
    y: 20,
    width: 10,
    height: 20,
    fill: '#ff0000',
    effects,
    animations: [
      {
        property: 'x',
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 30, value: 120, easing: 'linear' },
        ],
      },
    ],
  });
it('samples only the requested layer with linear premultiplied alpha and keeps static/unrelated layers exact', async () => {
  snapshot.scenes[0].nodes = [
    moving([]),
    newNode({ id: 'still', type: 'rect', x: 100, y: 20, width: 20, height: 20, fill: '#1281cf' }),
  ];
  const original = await pixels(10);
  snapshot.scenes[0].nodes[0].effects = [motionBlur({ samples: 8, shutterAngle: 360 })];
  const result = await pixels(10);
  expect(pixel(result, 39)[3]).toBeGreaterThan(0);
  expect(pixel(result, 39)[3]).toBeLessThan(255);
  expect(pixel(result, 45)).toEqual([255, 0, 0, 255]);
  expect(pixel(result, 110)).toEqual(pixel(original, 110));
  snapshot.scenes[0].nodes[0].animations = [];
  snapshot.scenes[0].nodes[0].x = 40;
  const blurred = await pixels(10);
  snapshot.scenes[0].nodes[0].effects = [];
  expect(await pixels(10)).toEqual(blurred);
});
it('re-evaluates TypeScript generated motion while seeking, including focused composition previews', async () => {
  snapshot.files['components/time.ts'] =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'Time',parameters:{},render(ctx){return [node({id:'shape',type:'rect',x:ctx.frame*4,y:20,width:10,height:20,fill:'#ff0000',effects:[{type:'motionBlur',samples:8,shutterAngle:360}]})]}});";
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'component',
      type: 'component',
      component: 'components/time.ts',
      width: 160,
      height: 90,
    }),
  ];
  const result = await pixels(10);
  expect(pixel(result, 39)[3]).toBeGreaterThan(0);
  await pixels(2);
  expect(await pixels(10)).toEqual(result);
  const focus = await pixels(10, { sceneId: 'intro', path: ['component'] } as any);
  expect(focus).toEqual(result);
});
it('echoes historical poses and opacity, skips negative births, and zero/disabled strength is exact', async () => {
  snapshot.scenes[0].nodes = [moving([echo({ count: 3, spacing: 2, decay: 0.5, strength: 1 })])];
  const result = await pixels(10);
  expect(pixel(result, 24)[3]).toBeCloseTo(64, 0);
  expect(pixel(result, 32)[3]).toBeGreaterThan(100);
  expect(pixel(result, 45)[3]).toBe(255);
  const first = await pixels(0);
  expect(pixel(first, 0)[3]).toBe(255);
  expect(pixel(first, 20)[3]).toBe(0);
  snapshot.scenes[0].nodes[0].effects = [];
  const original = await pixels(10);
  for (const effect of [
    echo({ strength: 0 }),
    echo({ decay: 0 }),
    motionBlur({ shutterAngle: 0 }),
    { ...echo(), enabled: false },
  ]) {
    snapshot.scenes[0].nodes[0].effects = [effect];
    expect(await pixels(10)).toEqual(original);
  }
});
it('averages changing opacity rather than multiplying by current opacity twice and masks historical poses once', async () => {
  const node = moving([motionBlur({ samples: 8, shutterAngle: 360 })]);
  node.animations.push({
    property: 'opacity',
    keys: [
      { frame: 0, value: 0, easing: 'linear' },
      { frame: 20, value: 1, easing: 'linear' },
    ],
  });
  snapshot.scenes[0].nodes = [node];
  expect(Math.abs(pixel(await pixels(10), 45)[3] - 128)).toBeLessThanOrEqual(1);
  node.opacity = 0.5;
  node.animations = node.animations.filter((animation) => animation.property === 'x');
  node.maskId = 'mask';
  snapshot.scenes[0].nodes.push(
    newNode({
      id: 'mask',
      type: 'rect',
      x: 0,
      y: 0,
      width: 160,
      height: 90,
      fill: '#fff',
      opacity: 0.5,
    }),
  );
  expect(Math.abs(pixel(await pixels(10), 45)[3] - 64)).toBeLessThanOrEqual(1);
});
it('keeps linear-light color mixing and clear transparent edges for additive/screen modes', () => {
  const average = new TemporalPixels(4, 'average');
  average.add(new Uint8ClampedArray([255, 0, 0, 255]), 0.5);
  average.add(new Uint8ClampedArray([0, 0, 255, 255]), 0.5);
  expect(Array.from(average.finish())).toEqual([188, 0, 188, 255]);
  const add = new TemporalPixels(4, 'add');
  add.add(new Uint8ClampedArray([255, 0, 0, 128]), 1);
  add.add(new Uint8ClampedArray([0, 0, 255, 127]), 1);
  expect(add.finish()[3]).toBe(255);
  expect(add.finish()[0]).toBeGreaterThan(180);
});
it('applies effects before and after time sampling in stack order and includes vanished generated births', async () => {
  snapshot.files['components/birth.ts'] =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'birth',parameters:{},render(ctx){return [node({id:'echo',type:'group',width:160,height:90,effects:[{type:'echo',count:4,spacing:1,decay:.5,strength:1}]}),...(ctx.frame<10?[node({id:'dot',parentId:'echo',type:'rect',x:ctx.frame*4,y:20,width:10,height:20,fill:'#ff0000'})]:[])]}});";
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'component',
      type: 'component',
      component: 'components/birth.ts',
      width: 160,
      height: 90,
    }),
  ];
  const result = await pixels(10);
  expect(pixel(result, 36)[3]).toBeGreaterThan(0);
  snapshot.scenes[0].nodes = [
    moving([
      echo({ count: 3, spacing: 2, decay: 0.5, strength: 1 }),
      { type: 'color', brightness: 0, saturation: 1, contrast: 1, hue: 0 },
    ]),
  ];
  const dark = await pixels(10);
  expect(pixel(dark, 24)).toEqual([0, 0, 0, 64]);
});
it('rejects explosive nested temporal work and releases surfaces for the next frame', async () => {
  snapshot.scenes[0].nodes = [
    moving([echo({ count: 32, spacing: 0.01 }), motionBlur({ samples: 32 })]),
  ];
  await expect(pixels(10)).rejects.toMatchObject({ code: 'TEMPORAL_BUDGET' });
  snapshot.scenes[0].nodes[0].effects = [];
  expect(pixel(await pixels(10), 45)).toEqual([255, 0, 0, 255]);
});
it('time-samples component parameters on a linear parent clock as well as ctx.frame', async () => {
  snapshot.files['components/params.ts'] =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'params',parameters:{x:{type:'number',default:0}},render(ctx,params){return [node({id:'box',type:'rect',x:params.x,y:20,width:10,height:20,fill:'#ff0000',effects:[{type:'motionBlur',samples:8,shutterAngle:360}]})]}});";
  snapshot.scenes[0].nodes = [
    newNode({
      id: 'component',
      type: 'component',
      component: 'components/params.ts',
      params: { x: 0 },
      width: 160,
      height: 90,
      animations: [
        {
          property: 'params.x',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 30, value: 120, easing: 'linear' },
          ],
        },
      ],
    }),
  ];
  expect(pixel(await pixels(10), 39)[3]).toBeGreaterThan(0);
});
