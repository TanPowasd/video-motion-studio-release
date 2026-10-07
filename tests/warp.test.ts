import { it, expect } from 'vitest';
import { meshWarp, cornerPin, makeWarpGrid, pinGrid } from '../src/sdk/post.js';
import { applyPixelEffect } from '../src/core/pixels.js';
import { newNode } from '../src/core/model.js';
import { evaluateNode } from '../src/core/time.js';
import { editEffectStack } from '../src/core/effect-stack.js';
const opts = { frame: 0, fps: 30 },
  pixel = (data: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
it('keeps identity/zero/disabled deformation exact and validates grid and corner geometry', () => {
  const source = Uint8ClampedArray.from({ length: 16 * 16 * 4 }, (_, i) => i % 256);
  for (const effect of [
    meshWarp({ columns: 3, rows: 2, points: makeWarpGrid(3, 2) }),
    cornerPin([
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 1, y: 1 },
      { x: 0, y: 1 },
    ]),
    meshWarp({
      columns: 1,
      rows: 1,
      points: makeWarpGrid(1, 1, (u, v) => ({ x: u + 0.3, y: v })),
      amount: 0,
    }),
    {
      ...meshWarp({
        columns: 1,
        rows: 1,
        points: makeWarpGrid(1, 1, (u, v) => ({ x: u + 0.3, y: v })),
      }),
      enabled: false,
    },
  ])
    expect(applyPixelEffect(source, 16, 16, effect, opts)).toEqual(source);
  expect(() => meshWarp({ columns: 2, rows: 1, points: makeWarpGrid(1, 1) })).toThrow();
  expect(() =>
    cornerPin([
      { x: 0, y: 0 },
      { x: 1, y: 1 },
      { x: 1, y: 0 },
      { x: 0, y: 1 },
    ]),
  ).toThrow();
  expect(() => makeWarpGrid(33, 1)).toThrow();
});
it('moves only the selected patch, clears its old location, excludes neighboring colors and leaves no diagonal cracks', () => {
  const source = new Uint8ClampedArray(32 * 16 * 4);
  for (let y = 4; y < 12; y++)
    for (let x = 4; x < 12; x++) source.set([255, 0, 0, 255], (y * 32 + x) * 4);
  for (let y = 4; y < 12; y++) source.set([0, 0, 255, 255], (y * 32 + 3) * 4);
  for (const samples of [1, 4] as const) {
    const effect = meshWarp({
      columns: 4,
      rows: 2,
      points: makeWarpGrid(4, 2, (u, v) => ({ x: u + 1, y: v })),
      region: { x: 4, y: 4, width: 8, height: 8 },
      samples,
    });
    const result = applyPixelEffect(source, 32, 16, effect, opts);
    expect(pixel(result, 32, 3, 8)).toEqual([0, 0, 255, 255]);
    expect(pixel(result, 32, 4, 8)[3]).toBe(0);
    for (let y = 4; y < 12; y++)
      for (let x = 12; x < 20; x++) expect(pixel(result, 32, x, y)).toEqual([255, 0, 0, 255]);
  }
});
it('uses perspective-correct texture coordinates across both corner-pin triangles', () => {
  const source = new Uint8ClampedArray(64 * 64 * 4);
  for (let y = 0; y < 64; y++)
    for (let x = 0; x < 64; x++) source.set([255, y * 4, 0, 255], (y * 64 + x) * 4);
  const effect = cornerPin(
    [
      { x: 0, y: 0 },
      { x: 1, y: 0 },
      { x: 0.75, y: 1 },
      { x: 0.25, y: 1 },
    ],
    { samples: 1 },
  );
  const result = applyPixelEffect(source, 64, 64, effect, opts);
  expect(pixel(result, 64, 32, 32)[1]).toBeCloseTo(85, 0);
  expect(pixel(result, 64, 0, 50)[3]).toBe(0);
  expect(pinGrid(effect.corners).map((point) => point.weight)).toEqual([1, 1, 2, 2]);
});
it('tracks rotated layer coordinates, supports reflection and preserves alpha-safe colors on subpixel edges', () => {
  const source = new Uint8ClampedArray(32 * 32 * 4);
  for (let y = 8; y < 16; y++)
    for (let x = 12; x < 20; x++) source.set([255, 0, 0, 128], (y * 32 + x) * 4);
  const effect = meshWarp({
    columns: 1,
    rows: 1,
    points: makeWarpGrid(1, 1, (u, v) => ({ x: u + 0.5, y: v })),
    samples: 4,
  });
  const result = applyPixelEffect(source, 32, 32, effect, {
    ...opts,
    matrix: [0, 1, -1, 0, 20, 8],
    bounds: { x: 0, y: 0, width: 8, height: 8 },
  });
  expect(pixel(result, 32, 15, 18)).toEqual([255, 0, 0, 128]);
  expect(pixel(result, 32, 15, 9)[3]).toBe(0);
  const reflected = applyPixelEffect(
    source,
    32,
    32,
    meshWarp({
      columns: 1,
      rows: 1,
      points: makeWarpGrid(1, 1, (u, v) => ({ x: 1 - u, y: v })),
      region: { x: 12, y: 8, width: 8, height: 8 },
    }),
    opts,
  );
  expect(pixel(reflected, 32, 15, 10)).toEqual([255, 0, 0, 128]);
});
it('animates individual grid points and retains their channels through effect copies', () => {
  const node = newNode({
    id: 'box',
    type: 'rect',
    effects: [meshWarp({ columns: 1, rows: 1, points: makeWarpGrid(1, 1) })],
  });
  const edited = editEffectStack(
    node,
    [
      {
        type: 'keys',
        target: { index: 0 },
        property: 'points.3.y',
        keys: [
          { frame: 0, value: 1, easing: 'linear' },
          { frame: 30, value: 0.5, easing: 'linear' },
        ],
      },
      { type: 'copy', target: { index: 0 } },
    ],
    0,
  );
  const evaluated = evaluateNode(edited, 15);
  expect((evaluated.effects[0] as ReturnType<typeof meshWarp>).points[3].y).toBe(0.75);
  expect((evaluated.effects[1] as ReturnType<typeof meshWarp>).points[3].y).toBe(0.75);
});
