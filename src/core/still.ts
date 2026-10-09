/**
 * Still-image (poster / cover / thumbnail) helpers shared by the editor, service, CLI and MCP.
 * Pure functions only: no Node or DOM APIs, so the editor bundle can import them.
 */
import {
  movePatch,
  movingLayers,
  parentDelta,
  transform,
  type Bounds,
  type CompositionDraft,
  type InteractionLayer,
  type Point,
} from './interaction.js';
import { newNode, type Node, type Project, type Scene } from './model.js';
import { stillSchema, type StillSettings } from './still-schema.js';
export * from './still-schema.js';

export interface StillPreset {
  id: string;
  name: string;
  group: '印刷' | '社交' | '视频' | '通用';
  width: number;
  height: number;
  dpi: number;
  bleed: number;
  safeArea: number;
  note: string;
}
/** Print presets include 3mm bleed (36px at 300dpi) so trimmed export is exactly the paper size. */
export const stillPresets: StillPreset[] = [
  {
    id: 'poster-a4',
    name: '海报 A4',
    group: '印刷',
    width: 2552,
    height: 3580,
    dpi: 300,
    bleed: 36,
    safeArea: 59,
    note: '210×297mm · 300dpi · 成品 2480×3508，含 3mm 出血',
  },
  {
    id: 'poster-a3',
    name: '海报 A3',
    group: '印刷',
    width: 3580,
    height: 5033,
    dpi: 300,
    bleed: 36,
    safeArea: 59,
    note: '297×420mm · 300dpi · 成品 3508×4961，含 3mm 出血',
  },
  {
    id: 'xiaohongshu',
    name: '小红书 3:4',
    group: '社交',
    width: 1242,
    height: 1660,
    dpi: 72,
    bleed: 0,
    safeArea: 60,
    note: '1242×1660 · 笔记封面',
  },
  {
    id: 'wechat-cover',
    name: '公众号封面',
    group: '社交',
    width: 900,
    height: 383,
    dpi: 72,
    bleed: 0,
    safeArea: 24,
    note: '900×383 · 2.35:1 头图',
  },
  {
    id: 'video-cover-720',
    name: '视频封面 720p',
    group: '视频',
    width: 1280,
    height: 720,
    dpi: 72,
    bleed: 0,
    safeArea: 36,
    note: '1280×720 · 16:9 缩略图',
  },
  {
    id: 'video-cover-1080',
    name: '视频封面 1080p',
    group: '视频',
    width: 1920,
    height: 1080,
    dpi: 72,
    bleed: 0,
    safeArea: 54,
    note: '1920×1080 · 16:9 高清封面',
  },
  {
    id: 'square',
    name: '方图',
    group: '通用',
    width: 1080,
    height: 1080,
    dpi: 72,
    bleed: 0,
    safeArea: 54,
    note: '1080×1080 · 1:1',
  },
  {
    id: 'vertical',
    name: '竖屏',
    group: '通用',
    width: 1080,
    height: 1920,
    dpi: 72,
    bleed: 0,
    safeArea: 96,
    note: '1080×1920 · 9:16',
  },
];
export const stillPresetIds = stillPresets.map((p) => p.id) as [string, ...string[]];
export const findStillPreset = (id?: string) => stillPresets.find((p) => p.id === id);

export const stillTemplates = [
  { id: 'blank', name: '空白画板', description: '只有背景，从零开始排版' },
  { id: 'poster', name: '活动海报', description: '大标题、副标题、装饰圆和信息栏' },
  { id: 'cover', name: '视频封面', description: '色块、粗标题和标签，适合缩略图' },
  { id: 'card', name: '图文卡片', description: '浅色卡片、引言和署名，适合社交分享' },
] as const;
export type StillTemplateId = (typeof stillTemplates)[number]['id'];
export const stillTemplateIds = stillTemplates.map((t) => t.id) as [
  StillTemplateId,
  ...StillTemplateId[],
];

/** Canvas, trim and safe boxes of a still artboard in artboard pixels. */
export function stillGuides(scene: Pick<Scene, 'width' | 'height' | 'still'>, project: Pick<Project, 'width' | 'height'>) {
  const width = scene.width ?? project.width,
    height = scene.height ?? project.height,
    still = stillSchema.parse(scene.still ?? {}),
    bleed = Math.min(still.bleed, width / 2 - 1, height / 2 - 1),
    trim = { x: bleed, y: bleed, width: width - 2 * bleed, height: height - 2 * bleed },
    inset = Math.min(still.safeArea, trim.width / 2 - 1, trim.height / 2 - 1),
    safe = {
      x: trim.x + inset,
      y: trim.y + inset,
      width: trim.width - 2 * inset,
      height: trim.height - 2 * inset,
    };
  return { width, height, still, canvas: { x: 0, y: 0, width, height }, trim, safe };
}

