import { z } from 'zod';
const finite = z.number().finite();
export const temporalEffectSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('motionBlur'),
      samples: z.number().int().min(2).max(32).default(8),
      shutterAngle: finite.min(0).max(360).default(180),
      phase: finite.min(-1).max(1).default(0),
    })
    .strict(),
  z
    .object({
      type: z.literal('echo'),
      count: z.number().int().min(1).max(32).default(8),
      spacing: finite.min(0.001).max(600).default(2),
      units: z.enum(['frames', 'seconds']).default('frames'),
      decay: finite.min(0).max(1).default(0.65),
      strength: finite.min(0).max(1).default(0.65),
      operator: z.enum(['over', 'add', 'screen']).default('over'),
    })
    .strict(),
]);
export type TemporalEffect = z.infer<typeof temporalEffectSchema>;
export function temporalActive(
  effect: { type: string; enabled?: boolean } & Record<string, unknown>,
) {
  if (effect.enabled === false) return false;
  return effect.type === 'motionBlur'
    ? Number(effect.shutterAngle) > 0
    : effect.type === 'echo' &&
        Number(effect.count) > 1 &&
        Number(effect.decay) > 0 &&
        Number(effect.strength) > 0;
}
export function temporalSamples(effect: TemporalEffect, frame: number, fps: number) {
  if (effect.type === 'motionBlur')
    return Array.from({ length: effect.samples }, (_, index) => ({
      frame: Math.max(
        0,
        frame + effect.phase + (((index + 0.5) / effect.samples - 0.5) * effect.shutterAngle) / 360,
      ),
      weight: 1 / effect.samples,
    }));
  const spacing = effect.spacing * (effect.units === 'seconds' ? fps : 1);
  return Array.from({ length: effect.count }, (_, index) => ({
    frame: frame - index * spacing,
    weight: index === 0 ? 1 : effect.strength * effect.decay ** index,
  }))
    .filter((sample) => sample.frame >= 0)
    .reverse();
}
const linear = Float32Array.from({ length: 256 }, (_, value) => {
  const c = value / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
});
export class TemporalPixels {
  readonly data: Float32Array;
  constructor(
    readonly length: number,
    readonly mode: 'average' | 'over' | 'add' | 'screen',
  ) {
    this.data = new Float32Array(length);
  }
  add(source: Uint8ClampedArray, weight: number) {
    const out = this.data;
    for (let i = 0; i < source.length; i += 4) {
      const a = (source[i + 3] / 255) * weight;
      if (!a) continue;
      if (this.mode === 'average' || this.mode === 'add') {
        out[i] += linear[source[i]] * a;
        out[i + 1] += linear[source[i + 1]] * a;
        out[i + 2] += linear[source[i + 2]] * a;
        out[i + 3] = this.mode === 'average' ? out[i + 3] + a : Math.min(1, out[i + 3] + a);
      } else if (this.mode === 'over') {
        const remain = 1 - a;
        out[i] = linear[source[i]] * a + out[i] * remain;
        out[i + 1] = linear[source[i + 1]] * a + out[i + 1] * remain;
        out[i + 2] = linear[source[i + 2]] * a + out[i + 2] * remain;
        out[i + 3] = a + out[i + 3] * remain;
      } else {
        for (let c = 0; c < 3; c++) {
          const value = linear[source[i + c]] * a;
          out[i + c] += value - out[i + c] * value;
        }
        out[i + 3] += a - out[i + 3] * a;
      }
    }
  }
  finish() {
    const result = new Uint8ClampedArray(this.length),
      data = this.data;
    for (let i = 0; i < result.length; i += 4) {
      const a = data[i + 3];
      if (!a) continue;
      for (let c = 0; c < 3; c++) {
        const value = Math.max(0, Math.min(1, data[i + c] / a));
        result[i + c] =
          255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055);
      }
      result[i + 3] = Math.min(1, a) * 255;
    }
    return result;
  }
}
