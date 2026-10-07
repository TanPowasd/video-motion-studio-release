import { newNode, VmotionError, type Node } from '../core/model.js';
export const transitionStyles = [
  'crossfade',
  'slide',
  'push',
  'wipe',
  'iris',
  'zoom',
  'dip',
  'cut',
] as const;
export type TransitionStyle = (typeof transitionStyles)[number];
export function sceneTransition(options: {
  id: string;
  fromSceneId: string;
  toSceneId: string;
  progress: number;
  width: number;
  height: number;
  style?: TransitionStyle;
  direction?: 'left' | 'right' | 'up' | 'down';
  color?: string;
  fromOffset?: number;
  toOffset?: number;
  fromRate?: number;
  toRate?: number;
}): Node[] {
  const { id, fromSceneId, toSceneId, width: w, height: h } = options,
    p = Math.max(0, Math.min(1, options.progress)),
    style = options.style ?? 'crossfade',
    direction = options.direction ?? 'left';
  if (
    !id ||
    ![p, w, h].every(Number.isFinite) ||
    w <= 0 ||
    h <= 0 ||
    !transitionStyles.includes(style)
  )
    throw new VmotionError(
      'TRANSITION_ARGUMENTS',
      'Use finite dimensions/progress and a supported transition style',
    );
  const root = newNode({
      id,
      type: 'group',
      width: w,
      height: h,
      isolation: true,
      clip: { x: 0, y: 0, width: w, height: h },
    }),
    a = newNode({
      id: `${id}-from`,
      type: 'scene',
      sceneId: fromSceneId,
      parentId: id,
      width: w,
      height: h,
      timeMapping: {
        mode: 'linear',
        anchor: 0,
        frame: 0,
        offset: options.fromOffset ?? 0,
        rate: options.fromRate ?? 1,
        repeat: 'clamp',
      },
    }),
    b = newNode({
      id: `${id}-to`,
      type: 'scene',
      sceneId: toSceneId,
      parentId: id,
      width: w,
      height: h,
      timeMapping: {
        mode: 'linear',
        anchor: 0,
        frame: 0,
        offset: options.toOffset ?? 0,
        rate: options.toRate ?? 1,
        repeat: 'clamp',
      },
    });
  const nodes = [root, a, b];
  if (style === 'crossfade') {
    a.opacity = 1 - p;
    b.opacity = p;
    b.blend = 'lighter';
  } else if (style === 'cut') {
    a.visible = p < 0.5;
    b.visible = p >= 0.5;
  } else if (style === 'slide' || style === 'push') {
    const horizontal = direction === 'left' || direction === 'right',
      size = horizontal ? w : h,
      sign = direction === 'left' || direction === 'up' ? -1 : 1;
    if (horizontal) {
      b.x = -sign * size * (1 - p);
      if (style === 'push') a.x = sign * size * p;
    } else {
      b.y = -sign * size * (1 - p);
      if (style === 'push') a.y = sign * size * p;
    }
  } else if (style === 'wipe') {
    const horizontal = direction === 'left' || direction === 'right',
      length = (horizontal ? w : h) * p;
    b.clip = {
      x: direction === 'right' ? w - length : 0,
      y: direction === 'down' ? h - length : 0,
      width: horizontal ? length : w,
      height: horizontal ? h : length,
    };
  } else if (style === 'iris') {
    const radius = (Math.hypot(w, h) * p) / 2,
      mask = newNode({
        id: `id-${id}-iris`,
        type: 'ellipse',
        parentId: id,
        x: w / 2 - radius,
        y: h / 2 - radius,
        width: radius * 2,
        height: radius * 2,
        fill: '#ffffff',
      });
    b.maskId = mask.id;
    nodes.push(mask);
  } else if (style === 'zoom') {
    const scale = 0.65 + 0.35 * p;
    b.scaleX = scale;
    b.scaleY = scale;
    b.x = (w * (1 - scale)) / 2;
    b.y = (h * (1 - scale)) / 2;
    b.opacity = p;
    a.opacity = 1;
  } else if (style === 'dip') {
    root.fill = options.color ?? '#101525';
    nodes.splice(
      1,
      0,
      newNode({
        id: `${id}-color`,
        type: 'rect',
        parentId: id,
        width: w,
        height: h,
        fill: root.fill,
        visible: p > 0 && p < 1,
      }),
    );
    a.opacity = Math.max(0, 1 - 2 * p);
    b.opacity = Math.max(0, 2 * p - 1);
  }
  if (p === 0) {
    a.visible = true;
    b.visible = false;
  } else if (p === 1) {
    a.visible = false;
    b.visible = true;
    b.opacity = 1;
    b.x = 0;
    b.y = 0;
    b.scaleX = 1;
    b.scaleY = 1;
    b.maskId = undefined;
    for (const node of nodes) if (node.id === `id-${id}-iris`) node.visible = false;
    b.clip = undefined;
  }
  return nodes;
}