/** Starter content. Positions derive from the safe box so every preset gets a sensible layout. */
export function stillTemplateNodes(
  template: StillTemplateId,
  width: number,
  height: number,
  settings: Pick<StillSettings, 'bleed' | 'safeArea'>,
): { background: string; nodes: Node[] } {
  const g = stillGuides(
      { width, height, still: { bleed: settings.bleed, safeArea: settings.safeArea } as StillSettings },
      { width, height },
    ),
    s = g.safe,
    u = Math.min(width, height) / 1080,
    landscape = width / height > 1.4,
    round = (v: number) => Math.round(v * 100) / 100;
  if (template === 'blank') return { background: '#ffffff', nodes: [] };
  if (template === 'poster') {
    // Stack from the bottom rule upwards so every aspect ratio keeps clear gaps.
    const titleSize = round(Math.min((landscape ? 120 : 150) * u, s.height * 0.16)),
      bodySize = round(40 * u),
      ruleY = round(s.y + s.height - 110 * u),
      subtitleY = round(ruleY - 60 * u - bodySize * 1.6),
      titleY = round(subtitleY - 30 * u - titleSize * 1.15 * 2),
      eyebrowY = round(titleY - bodySize * 1.6);
    return {
      background: '#0f1729',
      nodes: [
        newNode({
          id: 'orb',
          type: 'ellipse',
          name: '装饰圆',
          x: round(width - width * 0.62),
          y: round(-height * 0.08),
          width: round(width * 0.8),
          height: round(width * 0.8),
          fill: '#3b5bdb',
          gradient: {
            type: 'radial',
            center: { x: round(width * 0.4), y: round(width * 0.4) },
            radius: round(width * 0.4),
            stops: [
              { offset: 0, color: '#7c9cff' },
              { offset: 1, color: '#22336f' },
            ],
          },
        }),
        newNode({
          id: 'eyebrow',
          type: 'text',
          name: '眉标',
          text: 'VMOTION 2026',
          x: s.x,
          y: eyebrowY,
          width: s.width,
          height: round(bodySize * 1.5),
          fontSize: round(bodySize * 0.8),
          fontWeight: 600,
          fill: '#8fa7ff',
        }),
        newNode({
          id: 'title',
          type: 'text',
          name: '标题',
          text: '把想法\n变成画面',
          x: s.x,
          y: titleY,
          width: s.width,
          height: round(titleSize * 2.4),
          fontSize: titleSize,
          fontWeight: 800,
          lineHeight: 1.15,
          fill: '#f5f7ff',
        }),
        newNode({
          id: 'subtitle',
          type: 'text',
          name: '副标题',
          text: '本地创作工作站 · 动画、剪辑与平面设计',
          x: s.x,
          y: subtitleY,
          width: s.width,
          height: round(bodySize * 1.6),
          fontSize: bodySize,
          fill: '#b8c3e6',
        }),
        newNode({
          id: 'rule',
          type: 'rect',
          name: '分隔线',
          x: s.x,
          y: ruleY,
          width: s.width,
          height: Math.max(2, round(3 * u)),
          fill: '#2b3a63',
        }),
        newNode({
          id: 'footer',
          type: 'text',
          name: '信息栏',
          text: '10 月 18 日 · 线上发布',
          x: s.x,
          y: round(s.y + s.height - 80 * u),
          width: s.width,
          height: round(bodySize * 1.5),
          fontSize: round(bodySize * 0.8),
          fill: '#8b97bb',
        }),
      ],
    };
  }
  if (template === 'cover') {
    const titleSize = round((landscape ? 128 : 140) * u);
    return {
      background: '#111827',
      nodes: [
        newNode({
          id: 'block',
          type: 'rect',
          name: '色块',
          x: 0,
          y: 0,
          width: round(landscape ? width * 0.42 : width),
          height: round(landscape ? height : height * 0.45),
          fill: '#f59f00',
        }),
        newNode({
          id: 'tag-bg',
          type: 'rect',
          name: '标签底',
          x: s.x,
          y: s.y,
          width: round(250 * u),
          height: round(70 * u),
          radius: round(35 * u),
          fill: '#111827',
        }),
        newNode({
          id: 'tag',
          type: 'text',
          name: '标签',
          text: '第 01 期',
          x: s.x,
          y: round(s.y + 12 * u),
          width: round(250 * u),
          height: round(50 * u),
          fontSize: round(34 * u),
          fontWeight: 700,
          align: 'center',
          fill: '#ffd43b',
        }),
        newNode({
          id: 'title',
          type: 'text',
          name: '标题',
          text: '十分钟\n看懂渲染',
          x: round(landscape ? width * 0.47 : s.x),
          y: round(landscape ? s.y + s.height * 0.18 : height * 0.5),
          width: round(landscape ? s.x + s.width - width * 0.47 : s.width),
          height: round(titleSize * 2.5),
          fontSize: titleSize,
          fontWeight: 900,
          lineHeight: 1.12,
          fill: '#ffffff',
          shadow: { color: '#00000088', blur: round(12 * u), x: 0, y: round(6 * u) },
        }),
        newNode({
          id: 'subtitle',
          type: 'text',
          name: '副标题',
          text: '从像素到画面的完整流程',
          x: round(landscape ? width * 0.47 : s.x),
          y: round(landscape ? s.y + s.height * 0.75 : height * 0.5 + titleSize * 2.7),
          width: round(landscape ? s.x + s.width - width * 0.47 : s.width),
          height: round(64 * u),
          fontSize: round(44 * u),
          fill: '#cbd5e1',
        }),
      ],
    };
  }
  const pad = round(Math.min(s.width, s.height) * 0.08);
  return {
    background: '#f3eee6',
    nodes: [
      newNode({
        id: 'card',
        type: 'rect',
        name: '卡片',
        x: s.x,
        y: s.y,
        width: s.width,
        height: s.height,
        radius: round(36 * u),
        fill: '#ffffff',
        shadow: { color: '#3b2f2026', blur: round(40 * u), x: 0, y: round(16 * u) },
      }),
      newNode({
        id: 'dot',
        type: 'ellipse',
        name: '点缀',
        x: round(s.x + pad),
        y: round(s.y + pad),
        width: round(64 * u),
        height: round(64 * u),
        fill: '#e8590c',
      }),
      newNode({
        id: 'quote',
        type: 'text',
        name: '引言',
        text: '好的设计，\n是把复杂留给自己。',
        x: round(s.x + pad),
        y: round(s.y + pad + 120 * u),
        width: round(s.width - 2 * pad),
        height: round(Math.max(200 * u, s.height * 0.45)),
        fontSize: round(Math.min((landscape ? 72 : 84) * u, (s.width - 2 * pad) / 9.6)),
        fontWeight: 700,
        lineHeight: 1.3,
        fill: '#2b2118',
      }),
      newNode({
        id: 'author',
        type: 'text',
        name: '署名',
        text: '— Vmotion 设计笔记',
        x: round(s.x + pad),
        y: round(s.y + s.height - pad - 50 * u),
        width: round(s.width - 2 * pad),
        height: round(56 * u),
        fontSize: round(38 * u),
        fill: '#8a7a6a',
      }),
    ],
  };
}

