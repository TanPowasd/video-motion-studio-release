import { newNode, type Node, type Gradient, type Effect } from '../core/model.js';
import { random } from '../core/time.js';
import { clamp, lerp, progress, type Vec2 } from './motion.js';
import type { ComponentContext, NodeProps } from './index.js';
import { prepareCamera3D, type Vec3, type Camera3D } from './matrix3d.js';
export type { Vec3 } from './matrix3d.js';
export function group(id: string, children: Node[], props: NodeProps = {}) {
  return [
    newNode({ ...props, id, type: 'group' }),
    ...children.map((n) => ({
      ...n,
      id: `${id}/${n.id}`,
      parentId: n.parentId ? `${id}/${n.parentId}` : id,
      maskId: n.maskId ? `${id}/${n.maskId}` : undefined,
    })),
  ];
}
export const linearGradient = (from: Vec2, to: Vec2, colors: string[]): Gradient => ({
  type: 'linear',
  from,
  to,
  stops: colors.map((color, i) => ({ color, offset: i / Math.max(1, colors.length - 1) })),
});
export const radialGradient = (center: Vec2, radius: number, colors: string[]): Gradient => ({
  type: 'radial',
  center,
  radius,
  stops: colors.map((color, i) => ({ color, offset: i / Math.max(1, colors.length - 1) })),
});
export const glow = (
  color: string,
  radius = 18,
  intensity = 1,
  threshold = 0.55,
): Extract<Effect, { type: 'glow' }> => ({
  type: 'glow',
  color,
  radius,
  intensity,
  threshold,
});
export const blur = (radius: number): Extract<Effect, { type: 'blur' }> => ({
  type: 'blur',
  radius,
});
export function enter(
  clock: Pick<ComponentContext, 'frame' | 'fps'>,
  options: { start?: number; duration?: number; from?: Vec2; scale?: number } = {},
) {
  const t = progress(clock, { start: options.start, duration: options.duration ?? 24 });
  return {
    opacity: clamp(t),
    x: (options.from?.x ?? 0) * (1 - t),
    y: (options.from?.y ?? 32) * (1 - t),
    scaleX: lerp(options.scale ?? 0.95, 1, t),
    scaleY: lerp(options.scale ?? 0.95, 1, t),
  };
}
export function wipe(
  clock: Pick<ComponentContext, 'frame' | 'fps'>,
  width: number,
  height: number,
  options: { start?: number; duration?: number; direction?: 'left' | 'right' | 'up' | 'down' } = {},
) {
  const p = progress(clock, { start: options.start, duration: options.duration ?? 30 });
  switch (options.direction) {
    case 'right':
      return { x: width * (1 - p), y: 0, width: width * p, height };
    case 'up':
      return { x: 0, y: 0, width, height: height * p };
    case 'down':
      return { x: 0, y: height * (1 - p), width, height: height * p };
    default:
      return { x: 0, y: 0, width: width * p, height };
  }
}
export function trail(
  id: string,
  ctx: ComponentContext,
  draw: (at: ComponentContext) => Node[],
  options: { samples?: number; spacing?: number; opacity?: number } = {},
) {
  const count = Math.min(32, Math.max(1, Math.floor(options.samples ?? 8))),
    nodes: Node[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const frame = ctx.frame - i * (options.spacing ?? 2);
    if (frame < 0) continue;
    nodes.push(
      ...group(`${id}/${i}`, draw({ ...ctx, frame, seconds: frame / ctx.fps }), {
        opacity: (options.opacity ?? 0.6) * (1 - i / count) ** 2,
      }),
    );
  }
  return nodes;
}
export function particles(
  id: string,
  ctx: ComponentContext,
  options: {
    count?: number;
    seed?: number;
    origin?: Vec2;
    spread?: Vec2;
    velocity?: Vec2;
    velocitySpread?: Vec2;
    gravity?: number;
    lifetime?: number;
    size?: [number, number];
    colors?: string[];
    start?: number;
    loop?: boolean;
  } = {},
) {
  const count = Math.min(1000, Math.max(1, Math.floor(options.count ?? 80))),
    rng = random(options.seed ?? ctx.seed),
    life = options.lifetime ?? 3;
  if (life <= 0 || !Number.isFinite(life)) throw new Error('Particle lifetime must be positive');
  if (!Number.isFinite(count) || options.colors?.length === 0)
    throw new Error('Particle count must be finite and colors nonempty');
  const nodes: Node[] = [];
  for (let i = 0; i < count; i++) {
    const ox = (options.origin?.x ?? 0) + (rng() - 0.5) * (options.spread?.x ?? 0),
      oy = (options.origin?.y ?? 0) + (rng() - 0.5) * (options.spread?.y ?? 0),
      vx = (options.velocity?.x ?? 0) + (rng() - 0.5) * (options.velocitySpread?.x ?? 120),
      vy = (options.velocity?.y ?? -80) + (rng() - 0.5) * (options.velocitySpread?.y ?? 80),
      radius = lerp(options.size?.[0] ?? 1, options.size?.[1] ?? 4, rng()),
      delay = rng() * life;
    let age = ctx.seconds - (options.start ?? 0) - delay;
    if (age < 0) continue;
    if (options.loop !== false) age %= life;
    else if (age > life) continue;
    const opacity = Math.sin(Math.PI * clamp(age / life));
    nodes.push(
      newNode({
        id: `${id}/${i}`,
        type: 'ellipse',
        x: ox + vx * age - radius,
        y: oy + vy * age + 0.5 * (options.gravity ?? 0) * age * age - radius,
        width: radius * 2,
        height: radius * 2,
        opacity,
        fill: (options.colors ?? ['#a6c6ff', '#ffffff'])[i % (options.colors?.length ?? 2)],
      }),
    );
  }
  return nodes;
}
export function project3D(point: Vec3, camera: Camera3D) {
  const prepared = prepareCamera3D(camera),
    { clip, ...point2D } = prepared.project(point);
  // Preserve the legacy depth-only visibility rule. New batch APIs expose full frustum visibility.
  return { ...point2D, visible: point2D.depth > prepared.near && point2D.depth < prepared.far };
}
