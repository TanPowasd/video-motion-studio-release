import { z } from 'zod';
import type { InteractionLayer, Bounds } from './interaction.js';
import { VmotionError } from './model.js';
import {
  boundsPolygon,
  clipPolygon,
  polygonBounds,
  polygonsArea,
  overlapArea,
  type Polygon,
} from './geometry.js';
export const visualOptionsSchema = z
  .object({
    nodeIds: z.array(z.string()).max(1000).optional(),
    ignoreNodeIds: z.array(z.string()).max(1000).default([]),
    overflowRatio: z.number().min(0).max(1).default(0.05),
    overlapRatio: z.number().min(0).max(1).default(0.08),
    occlusionRatio: z.number().min(0).max(1).default(0.2),
    minOpacity: z.number().min(0).max(1).default(0.1),
    maxScreensPerSecond: z.number().positive().default(2),
    maxStepFraction: z.number().positive().default(0.15),
    maxFindings: z.number().int().min(1).max(1000).default(200),
  })
  .strict();
export type VisualOptions = z.output<typeof visualOptionsSchema>;
export type VisualFinding = {
  code:
    | 'TEXT_TRUNCATED'
    | 'TEXT_OUTSIDE_CANVAS'
    | 'TEXT_CLIPPED'
    | 'TEXT_OVERLAP'
    | 'TEXT_COVERED'
    | 'FAST_MOTION'
    | 'MOTION_JUMP'
    | 'FRAME_ERROR';
  severity: 'error' | 'review';
  frame: number;
  previousFrame?: number;
  nodeId: string;
  relatedNodeId?: string;
  name: string;
  path: string[];
  contextFrames?: number[];
  localFrame?: number;
  message: string;
  bounds?: Bounds;
  ratio?: number;
  metrics?: Record<string, number>;
  uncertainty?: string[];
};
export type LayerGeometry = {
  layer: InteractionLayer;
  raw: Polygon[];
  clipped: Polygon[];
  visible: Polygon[];
  bounds: Bounds;
  area: number;
  clippedArea: number;
  visibleArea: number;
};
export function auditGeometry(
  layers: InteractionLayer[],
  width: number,
  height: number,
): LayerGeometry[] {
  const canvas = boundsPolygon({ x: 0, y: 0, width, height }, [1, 0, 0, 1, 0, 0]);
  return layers.map((layer) => {
    if (!layer.matrix.every(Number.isFinite) || !Object.values(layer.bounds).every(Number.isFinite))
      throw new VmotionError('VISUAL_TRANSFORM', 'Layer geometry contains a nonfinite transform', {
        nodeId: layer.node.id,
        path: layer.node.id,
      });
    const raw = layer.contentPolygons ?? [boundsPolygon(layer.bounds, layer.matrix)],
      clipped = layer.clips.reduce(
        (polygons, clip) =>
          polygons
            .map((p) => clipPolygon(p, boundsPolygon(clip.bounds, clip.matrix)))
            .filter((p) => p.length >= 3),
        raw,
      ),
      visible = clipped.map((p) => clipPolygon(p, canvas)).filter((p) => p.length >= 3);
    if (
      raw.some((polygon) => polygon.some((p) => !Number.isFinite(p.x) || !Number.isFinite(p.y))) ||
      !Number.isFinite(polygonsArea(raw))
    )
      throw new VmotionError(
        'VISUAL_TRANSFORM',
        'Layer geometry exceeds finite coordinate bounds',
        { path: layer.node.id },
      );
    return {
      layer,
      raw,
      clipped,
      visible,
      bounds: polygonBounds(raw),
      area: polygonsArea(raw),
      clippedArea: polygonsArea(clipped),
      visibleArea: polygonsArea(visible),
    };
  });
}
const visible = (layer: InteractionLayer, options: VisualOptions) =>
  (layer.opacity ?? 1) >= options.minOpacity &&
  !options.ignoreNodeIds.includes(layer.node.id) &&
  !(layer.node.type === 'text' && layer.node.fill === 'transparent' && !layer.node.strokeWidth);
const enabled = (layer: InteractionLayer, options: VisualOptions) =>
  visible(layer, options) && (!options.nodeIds || options.nodeIds.includes(layer.node.id));
const intersects = (a: Bounds, b: Bounds) =>
  a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