export type AlignMode =
  | 'left'
  | 'hcenter'
  | 'right'
  | 'top'
  | 'vcenter'
  | 'bottom'
  | 'distribute-h'
  | 'distribute-v';
export const alignModes: AlignMode[] = [
  'left',
  'hcenter',
  'right',
  'top',
  'vcenter',
  'bottom',
  'distribute-h',
  'distribute-v',
];
/** Axis-aligned world bounds of a layer's transformed local box. */
export function layerBox(layer: Pick<InteractionLayer, 'matrix' | 'bounds'>): Bounds {
  const b = layer.bounds,
    corners = [
      { x: b.x, y: b.y },
      { x: b.x + b.width, y: b.y },
      { x: b.x + b.width, y: b.y + b.height },
      { x: b.x, y: b.y + b.height },
    ].map((p) => transform(layer.matrix, p)),
    xs = corners.map((p) => p.x),
    ys = corners.map((p) => p.y),
    x = Math.min(...xs),
    y = Math.min(...ys);
  return { x, y, width: Math.max(...xs) - x, height: Math.max(...ys) - y };
}
export function unionBox(boxes: Bounds[]): Bounds | undefined {
  if (!boxes.length) return undefined;
  const x = Math.min(...boxes.map((b) => b.x)),
    y = Math.min(...boxes.map((b) => b.y));
  return {
    x,
    y,
    width: Math.max(...boxes.map((b) => b.x + b.width)) - x,
    height: Math.max(...boxes.map((b) => b.y + b.height)) - y,
  };
}
/**
 * World-space move per top-level selected layer. A single layer (or reference 'canvas'/'safe')
 * aligns against the given box; multiple layers with reference 'selection' align to their union.
 * Distribution keeps the outermost layers and spaces the gaps evenly.
 */
