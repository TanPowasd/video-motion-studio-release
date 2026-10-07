import { it, expect } from 'vitest';
import { applyPixelEffect } from '../src/core/pixels.js';
import { liquify } from '../src/sdk/post.js';
import { newNode } from '../src/core/model.js';
import { editEffectStack } from '../src/core/effect-stack.js';
import { evaluateNode } from '../src/core/time.js';
const opts = { frame: 0, fps: 30 },
  pixel = (data: Uint8ClampedArray, w: number, x: number, y: number) =>
    Array.from(data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4));
it('keeps zero/empty/disabled fields exact and only samples inside a smooth brush footprint', () => {
  const source = new Uint8ClampedArray(40 * 40 * 4);
  for (let y = 10; y < 30; y++)
    for (let x = 10; x < 30; x++) source.set([255, 0, 0, 128], (y * 40 + x) * 4);
  const brush = { mode: 'push' as const, center: { x: 0.5, y: 0.5 }, radius: 14, dx: 5 };
  for (const effect of [
    liquify(),
    liquify({ amount: 0, brushes: [brush] }),
    { ...liquify({ brushes: [brush] }), enabled: false },
  ])
    expect(applyPixelEffect(source, 40, 40, effect, opts)).toEqual(source);
  const result = applyPixelEffect(source, 40, 40, liquify({ brushes: [brush] }), opts);
  expect(pixel(result, 40, 0, 0)).toEqual(pixel(source, 40, 0, 0));
  expect(result).not.toEqual(source);
  for (let i = 0; i < result.length; i += 4)
    if (result[i + 3]) expect(Array.from(result.subarray(i, i + 3))).toEqual([255, 0, 0]);
});
it('respects rotated local coordinates, reverses brush stack sampling and retains animation channels', () => {
  const source = Uint8ClampedArray.from({ length: 32 * 32 * 4 }, (_, i) =>
    i % 4 === 3 ? 255 : i % 256,
  );
  const brush = { mode: 'twirl' as const, center: { x: 0.5, y: 0.5 }, radius: 10, angle: 75 },
    result = applyPixelEffect(source, 32, 32, liquify({ brushes: [brush] }), {
      ...opts,
      matrix: [0, 1, -1, 0, 32, 0],
      bounds: { x: 0, y: 0, width: 32, height: 32 },
    });
  expect(result).not.toEqual(source);
  expect(pixel(result, 32, 0, 0)).toEqual(pixel(source, 32, 0, 0));
  const node = newNode({
      id: 'x',
      type: 'rect',
      effects: [liquify({ id: 'field', brushes: [brush] } as any)],
    }),
    edited = editEffectStack(node, [
      {
        type: 'keys',
        target: { index: 0 },
        property: 'brushes.0.angle',
        keys: [
          { frame: 0, value: 0 },
          { frame: 30, value: 90 },
        ],
      },
      { type: 'copy', target: { index: 0 } },
    ]);
  expect((evaluateNode(edited, 15).effects[1] as ReturnType<typeof liquify>).brushes[0].angle).toBe(
    45,
  );
});
