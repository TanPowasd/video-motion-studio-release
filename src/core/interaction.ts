import type { Node, Scene } from './model.js';
import { evaluateNode } from './time.js';

export type Matrix = [number, number, number, number, number, number];
export type Point = { x: number; y: number };
export type Bounds = Point & { width: number; height: number };
export type InteractionLayer = {
  frame?: number;
  contentFrame?: number;
  contextFrames?: number[];
  node: Node;
  evaluatedNode?: Node;
  path: string[];
  matrix: Matrix;
  parentMatrix: Matrix;
  bounds: Bounds;
  clips: Array<{ matrix: Matrix; bounds: Bounds }>;
  container: boolean;
  opacity?: number;
  contentPolygons?: Point[][];
  uncertainty?: string[];
  textLayout?: {
    lineCount: number;
    renderedLineCount: number;
    truncatedCharacters: number;
    fullLineCount?: number;
    requiredHeight?: number;
    counts?: { grapheme: number; word: number; line: number };
    overflowUnits?: number;
    pathLength?: number;
  };
  strokes?:
    { points: Node['points']; width: number } | Array<{ points: Node['points']; width: number }>;
};
export type InteractionGraph = {
  contextFrames?: number[];
  revision: string;
  frame: number;
  sceneId: string;
  path: string[];
  layers: InteractionLayer[];
};
export type CompositionDraft = {
  path: string[];
  nodeId: string;
  patch: Partial<Node>;
  frame?: number;
  contextFrames?: number[];
};
export const identity: Matrix = [1, 0, 0, 1, 0, 0];
export function multiply(a: Matrix, b: Matrix): Matrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}
export function transform(m: Matrix, p: Point): Point {
  return { x: m[0] * p.x + m[2] * p.y + m[4], y: m[1] * p.x + m[3] * p.y + m[5] };
}
export function inverse(m: Matrix): Matrix | undefined {
  const det = m[0] * m[3] - m[1] * m[2];
  if (Math.abs(det) < 1e-10) return;
  return [
    m[3] / det,
    -m[1] / det,
    -m[2] / det,
    m[0] / det,
    (m[2] * m[5] - m[3] * m[4]) / det,
    (m[1] * m[4] - m[0] * m[5]) / det,
  ];
}
export function nodeMatrix(n: Node): Matrix {
  const angle = (n.rotation * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle),
    a = c * n.scaleX,
    b = s * n.scaleX,
    d = c * n.scaleY,
    e = -s * n.scaleY;
  const trs: Matrix = [
    a,
    b,
    e,
    d,
    n.x + n.originX - a * n.originX - e * n.originY,
    n.y + n.originY - b * n.originX - d * n.originY,
  ];
  return multiply(trs, n.matrix);
}
export function cameraMatrix(camera: Scene['camera'], width: number, height: number): Matrix {
  if (!camera) return [...identity];
  const angle = (-camera.rotation * Math.PI) / 180,
    c = Math.cos(angle) * camera.zoom,
    s = Math.sin(angle) * camera.zoom;
  return [
    c,
    s,
    -s,
    c,
    width / 2 - c * (width / 2 + camera.x) + s * (height / 2 + camera.y),
    height / 2 - s * (width / 2 + camera.x) - c * (height / 2 + camera.y),
  ];
}
export function within(bounds: Bounds, p: Point, padding = 0) {
  return (
    p.x >= bounds.x - padding &&
    p.y >= bounds.y - padding &&
    p.x <= bounds.x + bounds.width + padding &&
    p.y <= bounds.y + bounds.height + padding
  );
}
export function localPoint(matrix: Matrix, p: Point) {
  const inv = inverse(matrix);
  return inv ? transform(inv, p) : undefined;
}
export function hitLayer(layer: InteractionLayer, p: Point, tolerance = 0) {
  for (const clip of layer.clips) {
    const q = localPoint(clip.matrix, p);
    if (!q || !within(clip.bounds, q)) return false;
  }
  const q = localPoint(layer.matrix, p);
  if (!q) return false;
  const scale = Math.max(
    1e-6,
    Math.min(
      Math.hypot(layer.matrix[0], layer.matrix[1]),
      Math.hypot(layer.matrix[2], layer.matrix[3]),
    ),
  );
  if (!within(layer.bounds, q, tolerance / scale)) return false;
  if (layer.strokes) {
    for (const stroke of Array.isArray(layer.strokes) ? layer.strokes : [layer.strokes]) {
      const { points, width } = stroke;
      if (
        points.length === 1 &&
        Math.hypot(q.x - points[0].x, q.y - points[0].y) <=
          Math.max(0.25, (width * points[0].pressure) / 2) + tolerance / scale
      )
        return true;
      for (let i = 1; i < points.length; i++) {
        const a = points[i - 1],
          b = points[i],
          dx = b.x - a.x,
          dy = b.y - a.y,
          t = Math.max(
            0,
            Math.min(1, ((q.x - a.x) * dx + (q.y - a.y) * dy) / (dx * dx + dy * dy || 1)),
          ),
          radius = Math.max(0.5, (width * (a.pressure + b.pressure)) / 2) / 2 + tolerance / scale;
        if (Math.hypot(q.x - a.x - t * dx, q.y - a.y - t * dy) <= radius) return true;
      }
    }
    return false;
  }
  if (layer.node.type === 'ellipse') {
    const n = layer.bounds,
      rx = n.width / 2 + tolerance / scale,
      ry = n.height / 2 + tolerance / scale;
    return (
      rx > 0 &&
      ry > 0 &&
      ((q.x - n.x - n.width / 2) / rx) ** 2 + ((q.y - n.y - n.height / 2) / ry) ** 2 <= 1
    );
  }
  return true;
}
export function pickLayer(layers: InteractionLayer[], p: Point, tolerance = 0) {
  // Container bounds are a fallback, so a full-canvas component cannot intercept its text.
  for (let i = layers.length - 1; i >= 0; i--)
    if (!layers[i].container && hitLayer(layers[i], p, tolerance)) return layers[i];
  for (let i = layers.length - 1; i >= 0; i--)
    if (layers[i].container && hitLayer(layers[i], p, tolerance)) return layers[i];
}
export function canvasTarget(
  layers: InteractionLayer[],
  selected: string[],
  p: Point,
  control: boolean,
  tolerance = 0,
) {
  const picked = pickLayer(
    layers.filter((l) => l.node.id.split('/').at(-1) !== 'background'),
    p,
    tolerance,
  );
  if (!control) {
    for (const layer of layers.filter((l) => selected.includes(l.node.id)).reverse()) {
      if (
        hitLayer(layer, p, tolerance) &&
        (!picked || picked.node.id === layer.node.id || isDescendant(layers, picked, layer))
      )
        return layer;
    }
  }
  // A full-canvas unselected container is empty space when none of its visible children was hit.
  return picked?.container ? undefined : picked;
}
export function isDescendant(
  layers: InteractionLayer[],
  child: InteractionLayer,
  parent: InteractionLayer,
) {
  if (child.path.includes(parent.node.id)) return true;
  let id = child.node.parentId;
  const visited = new Set<string>();
  while (id && !visited.has(id)) {
    if (id === parent.node.id) return true;
    visited.add(id);
    id = layers.find((l) => l.node.id === id)?.node.parentId;
  }
  return false;
}
export function movingLayers(layers: InteractionLayer[], selected: string[]) {
  const chosen = layers.filter((l) => selected.includes(l.node.id));
  return chosen.filter(
    (l) => !chosen.some((parent) => parent !== l && isDescendant(layers, l, parent)),
  );
}
export function pointerSelection(selected: string[], id: string, control: boolean) {
  if (control) return selected.includes(id) ? selected : [...selected, id];
  return selected.includes(id) ? selected : [id];
}
export function toggleSelection(selected: string[], id: string) {
  return selected.includes(id) ? selected.filter((value) => value !== id) : [...selected, id];
}
export function marqueeLayers(layers: InteractionLayer[], a: Point, b: Point) {
  const rect = {
    x: Math.min(a.x, b.x),
    y: Math.min(a.y, b.y),
    width: Math.abs(b.x - a.x),
    height: Math.abs(b.y - a.y),
  };
  return layers
    .filter((l) => {
      if (l.container || l.node.id.split('/').at(-1) === 'background') return false;
      const bounds = l.bounds,
        corners = [
          { x: bounds.x, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y },
          { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
          { x: bounds.x, y: bounds.y + bounds.height },
        ].map((p) => transform(l.matrix, p));
      return (
        corners.every((p) => within(rect, p)) &&
        corners.some((p) =>
          l.clips.every((c) => {
            const q = localPoint(c.matrix, p);
            return q && within(c.bounds, q);
          }),
        )
      );
    })
    .map((l) => l.node.id);
}
export function parentDelta(layer: InteractionLayer, delta: Point): Point | undefined {
  const inv = inverse(layer.parentMatrix);
  return inv
    ? { x: inv[0] * delta.x + inv[2] * delta.y, y: inv[1] * delta.x + inv[3] * delta.y }
    : undefined;
}
export function movePatch(node: Node, frame: number, delta: Point): Partial<Node> {
  const evaluated = evaluateNode(node, frame),
    x = Math.round((evaluated.x + delta.x) * 100) / 100,
    y = Math.round((evaluated.y + delta.y) * 100) / 100,
    animations = structuredClone(node.animations);
  let keyed = false;
  for (const property of ['x', 'y'] as const) {
    const channel = animations.find((a) => a.property === property);
    if (channel) {
      const keyFrame = Math.round(frame);
      channel.keys = channel.keys.filter((k) => k.frame !== keyFrame);
      channel.keys.push({ frame: keyFrame, value: property === 'x' ? x : y, easing: 'easeInOut' });
      channel.keys.sort((a, b) => a.frame - b.frame);
      keyed = true;
    }
  }
  return { x, y, ...(keyed ? { animations } : {}) };
}
