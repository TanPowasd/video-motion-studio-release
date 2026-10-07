import { z } from 'zod';
import { newNode, VmotionError } from './model.js';
import { random } from './time.js';
import { toLinear, fromLinear } from './pixels.js';
import type { ParameterDefinitions } from './parameters.js';
const finite = z.number().finite(),
  vec = z.object({ x: finite, y: finite }).strict(),
  range = (min: number, max: number) =>
    z
      .object({ min: finite.min(min).max(max), max: finite.min(min).max(max) })
      .strict()
      .refine((value) => value.max >= value.min, 'Range max must not precede min'),
  color = z.string().regex(/^#[0-9a-f]{6}$/i);
export const particleFieldSchema = z
  .object({
    seed: z.number().int().min(0).max(4294967295).default(1),
    mode: z.enum(['burst', 'continuous']).default('continuous'),
    count: z.number().int().min(1).max(2000).default(120),
    rate: finite.min(0).max(1000).default(60),
    start: finite.min(0).max(1e7).default(0),
    maxAlive: z.number().int().min(1).max(2000).default(1000),
    lifetime: range(0.01, 60).default({ min: 2, max: 3 }),
    origin: vec.default({ x: 0, y: 0 }),
    emission: z.enum(['point', 'box', 'disk', 'line']).default('point'),
    area: vec
      .refine((v) => v.x >= 0 && v.y >= 0, 'Emission area must be nonnegative')
      .default({ x: 30, y: 30 }),
    direction: finite.default(-90),
    spread: finite.min(0).max(360).default(60),
    speed: range(0, 3000).default({ min: 80, max: 160 }),
    velocity: vec.default({ x: 0, y: 0 }),
    gravity: vec.default({ x: 0, y: 90 }),
    drag: finite.min(0).max(20).default(0),
    size: range(0.1, 100).default({ min: 2, max: 5 }),
    endScale: finite.min(0).max(10).default(0.25),
    opacity: finite.min(0).max(1).default(1),
    fadeIn: finite.min(0).max(1).default(0.05),
    fadeOut: finite.min(0).max(1).default(0.3),
    shape: z.enum(['circle', 'square', 'streak']).default('circle'),
    streakScale: finite.min(0).max(1).default(0.03),
    rotation: finite.default(0),
    rotationSpread: finite.min(0).max(360).default(180),
    spin: finite.default(0),
    colors: z.array(color).min(1).max(16).default(['#80bfff', '#ffffff']),
    tintEnd: z.boolean().default(false),
    endColor: color.default('#ffffff'),
  })
  .strict();
export type ParticleFieldInput = z.input<typeof particleFieldSchema>;
export type ParticleFieldConfig = z.output<typeof particleFieldSchema>;
const num = (value: number, min?: number, max?: number, integer = false) => ({
  type: 'number' as const,
  default: value,
  min,
  max,
  integer,
});
const pair = (value: { min: number; max: number }, min: number, max: number) => ({
  type: 'object' as const,
  properties: { min: num(value.min, min, max), max: num(value.max, min, max) },
});
export const particleFieldParameters = {
  seed: num(1, 0, 4294967295, true),
  mode: { type: 'enum', options: ['burst', 'continuous'], default: 'continuous' },
  count: num(120, 1, 2000, true),
  rate: num(60, 0, 1000),
  start: num(0, 0, 1e7),
  maxAlive: num(1000, 1, 2000, true),
  lifetime: pair({ min: 2, max: 3 }, 0.01, 60),
  origin: { type: 'vec2', default: { x: 0, y: 0 } },
  emission: { type: 'enum', options: ['point', 'box', 'disk', 'line'], default: 'point' },
  area: { type: 'vec2', default: { x: 30, y: 30 }, min: 0 },
  direction: num(-90),
  spread: num(60, 0, 360),
  speed: pair({ min: 80, max: 160 }, 0, 3000),
  velocity: { type: 'vec2', default: { x: 0, y: 0 } },
  gravity: { type: 'vec2', default: { x: 0, y: 90 } },
  drag: num(0, 0, 20),
  size: pair({ min: 2, max: 5 }, 0.1, 100),
  endScale: num(0.25, 0, 10),
  opacity: num(1, 0, 1),
  fadeIn: num(0.05, 0, 1),
  fadeOut: num(0.3, 0, 1),
  shape: { type: 'enum', options: ['circle', 'square', 'streak'], default: 'circle' },
  streakScale: num(0.03, 0, 1),
  rotation: num(0),
  rotationSpread: num(180, 0, 360),
  spin: num(0),
  colors: {
    type: 'array',
    items: { type: 'color' },
    default: ['#80bfff', '#ffffff'],
    minLength: 1,
    maxLength: 16,
  },
  tintEnd: { type: 'boolean', default: false },
  endColor: { type: 'color', default: '#ffffff' },
} as const satisfies ParameterDefinitions;
export type ParticleRecord = {
  index: number;
  birth: number;
  age: number;
  lifetime: number;
  x: number;
  y: number;
  vx: number;
  vy: number;
  radius: number;
  opacity: number;
  rotation: number;
  color: string;
};
export type ParticleCallbacks = {
  originAt?: (birth: number, index: number) => { x: number; y: number };
};
const smooth = (t: number) => {
  const p = Math.max(0, Math.min(1, t));
  return p * p * (3 - 2 * p);
};
function tint(a: string, b: string, t: number) {
  return (
    '#' +
    [1, 3, 5]
      .map((offset) => {
        const x = toLinear(parseInt(a.slice(offset, offset + 2), 16) / 255),
          y = toLinear(parseInt(b.slice(offset, offset + 2), 16) / 255);
        return Math.round(fromLinear(x + (y - x) * t) * 255)
          .toString(16)
          .padStart(2, '0');
      })
      .join('')
  );
}
export function particleState(
  input: ParticleFieldInput,
  time: number,
  callbacks: ParticleCallbacks = {},
) {
  const config = particleFieldSchema.parse(input);
  if (!Number.isFinite(time) || time < 0 || time > 1e9)
    throw new VmotionError('PARTICLE_TIME', 'Particle time must be finite nonnegative seconds');
  const last =
      config.mode === 'burst'
        ? config.count - 1
        : Math.floor((time - config.start) * config.rate + 1e-9),
    first =
      config.mode === 'burst'
        ? 0
        : Math.max(0, Math.ceil((time - config.start - config.lifetime.max) * config.rate)),
    candidates =
      time < config.start || (config.mode === 'continuous' && config.rate === 0)
        ? 0
        : Math.max(0, last - first + 1),
    lower = Math.max(first, last - 16383),
    records: ParticleRecord[] = [];
  let examined = 0;
  if (candidates)
    for (let index = last; index >= lower; index--) {
      examined++;
      const rng = random((config.seed ^ Math.imul(index, 0x9e3779b1)) >>> 0),
        life = config.lifetime.min + rng() * (config.lifetime.max - config.lifetime.min),
        birth = config.mode === 'burst' ? config.start : config.start + index / config.rate,
        age = Math.max(0, time - birth);
      if (age >= life) continue;
      const origin = callbacks.originAt?.(birth, index) ?? config.origin;
      if (!Number.isFinite(origin.x) || !Number.isFinite(origin.y))
        throw new VmotionError('PARTICLE_SOURCE', 'Birth origin must be finite', { index, birth });
      let ox = origin.x,
        oy = origin.y;
      if (config.emission === 'box') {
        ox += (rng() - 0.5) * config.area.x;
        oy += (rng() - 0.5) * config.area.y;
      } else if (config.emission === 'disk') {
        const angle = rng() * Math.PI * 2,
          radius = Math.sqrt(rng());
        ox += Math.cos(angle) * radius * config.area.x;
        oy += Math.sin(angle) * radius * config.area.y;
      } else if (config.emission === 'line') {
        const t = rng() - 0.5;
        ox += t * config.area.x;
        oy += t * config.area.y;
      }
      const angle = ((config.direction + (rng() - 0.5) * config.spread) * Math.PI) / 180,
        speed = config.speed.min + rng() * (config.speed.max - config.speed.min),
        vx = Math.cos(angle) * speed + config.velocity.x,
        vy = Math.sin(angle) * speed + config.velocity.y,
        initial = config.size.min + rng() * (config.size.max - config.size.min),
        phase = age / life,
        rotation = config.rotation + (rng() - 0.5) * config.rotationSpread + config.spin * age,
        startColor = config.colors[Math.floor(rng() * config.colors.length)],
        k = config.drag,
        kt = k * age,
        decay = Math.exp(-kt),
        a = kt < 1e-4 ? age * (1 - kt / 2 + (kt * kt) / 6 - kt ** 3 / 24) : -Math.expm1(-kt) / k,
        b = kt < 1e-4 ? age * age * (0.5 - kt / 6 + (kt * kt) / 24 - kt ** 3 / 120) : (age - a) / k;
      const record = {
        index,
        birth,
        age,
        lifetime: life,
        x: ox + vx * a + config.gravity.x * b,
        y: oy + vy * a + config.gravity.y * b,
        vx: vx * decay + config.gravity.x * a,
        vy: vy * decay + config.gravity.y * a,
        radius: initial * (1 + (config.endScale - 1) * phase),
        opacity:
          config.opacity *
          (config.fadeIn ? smooth(phase / config.fadeIn) : 1) *
          (config.fadeOut ? smooth((1 - phase) / config.fadeOut) : 1),
        rotation,
        color: config.tintEnd ? tint(startColor, config.endColor, phase) : startColor,
      };
      if (
        Object.values(record).some((value) => typeof value === 'number' && !Number.isFinite(value))
      )
        throw new VmotionError('PARTICLE_RANGE', 'Particle pose exceeds finite coordinates', {
          index,
        });
      records.push(record);
      if (records.length >= config.maxAlive) break;
    }
  records.reverse();
  return { config, time, records, candidates, examined, truncated: candidates > examined };
}
export function particleField(
  id: string,
  clock: { seconds: number },
  input: ParticleFieldInput = {},
  callbacks: ParticleCallbacks = {},
) {
  const state = particleState(input, clock.seconds, callbacks);
  return state.records.map((particle) => {
    const streak = state.config.shape === 'streak',
      width = streak
        ? Math.max(
            particle.radius * 2,
            Math.hypot(particle.vx, particle.vy) * state.config.streakScale,
          )
        : particle.radius * 2,
      height = particle.radius * 2;
    return newNode({
      id: `${id}/${particle.index}`,
      type: state.config.shape === 'circle' ? 'ellipse' : 'rect',
      x: particle.x - width / 2,
      y: particle.y - height / 2,
      width,
      height,
      originX: width / 2,
      originY: height / 2,
      rotation: streak ? (Math.atan2(particle.vy, particle.vx) * 180) / Math.PI : particle.rotation,
      opacity: particle.opacity,
      fill: particle.color,
    });
  });
}