export function auditFrame(
  layers: InteractionLayer[],
  width: number,
  height: number,
  frame: number,
  options: VisualOptions,
) {
  const geometry = auditGeometry(layers, width, height),
    findings: VisualFinding[] = [],
    budget = { remaining: 100000 };
  let omitted = 0;
  const push = (finding: VisualFinding) => {
    if (findings.length < options.maxFindings) findings.push(finding);
    else omitted++;
  };
  for (const current of geometry) {
    const { layer, area, clippedArea, visibleArea } = current;
    if (layer.node.type !== 'text' || !enabled(layer, options)) continue;
    const base = {
      frame,
      nodeId: layer.node.id,
      name: layer.node.name,
      path: layer.path,
      bounds: current.bounds,
      uncertainty: layer.uncertainty ?? [],
    };
    if (layer.textLayout?.truncatedCharacters)
      push({
        ...base,
        code: 'TEXT_TRUNCATED',
        severity: 'error',
        message: '文字内容因图层高度不足而未绘制',
        metrics: {
          lines: layer.textLayout.lineCount,
          renderedLines: layer.textLayout.renderedLineCount,
          truncatedCharacters: layer.textLayout.truncatedCharacters,
        },
      });
    if (area > 0.1) {
      const clipLoss = Math.max(0, 1 - clippedArea / area),
        canvasLoss = clippedArea > 0 ? Math.max(0, 1 - visibleArea / clippedArea) : 0;
      if (clipLoss > options.overflowRatio)
        push({
          ...base,
          code: 'TEXT_CLIPPED',
          severity: 'review',
          ratio: clipLoss,
          message: '文字几何范围被图层或父级裁剪，请确认是否有意',
        });
      if (canvasLoss > options.overflowRatio)
        push({
          ...base,
          code: 'TEXT_OUTSIDE_CANVAS',
          severity: 'review',
          ratio: canvasLoss,
          message: '文字几何范围超出当前画布，请检查构图或入场动画',
        });
    }
  }
  const texts = geometry.filter(
    (g) => g.layer.node.type === 'text' && visible(g.layer, options) && g.visibleArea > 0.1,
  );
  let pairs = 100000;
  for (let i = 0; i < texts.length; i++) {
    if (pairs < 0) break;
    for (let j = i + 1; j < texts.length; j++) {
      if (--pairs < 0) {
        omitted++;
        break;
      }
      const a = texts[i],
        b = texts[j];
      if (!enabled(a.layer, options) && !enabled(b.layer, options)) continue;
      if (!intersects(a.bounds, b.bounds)) continue;
      const area = overlapArea(a.visible, b.visible, budget);
      if (area === undefined) {
        omitted++;
        continue;
      }
      const ratio = Math.min(1, area / Math.min(a.visibleArea, b.visibleArea));
      if (ratio > options.overlapRatio)
        push({
          frame,
          code: 'TEXT_OVERLAP',
          severity: 'review',
          nodeId: enabled(a.layer, options) ? a.layer.node.id : b.layer.node.id,
          relatedNodeId: enabled(a.layer, options) ? b.layer.node.id : a.layer.node.id,
          name: enabled(a.layer, options) ? a.layer.node.name : b.layer.node.name,
          path: enabled(a.layer, options) ? a.layer.path : b.layer.path,
          bounds: polygonBounds([...a.visible, ...b.visible]),
          ratio,
          message: '两个文字图层的可见范围重叠，请目视确认排版',
          uncertainty: [
            ...new Set([
              ...(a.layer.uncertainty ?? []),
              ...(b.layer.uncertainty ?? []),
              'glyph-bounds',
            ]),
          ],
        });
    }
  }
  for (const text of texts) {
    if (!enabled(text.layer, options)) continue;
    if (pairs < 0) break;
    const index = geometry.indexOf(text);
    for (const covering of geometry.slice(index + 1)) {
      if (--pairs < 0) {
        omitted++;
        break;
      }
      const layer = covering.layer,
        n = layer.node;
      if (
        layer.container ||
        options.ignoreNodeIds.includes(n.id) ||
        n.type !== 'rect' ||
        n.gradient ||
        n.radius > 0 ||
        (layer.opacity ?? 1) < 0.98 ||
        layer.uncertainty?.length ||
        !/^#[0-9a-f]{6}$/i.test(n.fill) ||
        covering.visibleArea < 0.1 ||
        !intersects(text.bounds, covering.bounds)
      )
        continue;
      const area = overlapArea(text.visible, covering.visible, budget);
      if (area === undefined) {
        omitted++;
        continue;
      }
      const ratio = Math.min(1, area / text.visibleArea);
      if (ratio > options.occlusionRatio)
        push({
          frame,
          code: 'TEXT_COVERED',
          severity: 'review',
          nodeId: text.layer.node.id,
          relatedNodeId: n.id,
          name: text.layer.node.name,
          path: text.layer.path,
          bounds: text.bounds,
          ratio,
          message: '后绘制的不透明矩形覆盖文字范围，请确认图层顺序',
          uncertainty: [...(text.layer.uncertainty ?? []), 'glyph-bounds'],
        });
    }
  }
  return { findings, omitted, geometry };
}
export function auditMotion(
  before: LayerGeometry[],
  after: LayerGeometry[],
  previousFrame: number,
  frame: number,
  fps: number,
  width: number,
  height: number,
  options: VisualOptions,
) {
  const dt = frame - previousFrame;
  if (dt <= 0) return [];
  const diagonal = Math.hypot(width, height),
    old = new Map(before.map((g) => [g.layer.node.id, g])),
    findings: VisualFinding[] = [];
  for (const current of after) {
    const layer = current.layer,
      previous = old.get(layer.node.id);
    if (
      layer.container ||
      layer.node.type === 'path' ||
      layer.node.type === 'drawing' ||
      layer.node.id.split('/').at(-1) === 'background' ||
      !enabled(layer, options) ||
      !previous ||
      !enabled(previous.layer, options) ||
      current.visibleArea < 0.1 ||
      previous.visibleArea < 0.1
    )
      continue;
    const delta = Math.hypot(
        layer.matrix[4] - previous.layer.matrix[4],
        layer.matrix[5] - previous.layer.matrix[5],
      ),
      screensPerSecond = ((delta / diagonal) * fps) / dt,
      stepFraction = delta / diagonal;
    if (
      screensPerSecond <= options.maxScreensPerSecond &&
      !(dt <= 1 && stepFraction > options.maxStepFraction)
    )
      continue;
    findings.push({
      frame,
      previousFrame,
      code: dt <= 1 && stepFraction > options.maxStepFraction ? 'MOTION_JUMP' : 'FAST_MOTION',
      severity: 'review',
      nodeId: layer.node.id,
      name: layer.node.name,
      path: layer.path,
      bounds: current.bounds,
      message:
        dt <= 1
          ? '相邻检查帧出现较大位移，请确认跳切或运动连续性'
          : '两个采样时间点之间的位移速度较高，请确认节奏',
      metrics: { distancePixels: delta, frameInterval: dt, screensPerSecond, stepFraction },
      uncertainty: ['sampled-motion'],
    });
    if (findings.length >= options.maxFindings) break;
  }
  return findings;
}
