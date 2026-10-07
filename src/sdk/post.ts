import { effectSchema, type Effect } from '../core/model.js';
import type { z } from 'zod';
import type { spatialEffectSchema } from '../core/spatial-effect-schema.js';
import type { temporalEffectSchema } from '../core/temporal-effect.js';
import type { EffectGraphInput } from '../core/effect-graph-schema.js';
import type { GraphDefinitionInput } from '../core/effect-graph.js';
import type { rasterEffectSchema } from '../core/raster-effect-schema.js';
type RasterInput = z.input<typeof rasterEffectSchema>;
export const gradientMap = (options: Omit<Extract<RasterInput, { type: 'gradientMap' }>, 'type'>) =>
  effectSchema.parse({ type: 'gradientMap', ...options }) as Extract<
    Effect,
    { type: 'gradientMap' }
  >;
export const radialRays = (
  options: Omit<Extract<RasterInput, { type: 'radialRays' }>, 'type'> = {},
) =>
  effectSchema.parse({ type: 'radialRays', ...options }) as Extract<Effect, { type: 'radialRays' }>;
export const bloom = (options: Omit<Extract<RasterInput, { type: 'bloom' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'bloom', ...options }) as Extract<Effect, { type: 'bloom' }>;
type SpatialInput = z.input<typeof spatialEffectSchema>;
export const effectGraph = (
  source: string | GraphDefinitionInput,
  params: Record<string, unknown> = {},
  bindings: Record<string, string> = {},
  output?: string,
) =>
  effectSchema.parse({
    type: 'effectGraph',
    ...(typeof source === 'string' ? { source } : { graph: source }),
    params,
    bindings,
    ...(output === undefined ? {} : { output }),
  }) as Extract<Effect, { type: 'effectGraph' }>;
export const liquify = (options: Omit<Extract<SpatialInput, { type: 'liquify' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'liquify', ...options }) as Extract<Effect, { type: 'liquify' }>;
type TemporalInput = z.input<typeof temporalEffectSchema>;
export const motionBlur = (
  options: Omit<Extract<TemporalInput, { type: 'motionBlur' }>, 'type'> = {},
) =>
  effectSchema.parse({ type: 'motionBlur', ...options }) as Extract<Effect, { type: 'motionBlur' }>;
export const echo = (options: Omit<Extract<TemporalInput, { type: 'echo' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'echo', ...options }) as Extract<Effect, { type: 'echo' }>;
export { makeWarpGrid, pinGrid, type WarpPoint } from '../core/warp-grid.js';
export const meshWarp = (options: Omit<Extract<SpatialInput, { type: 'meshWarp' }>, 'type'>) =>
  effectSchema.parse({ type: 'meshWarp', ...options }) as Extract<Effect, { type: 'meshWarp' }>;
export const cornerPin = (
  corners: Extract<SpatialInput, { type: 'cornerPin' }>['corners'],
  options: Omit<Extract<SpatialInput, { type: 'cornerPin' }>, 'type' | 'corners'> = {},
) =>
  effectSchema.parse({ type: 'cornerPin', corners, ...options }) as Extract<
    Effect,
    { type: 'cornerPin' }
  >;
export const waveWarp = (options: Omit<Extract<SpatialInput, { type: 'waveWarp' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'waveWarp', ...options }) as Extract<Effect, { type: 'waveWarp' }>;
export const twirl = (options: Omit<Extract<SpatialInput, { type: 'twirl' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'twirl', ...options }) as Extract<Effect, { type: 'twirl' }>;
export const bulge = (options: Omit<Extract<SpatialInput, { type: 'bulge' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'bulge', ...options }) as Extract<Effect, { type: 'bulge' }>;
export const rgbSplit = (options: Omit<Extract<SpatialInput, { type: 'rgbSplit' }>, 'type'> = {}) =>
  effectSchema.parse({ type: 'rgbSplit', ...options }) as Extract<Effect, { type: 'rgbSplit' }>;
