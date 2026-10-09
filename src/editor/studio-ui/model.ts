/**
 * Studio shell model: the six creative modes, per-project layout persistence, mode
 * shortcuts and responsive rules. Pure functions so they can be unit tested without a DOM.
 */
export type StudioMode = 'edit' | 'motion' | 'effects' | 'music' | 'still' | 'type';
export interface ModeInfo {
  id: StudioMode;
  name: string;
  icon: string;
  keys: string;
  hint: string;
}
export const MODES: ModeInfo[] = [
  { id: 'edit', name: '剪辑', icon: 'film', keys: 'Ctrl+1', hint: '素材库、代理与多轨时间线' },
  { id: 'motion', name: '动效', icon: 'layers', keys: 'Ctrl+2', hint: '关键帧、曲线、动画层与动作模板' },
  { id: 'effects', name: '特效', icon: 'sparkles', keys: 'Ctrl+3', hint: '效果堆栈、节点图、粒子、抠像与转场' },
  { id: 'music', name: '音乐', icon: 'music', keys: 'Ctrl+4', hint: '编曲、通道架、钢琴卷帘、合成器与混音' },
  { id: 'still', name: '图片', icon: 'image', keys: 'Ctrl+5', hint: '单帧画板、对齐吸附与图片导出' },
  { id: 'type', name: '文字', icon: 'text', keys: 'Ctrl+6', hint: '排版、逐字动画、路径文字、字幕与字形库' },
];
export const modeInfo = (mode: StudioMode) => MODES.find((m) => m.id === mode)!;

export type RightTab = 'changes' | 'inspector';
export interface StudioLayout {
  mode: StudioMode;
  left: number;
  right: number;
  timeline: number;
  showLeft: boolean;
  showRight: boolean;
  showTimeline: boolean;
  rightTab: RightTab;
  /** Auto-reveal what an external AI just changed (scene, object, playhead). */
  followAi: boolean;
  /** Collapsed state of the 图层/素材 section under the scene strip. */
  showLayers: boolean;
}
export const studioDefaults: StudioLayout = {
  mode: 'motion',
  left: 264,
  right: 336,
  timeline: 252,
  showLeft: true,
  showRight: true,
  showTimeline: true,
  rightTab: 'changes',
  followAi: true,
  showLayers: true,
};
export const studioLimits = {
  left: { min: 208, max: 420 },
  right: { min: 280, max: 520 },
  timeline: { min: 150, max: 560 },
} as const;
const clamp = (v: unknown, min: number, max: number, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.max(min, Math.min(max, n)) : fallback;
};
export const layoutKey = (projectId: string) => `vmotion.studio.layout.${projectId}`;
/** Sanitises a stored layout (older/corrupt values fall back to defaults). */
export function parseLayout(raw: unknown): StudioLayout {
  const v = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  return {
    mode: MODES.some((m) => m.id === v.mode) ? (v.mode as StudioMode) : studioDefaults.mode,
    left: clamp(v.left, studioLimits.left.min, studioLimits.left.max, studioDefaults.left),
    right: clamp(v.right, studioLimits.right.min, studioLimits.right.max, studioDefaults.right),
    timeline: clamp(
      v.timeline,
      studioLimits.timeline.min,
      studioLimits.timeline.max,
      studioDefaults.timeline,
    ),
    showLeft: v.showLeft !== false,
    showRight: v.showRight !== false,
    showTimeline: v.showTimeline !== false,
    rightTab: v.rightTab === 'inspector' ? 'inspector' : 'changes',
    followAi: v.followAi !== false,
    showLayers: v.showLayers !== false,
  };
}
type KeyValueStore = Pick<Storage, 'getItem' | 'setItem'>;
export function readLayout(storage: KeyValueStore, projectId: string): StudioLayout {
  try {
    return parseLayout(JSON.parse(storage.getItem(layoutKey(projectId)) ?? '{}'));
  } catch {
    return { ...studioDefaults };
  }
}
export function writeLayout(storage: KeyValueStore, projectId: string, layout: StudioLayout) {
  try {
    storage.setItem(layoutKey(projectId), JSON.stringify(layout));
  } catch {
    /* storage full / disabled: layout simply isn't remembered */
  }
}

/** Which backing workspace a mode uses in the existing controller. */
export function workspaceForMode(mode: StudioMode): 'editing' | 'animation' | 'music' {
  return mode === 'edit' ? 'editing' : mode === 'music' ? 'music' : 'animation';
}
/**
 * Mode implied by the current route/workspace. Used when the user arrives by URL or by an
 * existing action (e.g. "打开画稿", entering a still scene) so the pill stays truthful.
 */
