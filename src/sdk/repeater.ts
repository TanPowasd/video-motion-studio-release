import { newNode, nodeSchema, VmotionError, type Node } from '../core/model.js';
import { identity, multiply, transform, type Matrix } from '../core/interaction.js';
import { indexGraph } from '../core/graph.js';
import {
  repeaterOptionsSchema,
  repeatDescribeSchema,
  type RepeaterOptions,
} from '../core/repeater-schema.js';
import type { z } from 'zod';
import type { Vec2 } from './motion.js';
export { repeaterParameters } from '../core/repeater-schema.js';
export type { RepeaterOptions } from '../core/repeater-schema.js';
export type CopyContext = {
  index: number;
  transformIndex: number;
  count: number;
  progress: number;
};
const translation = (x: number, y: number): Matrix => [1, 0, 0, 1, x, y];
export function affineMatrix(
  options: { position?: Vec2; rotation?: number; scale?: Vec2; pivot?: Vec2; skew?: number } = {},
): Matrix {
  const {
    position = { x: 0, y: 0 },
    rotation = 0,
    scale = { x: 1, y: 1 },
    pivot = { x: 0, y: 0 },
    skew = 0,
  } = options;
  if (
    ![position.x, position.y, rotation, scale.x, scale.y, pivot.x, pivot.y, skew].every(
      Number.isFinite,
    ) ||
    Math.abs(skew) >= 90
  )
    throw new VmotionError(
      'AFFINE_RANGE',
      'Affine values must be finite and skew must be between -90 and 90 degrees',
    );
  const angle = ((rotation % 360) * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle),
    shear = Math.tan((skew * Math.PI) / 180);
  const linear = multiply([c, s, -s, c, 0, 0], [scale.x, 0, shear * scale.y, scale.y, 0, 0]);
  return multiply(
    translation(position.x + pivot.x, position.y + pivot.y),
    multiply(linear, translation(-pivot.x, -pivot.y)),
  );
}
export function repeaterMatrix(raw: RepeaterOptions, index: number): Matrix {
  const o = repeaterOptionsSchema.parse(raw),
    j = index + o.offset;
  if ((o.scale.x < 0 || o.scale.y < 0) && !Number.isInteger(j))
    throw new VmotionError(
      'REPEATER_SCALE',
      'Negative step scales require integer transform indices; use an integer offset or mirror the source layer',
    );
  if (!Number.isInteger(index) || index < 0 || index >= 512)
    throw new VmotionError('REPEATER_INDEX', 'Copy index must be an integer in 0–511');
  let position = { x: o.position.x * j, y: o.position.y * j },
    rotation = o.rotation * j;
  if (o.mode === 'grid') {
    const row = Math.floor(j / o.columns),
      column = j - row * o.columns;
    position = { x: column * o.gap.x, y: row * o.gap.y };
  } else if (o.mode === 'radial') {
    const angle = o.angleStart + j * o.angleStep,
      radians = ((angle % 360) * Math.PI) / 180;
    position = { x: o.radius * Math.cos(radians), y: o.radius * Math.sin(radians) };
    rotation += o.orientation === 'fixed' ? 0 : angle + (o.orientation === 'tangent' ? 90 : 0);
  }
  // Each transform component is indexed explicitly, rather than multiplying an approximate TRS decomposition.
  const matrix = affineMatrix({
    position,
    rotation,
    scale: { x: o.scale.x ** j, y: o.scale.y ** j },
    pivot: o.pivot,
    skew: Math.max(-85, Math.min(85, o.skew * j)),
  });
  if (matrix.some((value) => !Number.isFinite(value) || Math.abs(value) > 1e12))
    throw new VmotionError(
      'REPEATER_RANGE',
      'Repeat transform exceeds the finite coordinate range; reduce scale, offset or count',
    );
  return matrix;
}
export function repeatGraph(
  id: string,
  source: Node[] | ((copy: CopyContext) => Node[]),
  raw: RepeaterOptions = {},
): Node[] {
  const o = repeaterOptionsSchema.parse(raw),
    count = Math.ceil(o.count);
  if (!count) return [];
  const shared =
    typeof source === 'function' ? undefined : source.map((node) => nodeSchema.parse(node));
  if (shared) indexGraph(shared);
  const nodes: Node[] = [newNode({ id, type: 'group', name: '重复器' })];
  const indices = Array.from({ length: count }, (_, i) => i);
  if (o.reverse) indices.reverse();
  for (const index of indices) {
    const progress = count > 1 ? index / (count - 1) : 0,
      children =
        shared ??
        (source as (copy: CopyContext) => Node[])({
          index,
          transformIndex: index + o.offset,
          count,
          progress,
        }).map((n) => nodeSchema.parse(n));
    if (!shared) indexGraph(children);
    if (nodes.length + children.length + 1 > 20000)
      throw new VmotionError('REPEATER_LIMIT', 'Repeat graph exceeds the 20000-node budget');
    const copyId = `${id}/copy-${index}`,
      fraction = Math.min(1, Math.max(0, o.count - index));
    nodes.push(
      newNode({
        id: copyId,
        type: 'group',
        parentId: id,
        name: `副本 ${index + 1}`,
        matrix: repeaterMatrix(o, index),
        opacity: (o.startOpacity + (o.endOpacity - o.startOpacity) * progress) * fraction,
      }),
    );
    for (const original of children) {
      const node = structuredClone(original);
      node.id = `${copyId}/${original.id}`;
      if (node.id.length > 200)
        throw new VmotionError(
          'REPEATER_ID',
          'Repeated IDs exceed 200 characters; use shorter source IDs',
        );
      node.parentId = original.parentId ? `${copyId}/${original.parentId}` : copyId;
      if (original.maskId) node.maskId = `${copyId}/${original.maskId}`;
      nodes.push(node);
    }
  }
  indexGraph(nodes);
  return nodes;
}
export const repeatGrid = (
  id: string,
  source: Parameters<typeof repeatGraph>[1],
  options: RepeaterOptions = {},
) => repeatGraph(id, source, { ...options, mode: 'grid' });
export const repeatRadial = (
  id: string,
  source: Parameters<typeof repeatGraph>[1],
  options: RepeaterOptions = {},
) => repeatGraph(id, source, { ...options, mode: 'radial' });
export const identityMatrix = (): Matrix => [...identity];
export function describeRepeater(raw: z.input<typeof repeatDescribeSchema> = {}) {
  const request = repeatDescribeSchema.parse(raw),
    o = request.parameters,
    count = Math.ceil(o.count),
    indices = request.indices ?? (count ? [0, Math.floor((count - 1) / 2), count - 1] : []),
    copies = Array.from(new Set(indices)).map((index) => {
      if (index >= count)
        throw new VmotionError('REPEATER_INDEX', 'Requested copy is outside the current count');
      const progress = count > 1 ? index / (count - 1) : 0;
      return {
        index,
        id: `copies/copy-${index}`,
        matrix: repeaterMatrix(o, index),
        opacity:
          (o.startOpacity + (o.endOpacity - o.startOpacity) * progress) *
          Math.min(1, o.count - index),
      };
    });
  let bounds: { x: number; y: number; width: number; height: number } | undefined;
  if (request.sourceBounds && count) {
    const b = request.sourceBounds,
      points = Array.from({ length: count }, (_, index) => {
        const matrix = repeaterMatrix(o, index);
        return [
          { x: b.x, y: b.y },
          { x: b.x + b.width, y: b.y },
          { x: b.x + b.width, y: b.y + b.height },
          { x: b.x, y: b.y + b.height },
        ].map((p) => transform(matrix, p));
      }).flat();
    if (points.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y)))
      throw new VmotionError('REPEATER_RANGE', 'Pattern bounds are not finite');
    const x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    bounds = {
      x,
      y,
      width: Math.max(...points.map((p) => p.x)) - x,
      height: Math.max(...points.map((p) => p.y)) - y,
    };
  }
  return {
    parameters: o,
    count,
    copies,
    bounds,
    limits: { copies: 512, nodes: 20000 },
    limitations: [
      'Bounds transform the supplied source rectangle; masks, effects and clipping require actual frame inspection.',
    ],
  };
}
