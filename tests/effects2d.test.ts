import { field, present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { applyPixelEffect } from '../src/core/pixels.js';
import { waveWarp, twirl, bulge, rgbSplit, linearWipe, radialWipe } from '../src/sdk/post.js';
import { newNode, effectSchema } from '../src/core/model.js';
import { editEffectStack } from '../src/core/effect-stack.js';
import { evaluateNode } from '../src/core/time.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { createCanvas, loadImage } from '@napi-rs/canvas';
const options = { frame: 10, fps: 30 },
  pixel = (source: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(source.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
it('keeps wrapped RGB fringes across raster borders inside the bounded-work path', () => {
  const source = new Uint8ClampedArray(8 * 4);
  source.set([255, 255, 255, 255], 0);
  const split = applyPixelEffect(source, 8, 1, rgbSplit({ amountX: 1, edge: 'wrap' }), options);
  expect(pixel(split, 8, 7, 0)).toEqual([255, 0, 0, 255]);
  expect(pixel(split, 8, 1, 0)).toEqual([0, 0, 255, 255]);
});
it('keeps zero-strength spatial effects and wipe endpoints exact, including disabled effects', () => {
  const source = Uint8ClampedArray.from({ length: 16 * 8 * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : i % 256,
  );
  for (const effect of [
    waveWarp({ amountX: 0, amountY: 0 }),
    twirl({ amount: 0 }),
    bulge({ amount: 0 }),
    rgbSplit({ intensity: 0 }),
    linearWipe(1),
    radialWipe(1),
  ])
    expect(applyPixelEffect(source, 16, 8, effect, options)).toEqual(source);
  expect(
    applyPixelEffect(source, 16, 8, effectSchema.parse({ ...twirl(), enabled: false }), options),
  ).toEqual(source);
  expect(applyPixelEffect(source, 16, 8, linearWipe(0), options).every((v) => v === 0)).toBe(true);
});
it('follows translated/rotated layer coordinates and yields the same logical wipe at preview scale', () => {
  const canvas = createCanvas(80, 40),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ff0000';
  ctx.fillRect(30, 10, 20, 10);
  const source = ctx.getImageData(0, 0, 80, 40).data,
    output = applyPixelEffect(source, 80, 40, linearWipe(0.5), {
      ...options,
      matrix: [1, 0, 0, 1, 30, 10],
      bounds: { x: 0, y: 0, width: 20, height: 10 },
    });
  expect(pixel(output, 80, 39, 14)).toEqual([255, 0, 0, 255]);
  expect(pixel(output, 80, 40, 14)[3]).toBe(0);
  const rotated = createCanvas(40, 40),
    r = rotated.getContext('2d');
  r.fillStyle = '#ff0000';
  r.fillRect(10, 10, 10, 20);
  const image = applyPixelEffect(r.getImageData(0, 0, 40, 40).data, 40, 40, linearWipe(0.5), {
    ...options,
    matrix: [0, 1, -1, 0, 20, 10],
    bounds: { x: 0, y: 0, width: 20, height: 10 },
  });
  expect(pixel(image, 40, 15, 19)[3]).toBe(255);
  expect(pixel(image, 40, 15, 20)[3]).toBe(0);
  const small = createCanvas(40, 20),
    s = small.getContext('2d');
  s.fillStyle = '#ff0000';
  s.fillRect(15, 5, 10, 5);
  const half = applyPixelEffect(s.getImageData(0, 0, 40, 20).data, 40, 20, linearWipe(0.5), {
    ...options,
    matrix: [0.5, 0, 0, 0.5, 15, 5],
    bounds: { x: 0, y: 0, width: 20, height: 10 },
  });
  expect(pixel(half, 40, 19, 7)[3]).toBe(255);
  expect(pixel(half, 40, 20, 7)[3]).toBe(0);
});
it('separates channels with alpha-safe colored fringes and preserves seeded deformation order independence', () => {
  const source = new Uint8ClampedArray(9 * 3 * 4);
  for (let y = 0; y < 3; y++)
    for (let x = 3; x < 6; x++) source.set([255, 255, 255, 255], (y * 9 + x) * 4);
  const split = applyPixelEffect(source, 9, 3, rgbSplit({ amountX: 1 }), options);
  expect(pixel(split, 9, 2, 1)).toEqual([255, 0, 0, 255]);
  expect(pixel(split, 9, 6, 1)).toEqual([0, 0, 255, 255]);
  const a = applyPixelEffect(
    source,
    9,
    3,
    waveWarp({ phase: 0.3, wavelength: 4, amountX: 2 }),
    options,
  );
  applyPixelEffect(source, 9, 3, waveWarp({ phase: 2 }), options);
  expect(
    applyPixelEffect(source, 9, 3, waveWarp({ phase: 0.3, wavelength: 4, amountX: 2 }), options),
  ).toEqual(a);
});
it('clears vacated pixels during bounded radial warps and keeps unchanged outside pixels exact', () => {
  const source = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 13; y < 27; y++)
    for (let x = 13; x < 27; x++) source.set([255, 0, 0, 255], (y * 40 + x) * 4);
  const result = applyPixelEffect(source, 40, 40, bulge({ amount: -1, radius: 30 }), options);
  expect(pixel(result, 40, 13, 20)[3]).toBe(0);
  expect(pixel(result, 40, 20, 20)[3]).toBe(255);
  const opaque = new Uint8ClampedArray(40 * 40 * 4).fill(255),
    outside = applyPixelEffect(opaque, 40, 40, twirl({ radius: 5, amount: 90 }), options);
  expect(pixel(outside, 40, 0, 0)).toEqual([255, 255, 255, 255]);
});
it('preserves logical effect keys through update/copy/move/remove with stable IDs', () => {
  const node = newNode({
    id: 'box',
    type: 'rect',
    effects: [{ type: 'blur', radius: 0, id: 'blur' }, waveWarp()],
    animations: [
      {
        property: 'effects.0.radius',
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 60, value: 20, easing: 'linear' },
        ],
      },
      {
        property: 'x',
        keys: [
          { frame: 0, value: 0, easing: 'linear' },
          { frame: 60, value: 60, easing: 'linear' },
        ],
      },
    ],
  });
  const edited = editEffectStack(
    node,
    [
      { type: 'update', target: { id: 'blur' }, patch: { radius: 12 } },
      { type: 'copy', target: { id: 'blur' } },
      { type: 'move', target: { id: 'blur' }, to: 2 },
      { type: 'remove', target: { index: 0 } },
    ],
    30,
  );
  expect(edited.effects).toHaveLength(2);
  expect(edited.effects[1].id).toBe('blur');
  expect(edited.effects[0].id).not.toBe('blur');
  expect(
    edited.animations.filter((a) => a.property.startsWith('effects.')).map((a) => a.property),
  ).toEqual(['effects.0.radius', 'effects.1.radius']);
  expect((evaluateNode(edited, 30).effects[0] as any).radius).toBe(12);
  expect((evaluateNode(edited, 30).effects[1] as any).radius).toBe(12);
  expect(evaluateNode(edited, 30).x).toBe(30);
  expect(node.effects[0].id).toBe('blur');
  expect(node.animations[0].keys).toHaveLength(2);
});
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-effects2d-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans native/generated effects atomically, fits content bounds, renders keys and restores one undo', async () => {
  const revision = app.service.snapshot.revision,
    waveSource = app.service.snapshot.files['components/wave.ts'],
    scope = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 90, ['wave']),
    leaf = scope.scene.nodes.find((n) => n.type === 'path')!;
  const plan = await app.dispatch('effectsPlan', {
    sceneId: 'intro',
    frame: 90,
    targets: [
      {
        nodeId: 'title',
        actions: [
          { type: 'append', effect: linearWipe(1) },
          {
            type: 'keys',
            target: { index: 0 },
            property: 'progress',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 90, value: 1, easing: 'linear' },
            ],
          },
        ],
      },
      {
        nodeId: leaf.id,
        path: ['wave'],
        actions: [{ type: 'append', effect: rgbSplit({ amountX: 4 }) }],
      },
    ],
  });
  expect(app.service.snapshot.revision).toBe(revision);
  expect(plan.candidate.planId).toHaveLength(64);
  expect(present(field(plan.layers[0].effects[0].values, 'region')).width).toBeGreaterThan(100);
  const preflight = await app.dispatch('projectPreflight', plan.candidate);
  expect(preflight.valid, JSON.stringify(preflight.diagnostics)).toBe(true);
  await app.dispatch('projectApply', plan.apply);
  expect(app.service.snapshot.files['components/wave.ts']).toBe(waveSource);
  expect(
    app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'wave')!.overrides[
      leaf.id.slice('wave/'.length)
    ].effects![0].type,
  ).toBe('rgbSplit');
  const sample = await app.frame({ frame: 45, width: 320, height: 180 }),
    exportPath = path.join(root, 'exports/png'),
    job = app.renders.start(app.service.snapshot, {
      output: exportPath,
      format: 'png',
      start: 45,
      end: 46,
      width: 320,
      height: 180,
    }),
    done = await app.renders.wait(job.id);
  expect(done.status, done.error).toBe('completed');
  expect((await readFile(path.join(exportPath, 'frame-00000045.png'))).equals(sample.buffer)).toBe(
    true,
  );
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(revision);
}, 30000);
it('rejects invalid selectors/duplicate effect IDs without editing the active project', async () => {
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('effectsPlan', {
      sceneId: 'intro',
      targets: [{ nodeId: 'title', actions: [{ type: 'remove', target: { id: 'missing' } }] }],
    }),
  ).rejects.toThrow('not in this layer');
  expect(() =>
    editEffectStack(newNode({ id: 'x', type: 'rect' }), [
      { type: 'append', effect: { type: 'blur', radius: 3, id: 'same' } },
      { type: 'append', effect: { type: 'blur', radius: 8, id: 'same' } },
    ]),
  ).toThrow('unique');
  expect(app.service.snapshot.revision).toBe(revision);
});
