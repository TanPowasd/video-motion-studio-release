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
  selectionHit,
  resizePatch,
  handleCorners,
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

// Regression: "选中一个图层的时候，想通过框框缩放是不可能的（因为会选到他下面的图层）".
// The selected layer's handles and border must beat layer picking.
it('selection handles and border win over the layer underneath (and on top) of the selected layer', () => {
  const lower = layer('panel', {
      node: newNode({ id: 'panel', type: 'rect', width: 420, height: 360 }),
      matrix: [1, 0, 0, 1, 1250, 100],
      bounds: { x: 0, y: 0, width: 420, height: 360 },
    }),
    moon = layer('moon', {
      node: newNode({ id: 'moon', type: 'ellipse', width: 220, height: 220 }),
      matrix: [1, 0, 0, 1, 1350, 170],
      bounds: { x: 0, y: 0, width: 220, height: 220 },
    }),
    cover = layer('cover', {
      node: newNode({ id: 'cover', type: 'rect', width: 100, height: 100 }),
      matrix: [1, 0, 0, 1, 1520, 340],
      bounds: { x: 0, y: 0, width: 100, height: 100 },
    }),
    layers = [lower, moon, cover],
    corner = { x: 1570, y: 390 },
    nearCorner = { x: 1350 + 223, y: 170 + 223 };
  // The old path: the ellipse's box corner is outside the ellipse, so picking found the cover/panel.
  expect(canvasTarget(layers, ['moon'], { x: 1352, y: 172 }, false, 3)?.node.id).toBe('panel');
  // Handles: exactly on and a few px off each corner, even under another layer (cover) on top.
  expect(selectionHit(layers, ['moon'], corner, 8)).toMatchObject({ kind: 'handle', handle: 3 });
  expect(selectionHit(layers, ['moon'], nearCorner, 8)).toMatchObject({
    kind: 'handle',
    handle: 3,
  });
  expect(selectionHit(layers, ['moon'], { x: 1352, y: 172 }, 8)).toMatchObject({
    kind: 'handle',
    handle: 0,
  });
  expect(selectionHit(layers, ['moon'], { x: 1350 + 220, y: 165 }, 8)?.layer.node.id).toBe('moon');
  // Border (outside the ellipse shape, over the panel) → the selected layer, as a move.
  expect(selectionHit(layers, ['moon'], { x: 1460, y: 168 }, 8)).toMatchObject({ kind: 'frame' });
  // Interior and far away fall through to normal picking.
  expect(selectionHit(layers, ['moon'], { x: 1460, y: 280 }, 8)).toBeUndefined();
  expect(selectionHit(layers, ['moon'], { x: 1300, y: 120 }, 8)).toBeUndefined();
  // Nothing selected → no chrome.
  expect(selectionHit(layers, [], corner, 8)).toBeUndefined();
});
it('handle hit radius is in screen pixels: it scales with zoom and shrinks inside small layers', () => {
  const dot = layer('dot', {
    node: newNode({ id: 'dot', type: 'rect', width: 8, height: 8 }),
    matrix: [1, 0, 0, 1, 100, 100],
    bounds: { x: 0, y: 0, width: 8, height: 8 },
  });
  // 8 screen px at 25% zoom = 32 canvas units, at 400% = 2 canvas units.
  expect(selectionHit([dot], ['dot'], { x: 80, y: 80 }, 32)).toMatchObject({ handle: 0 });
  expect(selectionHit([dot], ['dot'], { x: 97, y: 97 }, 2)).toBeUndefined();
  expect(selectionHit([dot], ['dot'], { x: 99, y: 99 }, 2)).toMatchObject({ handle: 0 });
  // Inside a tiny layer only the outer quarter is a handle; its centre is the body (frame/move).
  expect(selectionHit([dot], ['dot'], { x: 104, y: 104 }, 8)?.kind).toBe('frame');
  expect(selectionHit([dot], ['dot'], { x: 101, y: 101 }, 8)).toMatchObject({ handle: 0 });
  // Outside the box the full radius applies (handles next to the canvas edge stay grabbable).
  expect(selectionHit([dot], ['dot'], { x: 113, y: 113 }, 8)).toMatchObject({ handle: 3 });
});
it('resizes from a corner keeping the opposite corner fixed, through rotation and parents', () => {
  const rect = newNode({ id: 'r', type: 'rect', x: 100, y: 50, width: 200, height: 100 }),
    r = layer('r', {
      node: rect,
      matrix: nodeMatrix(rect),
      bounds: { x: 0, y: 0, width: 200, height: 100 },
    });
  const br = resizePatch(r, 0, 3, { x: 400, y: 250 })!;
  expect(br.patch).toMatchObject({ x: 100, y: 50, width: 300, height: 200 });
  const tl = resizePatch(r, 0, 0, { x: 50, y: 0 })!;
  expect(tl.patch).toMatchObject({ x: 50, y: 0, width: 250, height: 150 });
  // Shift: uniform scale. No flipping past the anchor.
  expect(resizePatch(r, 0, 3, { x: 500, y: 160 }, true)!.patch).toMatchObject({
    width: 400,
    height: 200,
  });
  const flipped = resizePatch(r, 0, 3, { x: 0, y: 0 })!.patch;
  expect(flipped.width).toBeGreaterThan(0);
  expect(flipped.height).toBeGreaterThan(0);
  // Rotated + scaled group parent, rotated child: the anchor corner does not drift.
  const parentNode = newNode({ id: 'g', type: 'group', x: 300, y: 200, rotation: 30, scaleX: 2 }),
    parent = nodeMatrix(parentNode),
    child = newNode({
      id: 'c',
      type: 'ellipse',
      parentId: 'g',
      x: 10,
      y: 20,
      width: 80,
      height: 40,
      rotation: 45,
      originX: 40,
      originY: 20,
    }),
    c = layer('c', {
      node: child,
      parentMatrix: parent,
      matrix: multiply(parent, nodeMatrix(child)),
      bounds: { x: 0, y: 0, width: 80, height: 40 },
    }),
    anchorBefore = transform(c.matrix, handleCorners(c)[0]),
    target = transform(c.matrix, { x: 120, y: 70 }),
    res = resizePatch(c, 0, 3, target)!,
    moved = { ...child, ...res.patch } as typeof child,
    m2 = multiply(parent, nodeMatrix(moved));
  expect(res.patch.width).toBeCloseTo(120, 1);
  expect(res.patch.height).toBeCloseTo(70, 1);
  const anchorAfter = transform(m2, { x: 0, y: 0 });
  expect(anchorAfter.x).toBeCloseTo(anchorBefore.x, 1);
  expect(anchorAfter.y).toBeCloseTo(anchorBefore.y, 1);
  const cornerAfter = transform(m2, { x: res.patch.width!, y: res.patch.height! });
  expect(cornerAfter.x).toBeCloseTo(target.x, 1);
  expect(cornerAfter.y).toBeCloseTo(target.y, 1);
});
it('resizes text (ink bounds) by scale and keys animated properties', () => {
  const text = newNode({
      id: 't',
      type: 'text',
      x: 100,
      y: 100,
      animations: [
        {
          property: 'scaleX',
          keys: [
            { frame: 0, value: 1, easing: 'linear' },
            { frame: 30, value: 1, easing: 'linear' },
          ],
        },
      ],
    } as any),
    t = layer('t', {
      node: text,
      matrix: nodeMatrix(text),
      bounds: { x: 4, y: 10, width: 200, height: 50 },
    }),
    res = resizePatch(t, 12, 3, { x: 100 + 4 + 400, y: 100 + 10 + 100 })!;
  expect(res.patch.scaleX).toBeCloseTo(2, 4);
  expect(res.patch.scaleY).toBeCloseTo(2, 4);
  expect(res.patch.width).toBeUndefined();
  // Top-left ink corner stays put: x' + 4·2 = 100 + 4.
  expect(res.patch.x).toBeCloseTo(96, 2);
  expect(res.patch.y).toBeCloseTo(90, 2);
  const channel = res.patch.animations!.find((a) => a.property === 'scaleX')!;
  expect(channel.keys.map((k) => k.frame)).toEqual([0, 12, 30]);
});
