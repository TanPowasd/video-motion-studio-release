import { it, expect } from 'vitest';
import { newNode } from '../src/core/model.js';
import {
  cameraMatrix,
  canvasTarget,
  marqueeLayers,
  movingLayers,
  pointerSelection,
  toggleSelection,
  identity,
  inverse,
  movePatch,
  multiply,
  nodeMatrix,
  parentDelta,
  pickLayer,
  transform,
  type InteractionLayer,
} from '../src/core/interaction.js';
import { evaluateNode } from '../src/core/time.js';
const layer = (id: string, options: Partial<InteractionLayer> = {}): InteractionLayer => ({
  node: newNode({ id, type: 'text', text: id }),
  path: [],
  matrix: [...identity],
  parentMatrix: [...identity],
  bounds: { x: 0, y: 0, width: 100, height: 50 },
  clips: [],
  container: false,
  ...options,
});
it('picks generated text directly, changes objects normally, and preserves a multi-selection when dragging a member', () => {
  const component = layer('code', {
      container: true,
      bounds: { x: 0, y: 0, width: 1000, height: 1000 },
    }),
    first = layer('code/first'),
    second = layer('code/second', { matrix: [1, 0, 0, 1, 200, 0] }),
    layers = [component, first, second];
  expect(canvasTarget(layers, [], { x: 20, y: 20 }, false)?.node.id).toBe(first.node.id);
  expect(canvasTarget(layers, [first.node.id], { x: 220, y: 20 }, false)?.node.id).toBe(
    second.node.id,
  );
  expect(canvasTarget(layers, [first.node.id], { x: 220, y: 20 }, true)?.node.id).toBe(
    second.node.id,
  );
  expect(canvasTarget(layers, [first.node.id], { x: 1200, y: 20 }, false)).toBeUndefined();
  expect(pointerSelection([first.node.id], second.node.id, true)).toEqual([
    first.node.id,
    second.node.id,
  ]);
  expect(pointerSelection([first.node.id, second.node.id], first.node.id, false)).toEqual([
    first.node.id,
    second.node.id,
  ]);
  expect(pointerSelection([first.node.id], second.node.id, false)).toEqual([second.node.id]);
  expect(toggleSelection([first.node.id, second.node.id], first.node.id)).toEqual([second.node.id]);
});
it('marquee selection respects transformed bounds and moving parent plus child does not double the displacement', () => {
  const group = layer('g', { container: true }),
    first = layer('a', {
      node: newNode({ id: 'a', parentId: 'g', type: 'text' }),
      matrix: [1, 0, 0, 1, 20, 20],
    }),
    other = layer('b', { matrix: [1, 0, 0, 1, 300, 20] }),
    layers = [group, first, other];
  expect(marqueeLayers(layers, { x: 10, y: 10 }, { x: 150, y: 100 })).toEqual(['a']);
  expect(movingLayers(layers, ['g', 'a', 'b']).map((l) => l.node.id)).toEqual(['g', 'b']);
});
it('converts a world drag through rotated, mirrored, anchored parents and camera without drift', () => {
  const parent = multiply(
      cameraMatrix({ x: 120, y: -40, rotation: 25, zoom: 1.7 }, 1280, 720),
      nodeMatrix(
        newNode({
          id: 'g',
          type: 'group',
          x: 300,
          y: 180,
          rotation: 90,
          scaleX: 2,
          scaleY: -0.5,
          originX: 40,
          originY: 25,
        }),
      ),
    ),
    target = layer('text', { parentMatrix: parent }),
    delta = { x: 72, y: -31 },
    local = parentDelta(target, delta)!;
  const a = transform(parent, { x: 10, y: 20 }),
    b = transform(parent, { x: 10 + local.x, y: 20 + local.y });
  expect(b.x - a.x).toBeCloseTo(delta.x, 10);
  expect(b.y - a.y).toBeCloseTo(delta.y, 10);
  expect(inverse([0, 0, 0, 1, 0, 0])).toBeUndefined();
});
it('picks in actual transformed bounds, excludes clipping and uses paint order', () => {
  const low = layer('low'),
    top = layer('top', {
      matrix: [0, 1, -1, 0, 100, 0],
      clips: [{ matrix: identity, bounds: { x: 60, y: 0, width: 40, height: 35 } }],
    });
  expect(pickLayer([low, top], { x: 80, y: 20 })?.node.id).toBe('top');
  expect(pickLayer([low, top], { x: 80, y: 45 })?.node.id).toBe('low');
  expect(pickLayer([low, top], { x: 40, y: 20 })?.node.id).toBe('low');
});
it('moving animated text edits the current keyframe without removing its animation', () => {
  const node = newNode({
      id: 'text',
      type: 'text',
      x: 0,
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 60, value: 120, easing: 'linear' },
          ],
        },
      ],
    }),
    patch = movePatch(node, 30, { x: 17.25, y: -10 }),
    updated = { ...node, ...patch };
  expect(evaluateNode(updated, 30).x).toBe(77.25);
  expect(patch.animations?.[0].keys.map((k) => k.frame)).toEqual([0, 30, 60]);
  expect(node.animations[0].keys).toHaveLength(2);
});
it('a drawing above text intercepts only its brush marks, not its full canvas', () => {
  const text = layer('text'),
    drawing = layer('drawing', {
      node: newNode({ id: 'drawing', type: 'drawing' }),
      bounds: { x: 0, y: 0, width: 100, height: 100 },
      strokes: {
        width: 6,
        points: [
          { x: 0, y: 0, pressure: 1 },
          { x: 100, y: 100, pressure: 1 },
        ],
      },
    });
  expect(pickLayer([text, drawing], { x: 80, y: 20 })?.node.id).toBe('text');
  expect(pickLayer([text, drawing], { x: 20, y: 20 })?.node.id).toBe('drawing');
});
