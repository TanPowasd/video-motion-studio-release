import { it, expect } from 'vitest';
import { createCanvas, Path2D } from '@napi-rs/canvas';
import { newNode } from '../src/core/model.js';
import { TypographyLayout, textSelectorWeight } from '../src/core/typography.js';
import { textSelectorSchema } from '../src/core/typography-schema.js';
import { shapePath, shapeBounds, applyShapeOperators } from '../src/core/vector.js';
import { GeometryCache } from '../src/core/geometry-cache.js';
import { editGraphicsStack } from '../src/core/graphics-stack.js';
import { evaluateNode } from '../src/core/time.js';
import { NativeEvaluator } from '../src/core/native.js';
const ctx = createCanvas(1, 1).getContext('2d');
it('selects grapheme/word/line ranges, offsets and continuous shape weights', () => {
  expect(
    textSelectorWeight(textSelectorSchema.parse({ start: 1, end: 3, mode: 'index' }), 0, 4),
  ).toBe(0);
  expect(
    textSelectorWeight(textSelectorSchema.parse({ start: 1, end: 3, mode: 'index' }), 1, 4),
  ).toBe(1);
  expect(
    textSelectorWeight(
      textSelectorSchema.parse({ start: 1, end: 3, mode: 'index', offset: 1 }),
      1,
      4,
    ),
  ).toBe(0);
  expect(textSelectorWeight(textSelectorSchema.parse({ shape: 'triangle' }), 1, 3)).toBe(1);
  expect(textSelectorWeight(textSelectorSchema.parse({ shape: 'rampUp', amount: -1 }), 0, 2)).toBe(
    -0.25,
  );
  expect(textSelectorWeight(textSelectorSchema.parse({ start: 2, end: 2 }), 0, 3)).toBe(0);
});
it('preserves Unicode graphemes and full wrapping during animated reveal without leaking cached poses', () => {
  const layout = new TypographyLayout(),
    n = newNode({
      id: 'text',
      type: 'text',
      text: 'Á👨‍👩‍👧‍👦中',
      fontSize: 24,
      width: 200,
      height: 100,
      textAnimators: [
        {
          id: 'range',
          selector: { start: 1, end: 2, mode: 'index' },
          values: { y: 20, scaleX: 2 },
        },
      ],
    });
  const first = layout.layout(ctx, n);
  expect(first.runs.map((r) => r.text)).toEqual(['Á', '👨‍👩‍👧‍👦', '中']);
  expect(first.runs[1].y).toBe(20);
  expect(first.runs[1].scaleX).toBe(2);
  first.runs[1].box.x = 9999;
  first.runs[1].x = 9999;
  expect(layout.layout(ctx, n).runs[1].x).not.toBe(9999);
  expect(layout.layout(ctx, n).runs[1].box.x).not.toBe(9999);
  const wrapped = newNode({ ...n, text: '动画文字保持换行位置稳定', width: 80, align: 'center' }),
    full = layout.layout(ctx, wrapped),
    half = layout.layout(ctx, { ...wrapped, reveal: 0.5 });
  expect(half.metrics.lineCount).toBe(full.metrics.lineCount);
  expect(half.runs[0].x).toBe(full.runs[0].x);
  expect(layout.report().layout.hits).toBeGreaterThan(0);
});
it('word and line animators preserve runs at their requested shaping granularity', () => {
  const layout = new TypographyLayout(),
    word = newNode({
      id: 'w',
      type: 'text',
      text: 'Hello world\nSecond line',
      fontSize: 20,
      width: 300,
      height: 100,
      textAnimators: [
        {
          id: 'word',
          selector: { unit: 'word', start: 1, end: 2, mode: 'index' },
          values: { x: 20 },
        },
      ],
    });
  const w = layout.layout(ctx, word);
  expect(w.metrics.counts.word).toBe(4);
  expect(w.runs.find((r) => r.text === 'world')!.wordIndex).toBe(1);
  expect(w.runs.find((r) => r.text === ' ')!.wordIndex).toBe(-1);
  const line = layout.layout(
    ctx,
    newNode({
      ...word,
      textAnimators: [
        {
          id: 'line',
          selector: { unit: 'line', start: 1, end: 2, mode: 'index' },
          values: { rotation: 12 },
        },
      ],
    }),
  );
  expect(line.runs.map((r) => r.text)).toEqual(['Hello world', 'Second line']);
  expect(line.runs[1].rotation).toBe(12);
  expect(line.runs[0].rotation).toBe(0);
  const mixed = layout.layout(
    ctx,
    newNode({
      ...word,
      textMotion: {
        unit: 'word',
        start: 0,
        duration: 18,
        stagger: 2,
        offsetX: 0,
        offsetY: 24,
        rotation: 0,
        scale: 0.85,
      },
      textAnimators: [{ id: 'line', selector: { unit: 'line' }, values: { y: 3 } }],
    }),
    30,
  );
  expect(mixed.runs.some((r) => r.text === 'Hello')).toBe(true);
  expect(mixed.runs.some((r) => r.text === 'Hello world')).toBe(false);
});
it('places alphabetic glyph baselines on curves with tangent, reverse, normals and explicit overflow', () => {
  const layout = new TypographyLayout(),
    n = newNode({
      id: 'p',
      type: 'text',
      text: 'ABC',
      fontSize: 20,
      pathText: { path: 'M10 80L210 80', offset: 15, normalOffset: 8 },
    }),
    r = layout.layout(ctx, n);
  expect(r.runs[0].baseline).toBe('alphabetic');
  expect(r.runs[0].x).toBeCloseTo(25, 3);
  expect(r.runs[0].y).toBeCloseTo(88, 3);
  expect(r.metrics.truncatedCharacters).toBe(0);
  const vertical = layout.layout(ctx, newNode({ ...n, pathText: { path: 'M100 10L100 210' } }));
  expect(vertical.runs[0].rotation).toBeCloseTo(90, 3);
  const reverse = layout.layout(
    ctx,
    newNode({ ...n, pathText: { path: 'M10 80L210 80', reverse: true } }),
  );
  expect(Math.abs(reverse.runs[0].rotation)).toBeCloseTo(180, 3);
  expect(reverse.runs[0].x).toBeCloseTo(210, 3);
  const overflow = layout.layout(ctx, newNode({ ...n, pathText: { path: 'M0 0L10 0' } }));
  expect(overflow.runs).toHaveLength(0);
  expect(overflow.metrics.overflowUnits).toBe(3);
  expect(
    layout.layout(ctx, newNode({ ...n, pathText: { path: 'M0 0L10 0', overflow: 'loop' } })).runs,
  ).toHaveLength(3);
});
it('includes animated tracking in centered path alignment', () => {
  const layout = new TypographyLayout(),
    base = newNode({
      id: 't',
      type: 'text',
      text: 'ABC',
      fontSize: 20,
      pathText: { path: 'M0 0L300 0', align: 'center' },
    }),
    a = layout.layout(ctx, base),
    b = layout.layout(
      ctx,
      newNode({ ...base, textAnimators: [{ id: 'tracking', values: { tracking: 20 } }] }),
    );
  expect(b.runs[0].x - a.runs[0].x).toBeCloseTo(-20, 3);
  expect(b.runs[2].x - a.runs[2].x).toBeCloseTo(20, 3);
});
it('rejects literal expression array references before rebinding stack indices', () => {
  const node = newNode({
    id: 'shape',
    type: 'rect',
    shapeOperators: [{ id: 'r', type: 'round', radius: 10 }],
    expressions: { 'shapeOperators.0.radius': 'base.shapeOperators[0].radius + 2' },
  });
  expect(() =>
    editGraphicsStack(node, 'shapeOperators', [{ type: 'copy', target: { id: 'r' } }]),
  ).toThrow('rewritten explicitly');
});
it('rejects over-budget text and bounds both retained entries and accounted bytes', () => {
  const layout = new TypographyLayout(2000);
  expect(() =>
    layout.layout(
      ctx,
      newNode({ id: 'x', type: 'text', text: '字'.repeat(4097), textAnimators: [{ id: 'r' }] }),
    ),
  ).toThrow('4096');
  const cache = new GeometryCache<number>(30, 2);
  for (let i = 0; i < 20; i++) cache.put(String(i), i, 10);
  expect(cache.report().entries).toBeLessThanOrEqual(2);
  expect(cache.report().accountedBytes).toBeLessThanOrEqual(30);
});
it('executes shape stack order, closed offsets with holes, dash outlines and clone-safe caching', () => {
  const cache = new GeometryCache<Path2D>(),
    n = newNode({
      id: 's',
      type: 'rect',
      width: 100,
      height: 100,
      shapeOperators: [
        {
          id: 'cut',
          type: 'boolean',
          operation: 'difference',
          paths: [{ path: 'M25 25H75V75H25Z' }],
        },
        { id: 'expand', type: 'offset', amount: 5 },
      ],
    });
  const p = shapePath(n, cache),
    c = createCanvas(140, 140),
    g = c.getContext('2d');
  g.translate(10, 10);
  g.fill(p);
  expect(g.getImageData(30, 60, 1, 1).data[3]).toBe(255);
  expect(g.getImageData(60, 60, 1, 1).data[3]).toBe(0);
  expect(shapeBounds(n, p)).toEqual({ x: -5, y: -5, width: 110, height: 110 });
  p.transform({ a: 1, b: 0, c: 0, d: 1, e: 500, f: 0 });
  expect(shapeBounds(n, shapePath(n, cache)).x).toBe(-5);
  expect(cache.report().hits).toBe(1);
  expect(() =>
    applyShapeOperators(new Path2D('M0 0L100 0'), [{ id: 'offset', type: 'offset', amount: 4 }]),
  ).toThrow('closed');
  const dash = applyShapeOperators(new Path2D('M10 40L110 40'), [
    { id: 'd', type: 'dash', on: 10, off: 10 },
    { id: 'o', type: 'outline', width: 6 },
  ]);
  const d = createCanvas(140, 80).getContext('2d');
  d.fill(dash);
  expect(d.getImageData(15, 40, 1, 1).data[3]).toBe(255);
  expect(d.getImageData(25, 40, 1, 1).data[3]).toBe(0);
});
it('moves/copies/removes stable-ID channels and expression targets without changing source', () => {
  const n = newNode({
      id: 's',
      type: 'rect',
      shapeOperators: [
        { id: 'round', type: 'round', radius: 4 },
        { id: 'trim', type: 'trim' },
      ],
      animations: [
        {
          property: 'shapeOperators.0.radius',
          keys: [
            { frame: 0, value: 4 },
            { frame: 20, value: 14 },
          ],
        },
      ],
      expressions: { 'shapeOperators.0.radius': 'value + 2' },
    }),
    moved = editGraphicsStack(n, 'shapeOperators', [
      { type: 'move', target: { id: 'round' }, to: 1 },
    ]);
  expect(moved.animations[0].property).toBe('shapeOperators.1.radius');
  expect(moved.expressions).toEqual({ 'shapeOperators.1.radius': 'value + 2' });
  const copy = editGraphicsStack(moved, 'shapeOperators', [
    { type: 'copy', target: { id: 'round' }, id: 'copy', index: 0 },
  ]);
  expect(copy.shapeOperators.map((v) => v.id)).toEqual(['copy', 'trim', 'round']);
  expect(copy.animations.map((v) => v.property)).toEqual([
    'shapeOperators.0.radius',
    'shapeOperators.2.radius',
  ]);
  const update = editGraphicsStack(
    copy,
    'shapeOperators',
    [{ type: 'update', target: { id: 'round' }, patch: { radius: 8 } }],
    10,
  );
  expect(update.animations[1].keys.some((k) => k.frame === 10 && k.value === 8)).toBe(true);
  expect(
    editGraphicsStack(update, 'shapeOperators', [{ type: 'remove', target: { id: 'copy' } }])
      .animations[0].property,
  ).toBe('shapeOperators.1.radius');
  expect(n.shapeOperators[0].id).toBe('round');
  expect(() =>
    editGraphicsStack(n, 'shapeOperators', [
      { type: 'append', item: { id: 'round', type: 'round' } },
    ]),
  ).toThrow('unique');
});
it('evaluates new numeric channels identically in native and TypeScript after random seeks', async () => {
  const evaluator = new NativeEvaluator();
  try {
    const n = newNode({
      id: 't',
      type: 'text',
      pathText: { path: 'M0 0L200 0' },
      textAnimators: [{ id: 'a' }],
      animations: [
        {
          property: 'pathText.offset',
          keys: [
            { frame: 0, value: 0 },
            { frame: 20, value: 40 },
          ],
        },
        {
          property: 'textAnimators.0.selector.end',
          keys: [
            { frame: 0, value: 0 },
            { frame: 20, value: 100 },
          ],
        },
      ],
    });
    for (const frame of [19, 0, 7, 20, 7])
      expect((await evaluator.evaluate([n], frame))[0]).toEqual(evaluateNode(n, frame));
  } finally {
    evaluator.close();
  }
});
