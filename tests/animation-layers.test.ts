import { it, expect } from 'vitest';
import { newNode } from '../src/core/model.js';
import { evaluateNode, prepareKeyframes, sampleKeyframes, interpolate } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
import { editAnimationLayers } from '../src/core/animation-layers.js';
import { animationLayerSchema } from '../src/core/animation-schema.js';
import { applyMotionLayers, builtinMotions } from '../src/core/motion-template.js';
import { evaluateDrivers } from '../src/core/drivers.js';
import { editEffectStack } from '../src/core/effect-stack.js';
import { editGraphicsStack } from '../src/core/graphics-stack.js';
const keys = (a: number, b: number) => [
  { frame: 0, value: a, easing: 'linear' as const },
  { frame: 10, value: b, easing: 'linear' as const },
];
it('applies ordered weighted layers after native keys with cycles, reverse clocks and final opacity clipping', async () => {
  const node = newNode({
      id: 'n',
      type: 'rect',
      x: 10,
      opacity: 0.8,
      animations: [
        { property: 'x', keys: keys(10, 20) },
        { property: 'animationLayers.0.weight', keys: keys(0, 1) },
      ],
      animationLayers: [
        {
          id: 'delta',
          blend: 'add',
          weight: 0,
          channels: [{ property: 'x', keys: keys(0, 10), after: 'cycleOffset' }],
        },
        {
          id: 'scale',
          blend: 'multiply',
          weight: 0.5,
          channels: [
            { property: 'x', keys: keys(1, 2), after: 'pingpong' },
            { property: 'opacity', keys: keys(1, 0) },
          ],
        },
        {
          id: 'replace',
          blend: 'replace',
          weight: 0.25,
          start: 3,
          end: 20,
          rate: -1,
          offset: 10,
          channels: [{ property: 'x', keys: keys(100, 200) }],
        },
      ],
    }),
    native = new NativeEvaluator();
  try {
    expect(native.available).toBe(true);
    for (const frame of [5, 0, 29, 10, 12, 19.5, 20, 5]) {
      const expected = evaluateNode(node, frame),
        actual = (await native.evaluate([node], frame))[0];
      expect(actual.x).toBeCloseTo(expected.x, 8);
      expect(actual.opacity).toBeCloseTo(expected.opacity, 8);
      expect(actual.animationLayers![0].weight).toBe(expected.animationLayers![0].weight);
    }
    expect(node.x).toBe(10);
    expect(node.animationLayers![0].weight).toBe(0);
    expect(native.diagnostics().native.compiles).toBe(1);
    expect(native.diagnostics().native.hits).toBe(7);
  } finally {
    native.close();
  }
});
it('indexes random-access curves with explicit independent extrapolation and immutable prepared data', () => {
  const data = keys(10, 20),
    prepared = prepareKeyframes(data);
  for (const [mode, before, after] of [
    ['constant', 10, 20],
    ['linear', 5, 35],
    ['cycle', 15, 15],
    ['cycleOffset', 5, 35],
    ['pingpong', 15, 15],
  ] as const) {
    expect(sampleKeyframes(prepared, -5, { before: mode })).toBe(before);
    expect(sampleKeyframes(prepared, 25, { after: mode })).toBe(after);
  }
  expect(sampleKeyframes(prepared, -10, { before: 'cycleOffset' })).toBe(0);
  expect(sampleKeyframes(prepared, 10, { after: 'cycle' })).toBe(20);
  data[0].value = 30;
  expect(sampleKeyframes(prepared, 0)).toBe(10);
  expect(interpolate(data, 0)).toBe(30);
  expect(Object.isFrozen(prepared.keys)).toBe(true);
  expect(() => prepareKeyframes([...data, { ...data[0] }])).toThrow(/Duplicate/);
  const raw = [{ frame: 0, value: 1, easing: 'linear' as const }];
  prepareKeyframes(raw);
  (raw[0] as any).value = NaN;
  expect(() => prepareKeyframes(raw)).toThrow();
});
it('remaps control channels by stable IDs during move/duplicate/removal without disturbing ordinary keys', () => {
  const source = newNode({
      id: 'a',
      type: 'rect',
      animations: [
        { property: 'x', keys: keys(0, 10) },
        { property: 'animationLayers.0.weight', keys: keys(0, 1) },
        { property: 'animationLayers.1.rate', keys: keys(1, 2) },
      ],
      animationLayers: [
        { id: 'first', channels: [{ property: 'x', keys: keys(0, 10) }] },
        { id: 'second', channels: [{ property: 'y', keys: keys(0, 10) }] },
      ],
    }),
    moved = editAnimationLayers(source, [
      { type: 'move', id: 'first', index: 1 },
      { type: 'duplicate', id: 'first', newId: 'copy' },
      { type: 'remove', id: 'second' },
    ]);
  expect(moved.animationLayers!.map((l) => l.id)).toEqual(['first', 'copy']);
  expect(moved.animations.map((c) => c.property)).toEqual([
    'x',
    'animationLayers.0.weight',
    'animationLayers.1.weight',
  ]);
  expect(source.animationLayers![1].id).toBe('second');
  expect(() =>
    editAnimationLayers(source, [
      { type: 'append', layer: { id: 'first', channels: [{ property: 'x', keys: keys(0, 1) }] } },
    ]),
  ).toThrow(/Duplicate/);
});
it('compiles reusable overlapping additive/factor motion cues as editable layers with neutral bases', () => {
  const source = newNode({
      id: 'box',
      type: 'rect',
      x: 100,
      opacity: 0.8,
      animations: [{ property: 'x', keys: keys(100, 120) }],
    }),
    compiled = applyMotionLayers(source, [
      {
        id: 'slide',
        template: builtinMotions.fadeSlide,
        parameters: { dx: 30, dy: 0 },
        start: 0,
        duration: 10,
        blend: 'add',
      },
      {
        id: 'fade',
        template: builtinMotions.fadeOut,
        parameters: { dx: 0, dy: 0 },
        start: 0,
        duration: 10,
        blend: 'multiply',
      },
    ]);
  expect(compiled.node.animations).toEqual(source.animations);
  expect(compiled.node.animationLayers).toHaveLength(2);
  expect(evaluateNode(compiled.node, 0).x).toBe(130);
  expect(evaluateNode(compiled.node, 10).x).toBe(120);
  expect(evaluateNode(compiled.node, 20).opacity).toBe(0);
});
it('rejects layer self-controls, missing numeric targets and post-stack weight expressions', async () => {
  expect(() =>
    animationLayerSchema.parse({
      id: 'bad',
      channels: [{ property: 'animationLayers.0.weight', keys: keys(0, 1) }],
    }),
  ).toThrow(/cannot control/);
  const node = newNode({
      id: 'a',
      type: 'rect',
      animationLayers: [
        { id: 'bad', enabled: false, channels: [{ property: 'params.missing', keys: keys(0, 1) }] },
      ],
    }),
    native = new NativeEvaluator();
  try {
    expect(() => evaluateNode(node, 0)).toThrow(/not numeric/);
    await expect(native.evaluate([node], 0)).rejects.toMatchObject({ code: 'ANIMATION_TARGET' });
  } finally {
    native.close();
  }
  const valid = newNode({
    id: 'a',
    type: 'rect',
    animationLayers: [{ id: 'layer', channels: [{ property: 'x', keys: keys(0, 1) }] }],
    expressions: { 'animationLayers.0.weight': '0.5' },
  });
  expect(() =>
    evaluateDrivers([valid], { frame: 0, fps: 30, width: 320, height: 180, duration: 60 }),
  ).toThrow(/before mixing/);
});
it('reduces repeated native keyframe payloads, remains identical without cache, and splits many nodes safely', async () => {
  const keys = Array.from({ length: 2000 }, (_, i) => ({
      frame: i,
      value: Math.sin(i / 50),
      easing: 'linear' as const,
    })),
    nodes = Array.from({ length: 70 }, (_, i) =>
      newNode({ id: 'n' + i, type: 'rect', animations: [{ property: 'x', keys }] }),
    ),
    cached = new NativeEvaluator(),
    baseline = new NativeEvaluator({ cache: false });
  try {
    for (const frame of [123.5, 1599, 0, 800, 123.5]) {
      const a = await cached.evaluate(nodes, frame),
        b = await baseline.evaluate(nodes, frame);
      expect(a.map((n) => n.x)).toEqual(b.map((n) => n.x));
    }
    expect(cached.diagnostics().indexedSupported).toBe(true);
    expect(cached.diagnostics().definitionBytesSent).toBeLessThan(
      baseline.diagnostics().definitionBytesSent / 5,
    );
    expect(cached.diagnostics().native.compiles).toBe(1);
    expect(baseline.diagnostics().native.compiles).toBe(10);
    nodes[0].animations[0].keys[10].value = 123;
    expect((await cached.evaluate(nodes, 10))[0].x).toBe(123);
    expect(cached.diagnostics().native.compiles).toBe(2);
    const bytesBefore = cached.diagnostics().evaluationBytesSent;
    await cached.evaluate(nodes, 11);
    expect(cached.diagnostics().evaluationBytesSent - bytesBefore).toBeLessThan(10000);
    cached.close();
    expect((await cached.evaluate(nodes, 10))[0].x).toBe(123);
    expect(cached.diagnostics().native.compiles).toBe(2);
  } finally {
    cached.close();
    baseline.close();
  }
});
it('matches asymmetric loop boundaries, negative-rate layers and secant continuation in Rust and TypeScript', async () => {
  const native = new NativeEvaluator();
  try {
    for (const mode of ['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong'] as const) {
      const node = newNode({
        id: 'curve',
        type: 'rect',
        x: 7,
        animationLayers: [
          {
            id: 'delta',
            start: 2,
            rate: -1.5,
            offset: 27,
            blend: 'add',
            channels: [
              {
                property: 'x',
                before: mode,
                after: mode,
                keys: [
                  { frame: 3, value: -5, easing: 'bezier', bezier: [0.2, 0.7, 0.6, 1] },
                  { frame: 13, value: 25, easing: 'hold' },
                  { frame: 23, value: 40, easing: 'linear' },
                ],
              },
            ],
          },
        ],
      });
      for (const frame of [2, 3, 15, 24, 42, 100, 9.25])
        expect((await native.evaluate([node], frame))[0].x).toBeCloseTo(
          evaluateNode(node, frame).x,
          7,
        );
    }
  } finally {
    native.close();
  }
});
it('recovers evicted native programs without stale poses and retains fallback animation-layer behavior', async () => {
  const native = new NativeEvaluator();
  try {
    const nodes = Array.from({ length: 4 }, (_, n) =>
      newNode({
        id: 'large' + n,
        type: 'rect',
        animations: [
          {
            property: 'x',
            keys: Array.from({ length: 35000 }, (_, i) => ({
              frame: i,
              value: i + n,
              easing: 'linear' as const,
            })),
          },
        ],
      }),
    );
    const first = await native.evaluate(nodes, 123);
    expect(first.map((n) => n.x)).toEqual([123, 124, 125, 126]);
    expect(native.diagnostics().native.accountedBytes).toBeLessThanOrEqual(16 * 1024 * 1024);
    const again = await native.evaluate(nodes, 124);
    expect(again.map((n) => n.x)).toEqual([124, 125, 126, 127]);
    expect(native.diagnostics().missingRetries).toBeGreaterThan(0);
  } finally {
    native.close();
  }
  const fallback = new NativeEvaluator();
  Object.defineProperty(fallback, 'binary', { value: 'Z:/vmotion-missing-native.exe' });
  const layered = newNode({
    id: 'fallback',
    type: 'rect',
    x: 10,
    animationLayers: [
      { id: 'move', channels: [{ property: 'x', keys: keys(0, 10), after: 'cycleOffset' }] },
    ],
  });
  expect((await fallback.evaluate([layered], 25))[0].x).toBe(35);
  expect(fallback.diagnostics().fallbackNodes).toBe(1);
  fallback.close();
});
it('keeps layered effect/shape channels attached to stable IDs when reordering, copying or deleting sources', () => {
  const source = newNode({
    id: 'shape',
    type: 'rect',
    effects: [
      { id: 'a', type: 'blur', radius: 2 },
      { id: 'b', type: 'blur', radius: 4 },
    ],
    animationLayers: [
      { id: 'effect-motion', channels: [{ property: 'effects.0.radius', keys: keys(0, 10) }] },
    ],
    animations: [{ property: 'animationLayers.0.weight', keys: keys(0, 1) }],
  });
  const moved = editEffectStack(source, [
    { type: 'move', target: { id: 'a' }, to: 1 },
    { type: 'copy', target: { id: 'a' } },
  ]);
  expect(moved.animationLayers![0].channels.map((c) => c.property)).toEqual([
    'effects.1.radius',
    'effects.2.radius',
  ]);
  const removed = editEffectStack(source, [{ type: 'remove', target: { id: 'a' } }]);
  expect(removed.animationLayers).toEqual([]);
  expect(removed.animations).toEqual([]);
  const shape = newNode({
    id: 's',
    type: 'rect',
    shapeOperators: [
      { id: 'round', type: 'round', radius: 2 },
      { id: 'offset', type: 'offset', amount: 2 },
    ],
    animationLayers: [
      {
        id: 'shape-motion',
        channels: [{ property: 'shapeOperators.0.radius', keys: keys(0, 10) }],
      },
    ],
  });
  const shifted = editGraphicsStack(shape, 'shapeOperators', [
    { type: 'move', target: { id: 'round' }, to: 1 },
  ]);
  expect(shifted.animationLayers![0].channels[0].property).toBe('shapeOperators.1.radius');
});