export function inferMode(
  current: StudioMode,
  workspace: string,
  hash: string,
  stillScene: boolean,
): StudioMode {
  if (hash.startsWith('#/music')) return 'music';
  if (workspace === 'editing') return 'edit';
  if (workspace === 'animation') {
    if (stillScene) return 'still';
    if (current === 'still' || current === 'edit' || current === 'music') return 'motion';
    return current;
  }
  return current;
}

export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}
/** Ctrl/Cmd+1…6 switches modes (replaces the old Ctrl+1…5 workspace keys). */
export function modeFromShortcut(e: KeyLike): StudioMode | undefined {
  if (!(e.ctrlKey || e.metaKey) || e.altKey || e.shiftKey) return undefined;
  const digit = /^Digit([1-6])$/.exec(e.code ?? '')?.[1] ?? (/^[1-6]$/.test(e.key) ? e.key : '');
  return digit ? MODES[Number(digit) - 1].id : undefined;
}

export interface Responsive {
  /** Change feed / inspector become an overlay drawer instead of a column. */
  rightDrawer: boolean;
  /** Scene strip shows compact cards (number + badge). */
  compactStrip: boolean;
  /** Top bar hides secondary labels. */
  compactTop: boolean;
}
export function responsive(width: number): Responsive {
  return {
    rightDrawer: width < 1240,
    compactStrip: width < 1000,
    compactTop: width < 1500,
  };
}

export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}
/** An object the toolbar should avoid; weight > 1 for text, < 1 for backdrop-like shapes. */
export type Obstacle = Rect & { weight?: number };
export interface ToolbarPlacement {
  /** Top-left of the toolbar in canvas units. */
  x: number;
  y: number;
  side: 'above' | 'below' | 'right' | 'left' | 'inside';
}
const overlapArea = (a: Rect, b: Rect) =>
  Math.max(0, Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x)) *
  Math.max(0, Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y));
/**
 * Where the floating context toolbar goes so it never covers the selected object and
 * covers as little of the other objects as possible. Tries above, below, right and left
 * of the selection (in that preference order), keeps it on the canvas, and ignores
 * backdrop-sized layers that every position would overlap anyway.
 */
export function placeToolbar(
  box: Rect,
  size: { width: number; height: number },
  canvas: { width: number; height: number },
  others: Obstacle[],
  gap = 12,
  /** Extra room above the selection (the stage draws the layer-name tag there). */
  gapAbove = gap,
): ToolbarPlacement {
  const clampX = (x: number) => Math.min(Math.max(0, x), Math.max(0, canvas.width - size.width));
  const clampY = (y: number) => Math.min(Math.max(0, y), Math.max(0, canvas.height - size.height));
  const cx = box.x + box.width / 2 - size.width / 2,
    cy = box.y + box.height / 2 - size.height / 2;
  const raw: ToolbarPlacement[] = [
    { side: 'above', x: cx, y: box.y - gapAbove - size.height },
    { side: 'below', x: cx, y: box.y + box.height + gap },
    { side: 'right', x: box.x + box.width + gap, y: cy },
    { side: 'left', x: box.x - gap - size.width, y: cy },
  ];
  const canvasArea = canvas.width * canvas.height;
  // Backdrop-sized layers are ignored (every spot overlaps them); large panels count little.
  const obstacles = others
    .filter((o) => o.width * o.height < canvasArea * 0.5)
    .map((o) => ({ ...o, weight: (o.weight ?? 1) * (o.width * o.height > canvasArea * 0.2 ? 0.15 : 1) }));
  const tbArea = Math.max(1, size.width * size.height);
  let best: { p: ToolbarPlacement; score: number } | undefined;
  raw.forEach((r, i) => {
    const p = { ...r, x: clampX(r.x), y: clampY(r.y) };
    const rect = { x: p.x, y: p.y, width: size.width, height: size.height };
    // Clamping can push the bar back onto the selection: that is the worst outcome.
    const onSelection = overlapArea(rect, box) / tbArea;
    const onOthers = obstacles.reduce((sum, o) => sum + overlapArea(rect, o) * o.weight, 0) / tbArea;
    const shifted = (Math.abs(p.x - r.x) + Math.abs(p.y - r.y)) / Math.max(1, size.width);
    // Side placements read worse for wide text bars: only when above/below are clearly worse.
    const score = onSelection * 10 + onOthers * 3 + shifted * 0.5 + i * 0.05 + (i >= 2 ? 0.4 : 0);
    if (!best || score < best.score) best = { p, score };
  });
  const chosen = best!.p;
  // Selection fills the canvas: no outside spot exists, sit at its top edge inside it.
  if (best!.score >= 10 * 0.9) return { side: 'inside', x: clampX(cx), y: clampY(box.y + gap) };
  return chosen;
}