export function alignDeltas(
  layers: InteractionLayer[],
  ids: string[],
  mode: AlignMode,
  reference: Bounds | 'selection',
): Map<string, Point> {
  const moving = movingLayers(layers, ids),
    boxes = new Map(moving.map((l) => [l.node.id, layerBox(l)])),
    result = new Map<string, Point>();
  if (!moving.length) return result;
  if (mode === 'distribute-h' || mode === 'distribute-v') {
    if (moving.length < 3) return result;
    const horizontal = mode === 'distribute-h',
      sorted = [...moving].sort((a, b) => {
        const A = boxes.get(a.node.id)!,
          B = boxes.get(b.node.id)!;
        return horizontal ? A.x + A.width / 2 - (B.x + B.width / 2) : A.y + A.height / 2 - (B.y + B.height / 2);
      }),
      first = boxes.get(sorted[0].node.id)!,
      last = boxes.get(sorted.at(-1)!.node.id)!,
      span = horizontal ? last.x + last.width - first.x : last.y + last.height - first.y,
      total = sorted.reduce((n, l) => {
        const b = boxes.get(l.node.id)!;
        return n + (horizontal ? b.width : b.height);
      }, 0),
      gap = (span - total) / (sorted.length - 1);
    let cursor = horizontal ? first.x : first.y;
    for (const layer of sorted) {
      const b = boxes.get(layer.node.id)!,
        start = horizontal ? b.x : b.y;
      result.set(layer.node.id, horizontal ? { x: cursor - start, y: 0 } : { x: 0, y: cursor - start });
      cursor += (horizontal ? b.width : b.height) + gap;
    }
    return result;
  }
  const target =
    reference === 'selection'
      ? moving.length > 1
        ? unionBox([...boxes.values()])!
        : undefined
      : reference;
  if (!target) return result;
  for (const layer of moving) {
    const b = boxes.get(layer.node.id)!;
    let dx = 0,
      dy = 0;
    if (mode === 'left') dx = target.x - b.x;
    if (mode === 'hcenter') dx = target.x + target.width / 2 - (b.x + b.width / 2);
    if (mode === 'right') dx = target.x + target.width - (b.x + b.width);
    if (mode === 'top') dy = target.y - b.y;
    if (mode === 'vcenter') dy = target.y + target.height / 2 - (b.y + b.height / 2);
    if (mode === 'bottom') dy = target.y + target.height - (b.y + b.height);
    result.set(layer.node.id, { x: dx, y: dy });
  }
  return result;
}
/** Converts world deltas to the same keyframe-aware composition drafts as canvas dragging. */
export function alignDrafts(
  layers: InteractionLayer[],
  ids: string[],
  mode: AlignMode,
  reference: Bounds | 'selection',
  frame = 0,
): CompositionDraft[] {
  const deltas = alignDeltas(layers, ids, mode, reference);
  return [...deltas].flatMap(([id, delta]) => {
    if (Math.abs(delta.x) < 1e-6 && Math.abs(delta.y) < 1e-6) return [];
    const layer = layers.find((l) => l.node.id === id)!,
      local = parentDelta(layer, delta);
    return local
      ? [
          {
            path: layer.path,
            nodeId: id,
            frame: layer.frame ?? frame,
            contextFrames: layer.contextFrames,
            patch: movePatch(layer.node, layer.frame ?? frame, local),
          },
        ]
      : [];
  });
}

export type SnapTargets = { x: number[]; y: number[] };
/** Edges and centres of the given boxes (canvas, trim, safe area, other layers). */
export function snapTargets(boxes: Bounds[]): SnapTargets {
  const x = new Set<number>(),
    y = new Set<number>();
  for (const b of boxes) {
    x.add(b.x).add(b.x + b.width / 2).add(b.x + b.width);
    y.add(b.y).add(b.y + b.height / 2).add(b.y + b.height);
  }
  return { x: [...x], y: [...y] };
}
/** Snaps a moving box (already offset by `delta`) to the closest target within `threshold`. */
export function snapDelta(
  box: Bounds,
  delta: Point,
  targets: SnapTargets,
  threshold: number,
): { delta: Point; guides: { x?: number; y?: number } } {
  const pick = (edges: number[], candidates: number[]) => {
    let best: { offset: number; at: number } | undefined;
    for (const edge of edges)
      for (const target of candidates) {
        const offset = target - edge;
        if (Math.abs(offset) <= threshold && (!best || Math.abs(offset) < Math.abs(best.offset)))
          best = { offset, at: target };
      }
    return best;
  };
  const moved = { x: box.x + delta.x, y: box.y + delta.y },
    sx = pick([moved.x, moved.x + box.width / 2, moved.x + box.width], targets.x),
    sy = pick([moved.y, moved.y + box.height / 2, moved.y + box.height], targets.y);
  return {
    delta: { x: delta.x + (sx?.offset ?? 0), y: delta.y + (sy?.offset ?? 0) },
    guides: { x: sx?.at, y: sy?.at },
  };
}