export const linearWipe = (
  progress: number,
  options: Omit<Extract<SpatialInput, { type: 'linearWipe' }>, 'type' | 'progress'> = {},
) =>
  effectSchema.parse({ type: 'linearWipe', progress, ...options }) as Extract<
    Effect,
    { type: 'linearWipe' }
  >;
export const radialWipe = (
  progress: number,
  options: Omit<Extract<SpatialInput, { type: 'radialWipe' }>, 'type' | 'progress'> = {},
) =>
  effectSchema.parse({ type: 'radialWipe', progress, ...options }) as Extract<
    Effect,
    { type: 'radialWipe' }
  >;
export const chromaKey = (
  color = '#00ff00',
  options: { tolerance?: number; softness?: number; despill?: number } = {},
) =>
  effectSchema.parse({ type: 'chromaKey', color, ...options }) as Extract<
    Effect,
    { type: 'chromaKey' }
  >;
export const levels = (
  options: {
    inputBlack?: number;
    inputWhite?: number;
    gamma?: number;
    outputBlack?: number;
    outputWhite?: number;
  } = {},
) => effectSchema.parse({ type: 'levels', ...options }) as Extract<Effect, { type: 'levels' }>;
export const curves = (options: {
  master?: Array<{ x: number; y: number }>;
  red?: Array<{ x: number; y: number }>;
  green?: Array<{ x: number; y: number }>;
  blue?: Array<{ x: number; y: number }>;
}) => effectSchema.parse({ type: 'curves', ...options }) as Extract<Effect, { type: 'curves' }>;
export const vignette = (amount = 0.5, radius = 0.75, softness = 0.6) =>
  effectSchema.parse({ type: 'vignette', amount, radius, softness }) as Extract<
    Effect,
    { type: 'vignette' }
  >;
export const grain = (amount = 0.08, seed = 1, animated = true) =>
  effectSchema.parse({ type: 'grain', amount, seed, animated }) as Extract<
    Effect,
    { type: 'grain' }
  >;
export const displacement = (
  options: {
    amountX?: number;
    amountY?: number;
    scale?: number;
    seed?: number;
    evolution?: number;
    octaves?: number;
    edge?: 'transparent' | 'clamp' | 'wrap';
  } = {},
) =>
  effectSchema.parse({ type: 'displacement', ...options }) as Extract<
    Effect,
    { type: 'displacement' }
  >;
export const pixelate = (size = 12) =>
  effectSchema.parse({ type: 'pixelate', size }) as Extract<Effect, { type: 'pixelate' }>;
export function parseCube(source: string, intensity = 1): Extract<Effect, { type: 'lut3d' }> {
  let size = 0;
  const data: number[] = [],
    min = [0, 0, 0],
    max = [1, 1, 1];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.split('#')[0].trim();
    if (!line || line.startsWith('TITLE')) continue;
    const [command, ...args] = line.split(/\s+/);
    if (command === 'LUT_3D_SIZE') {
      size = Number(args[0]);
      continue;
    }
    if (command === 'DOMAIN_MIN' || command === 'DOMAIN_MAX') {
      const values = args.map(Number);
      if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
        throw new Error('Invalid LUT domain');
      (command === 'DOMAIN_MIN' ? min : max).splice(0, 3, ...values);
      continue;
    }
    if (command.startsWith('LUT_') || command === 'LUT_1D_SIZE')
      throw new Error('Only a single 3D .cube LUT is supported');
    const values = [command, ...args].map(Number);
    if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
      throw new Error(`Invalid .cube line: ${raw}`);
    data.push(...values);
  }
  if (
    !Number.isInteger(size) ||
    size < 2 ||
    size > 33 ||
    data.length !== size ** 3 * 3 ||
    max.some((v, i) => v <= min[i])
  )
    throw new Error('LUT size/data/domain mismatch (supported sizes: 2–33)');
  return effectSchema.parse({
    type: 'lut3d',
    size,
    data,
    domainMin: min,
    domainMax: max,
    intensity,
  }) as Extract<Effect, { type: 'lut3d' }>;
}
