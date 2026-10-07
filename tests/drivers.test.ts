import { it, expect } from 'vitest';
import { newNode } from '../src/core/model.js';
import { evaluateDrivers } from '../src/core/drivers.js';
import { prepareCurvePath, sampleCurvePath } from '../src/core/curve-path.js';
const ctx = { frame: 15, fps: 30, width: 640, height: 360, duration: 60 };
it('evaluates referenced properties, own animated base values and typed conditions with dependency evidence', () => {
  const nodes = [
    newNode({
      id: 'a',
      type: 'rect',
      x: 40,
      width: 100,
      expressions: { x: 'value + 10 * sin(time * Math.PI)', width: 'base.width * 2' },
    }),
    newNode({
      id: 'b',
      type: 'rect',
      expressions: {
        x: 'layer("a").x + layer("a").width + 12',
        opacity: 'frame < 10 ? 0 : clamp(time, 0, 1)',
      },
    }),
  ];
  const result = evaluateDrivers(nodes, ctx);
  expect(result.nodes[0].x).toBe(50);
  expect(result.nodes[1].x).toBe(262);
  expect(result.nodes[1].opacity).toBe(0.5);
  expect(
    result.dependencies.find((value) => value.nodeId === 'b' && value.property === 'x')?.inputs,
  ).toContain('a:x');
  expect(evaluateDrivers(nodes, { ...ctx, frame: 0 }).nodes[1].opacity).toBe(0);
  expect(nodes[0].x).toBe(40);
});
it('detects cross-property cycles, missing references, unsupported code and nonfinite values', () => {
  const cycle = [
    newNode({ id: 'a', type: 'rect', expressions: { x: 'layer("b").x' } }),
    newNode({ id: 'b', type: 'rect', expressions: { x: 'layer("a").x' } }),
  ];
  expect(() => evaluateDrivers(cycle, ctx)).toThrow('cycle');
  for (const expression of [
    'process.exit()',
    '(()=>1)()',
    'Math.random()',
    '1 / 0',
    'self.constructor',
    'layer("missing").x',
  ])
    expect(() =>
      evaluateDrivers([newNode({ id: 'a', type: 'rect', expressions: { x: expression } })], ctx),
    ).toThrow();
});
it('solves anchors, sibling geometry, fractions/insets and aspect ratios deterministically', () => {
  const nodes = [
    newNode({
      id: 'panel',
      type: 'group',
      width: 400,
      height: 200,
      layout: {
        reference: 'scene',
        x: { at: 'center', self: 'center' },
        y: { at: 'center', self: 'center' },
      },
    }),
    newNode({
      id: 'inside',
      type: 'rect',
      parentId: 'panel',
      height: 50,
      layout: {
        reference: 'parent',
        width: { value: 0.5 },
        x: { at: 'end', self: 'end', offset: -10 },
        y: { at: 'center', self: 'center' },
      },
    }),
    newNode({
      id: 'sibling',
      type: 'rect',
      height: 30,
      layout: {
        reference: { nodeId: 'panel' },
        x: { at: 'end', self: 'start', offset: 12 },
        y: { at: 'start', self: 'start' },
      },
    }),
    newNode({
      id: 'stretch',
      type: 'rect',
      layout: { reference: 'scene', insets: { left: 20, right: 20, top: 10, bottom: 10 } },
    }),
    newNode({ id: 'ratio', type: 'rect', layout: { width: { value: 0.25 }, aspectRatio: 2 } }),
  ];
  const result = evaluateDrivers(nodes, ctx).nodes;
  expect(result[0]).toMatchObject({ x: 120, y: 80 });
  expect(result[1]).toMatchObject({ width: 200, x: 190, y: 75 });
  expect(result[2]).toMatchObject({ x: 532, y: 80 });
  expect(result[3]).toMatchObject({ x: 20, y: 10, width: 600, height: 340 });
  expect(result[4]).toMatchObject({ width: 160, height: 80 });
});
it('samples curved SVG by arc length with endpoint tangents, reverse pingpong and native arc normalization', () => {
  const prepared = prepareCurvePath('M 0 0 C 0 100 100 100 100 0');
  expect(prepared.length).toBeCloseTo(200, 3);
  expect(sampleCurvePath(prepared, 0.5)).toMatchObject({ x: 50, y: 75 });
  expect(sampleCurvePath(prepared, 0).rotation).toBeCloseTo(90);
  expect(sampleCurvePath(prepared, 1).rotation).toBeCloseTo(-90);
  expect(Math.abs(sampleCurvePath(prepared, 1.5, 'pingpong').rotation)).toBeCloseTo(180);
  const arc = prepareCurvePath('M 0 0 A 50 50 0 0 1 100 0');
  expect(arc.length).toBeCloseTo(Math.PI * 50, 1);
  expect(sampleCurvePath('M 0 0 L 100 0', 0.5)).toMatchObject({ x: 50, y: 0, rotation: 0 });
});
it('combines expressions driving path progress, transformed path references and responsive sizes', () => {
  const nodes = [
    newNode({ id: 'curve', type: 'path', x: 50, y: 30, path: 'M0 0 C0 100 100 100 100 0' }),
    newNode({
      id: 'marker',
      type: 'rect',
      width: 20,
      height: 10,
      expressions: { 'motionPath.progress': 'time' },
      motionPath: { nodeId: 'curve', anchor: 'center', autoRotate: true },
    }),
  ];
  const node = evaluateDrivers(nodes, ctx).nodes[1];
  expect(node.x).toBeCloseTo(90);
  expect(node.y).toBeCloseTo(100);
  expect(node.rotation).toBeCloseTo(0);
});
it('parses precedence, scientific numbers, escaped references and short-circuit conditions without evaluating code', () => {
  const nodes = [
    newNode({ id: "a'b", type: 'rect', x: 12 }),
    newNode({
      id: 'value',
      type: 'rect',
      expressions: {
        x: "layer('a\\'b').x + 2 ** 3 ** 2 + 1.2e2 / 3",
        y: 'false && (1 / 0) ? 3 : (2 + 3) * 4',
        rotation: '/* stable */ random(4) * 100',
      },
    }),
  ];
  const result = evaluateDrivers(nodes, ctx).nodes[1];
  expect(result.x).toBe(564);
  expect(result.y).toBe(20);
  expect(evaluateDrivers(nodes, ctx).nodes[1].rotation).toBe(result.rotation);
  for (const expression of [
    '1; process.exit()',
    '1 = 2',
    'sin(1,)',
    'layer(frame).x',
    '(1 + 2',
    'self[frame]',
    '`hello`',
  ])
    expect(
      () =>
        evaluateDrivers([newNode({ id: 'x', type: 'rect', expressions: { x: expression } })], ctx),
      expression,
    ).toThrow();
});
