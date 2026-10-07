import { it, expect } from 'vitest';
import { newNode } from '../src/core/model.js';
import { evaluateNode, bezierEase } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
import { resamplePath, morphPaths, cubicEasing } from '../src/sdk/motion.js';
it('evaluates nested effect and component controls without mutating source objects', async () => {
  const node = newNode({
      id: 'controls',
      type: 'component',
      params: { amplitude: 10 },
      effects: [{ type: 'blur', radius: 0 }],
      animations: [
        {
          property: 'params.amplitude',
          keys: [
            { frame: 0, value: 10, easing: 'bezier', bezier: [0.42, 0, 0.58, 1] },
            { frame: 60, value: 20, easing: 'linear' },
          ],
        },
        {
          property: 'effects.0.radius',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 12, easing: 'linear' },
          ],
        },
      ],
    }),
    native = new NativeEvaluator();
  try {
    for (const frame of [0, 45, 15, 30, 60]) {
      const expected = evaluateNode(node, frame),
        actual = (await native.evaluate([node], frame))[0];
      expect(actual.params.amplitude).toBeCloseTo(expected.params.amplitude as number, 7);
      expect(actual.effects[0]).toEqual(expected.effects[0]);
    }
    expect(node.params.amplitude).toBe(10);
    expect(node.effects[0]).toEqual({ type: 'blur', radius: 0 });
  } finally {
    native.close();
  }
});
it('cubic easing inverts x and permits controlled overshoot', () => {
  expect(bezierEase(0.5, [0.42, 0, 0.58, 1])).toBeCloseTo(0.5, 7);
  expect(cubicEasing(0.2, 1.5, 0.7, 1.5)(0.7)).toBeGreaterThan(1);
  expect(() => cubicEasing(-0.1, 0, 1, 1)).toThrow();
});
it('resamples differing path topology before morphing', () => {
  const a = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
    ],
    b = [
      { x: 0, y: 0 },
      { x: 0, y: 50 },
      { x: 100, y: 50 },
    ],
    samples = resamplePath(a, 5);
  expect(samples.map((p) => p.x)).toEqual([0, 25, 50, 75, 100]);
  const morph = morphPaths(a, b, 0.5, { samples: 5 });
  expect(morph).toHaveLength(5);
  expect(morph.at(-1)).toEqual({ x: 100, y: 25 });
  const closed = resamplePath(
    [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ],
    4,
    true,
  );
  expect(closed).toEqual([
    { x: 0, y: 0 },
    { x: 10, y: 0 },
    { x: 10, y: 10 },
    { x: 0, y: 10 },
  ]);
});
