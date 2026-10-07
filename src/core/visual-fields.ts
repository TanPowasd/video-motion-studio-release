import type { z } from 'zod';
import { noise2D, fractalNoise } from './pixels.js';
import { textureSettingsSchema } from './texture-schema.js';
export { textureSettingsSchema } from './texture-schema.js';
export type { TextureSettings } from './texture-schema.js';
export function prepareTexture(raw: z.input<typeof textureSettingsSchema> | unknown) {
  const settings = textureSettingsSchema.parse(raw);
  if (settings.stops.some((s, i) => i > 0 && s.offset <= settings.stops[i - 1].offset))
    throw new Error('Texture color stop offsets must increase');
  const stops = settings.stops.map((s) => ({
      ...s,
      rgb: [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16)),
    })),
    angle = (settings.angle * Math.PI) / 180,
    c = Math.cos(angle),
    s = Math.sin(angle);
  const value = (x: number, y: number) => {
    let u = (x * c + y * s) / settings.scale,
      v = (-x * s + y * c) / settings.scale;
    u += settings.evolution;
    v += settings.evolution * 0.73;
    if (settings.warp) {
      const dx = fractalNoise(u + 0.31, v + 37, settings.seed + 73, settings.octaves) - 0.5,
        dy = fractalNoise(u + 93, v + 0.17, settings.seed + 701, settings.octaves) - 0.5;
      u += dx * settings.warp;
      v += dy * settings.warp;
    }
    let result: number;
    if (settings.pattern === 'checker') result = (((Math.floor(u) + Math.floor(v)) % 2) + 2) % 2;
    else if (settings.pattern === 'waves')
      result = 0.5 + 0.5 * Math.sin(2 * Math.PI * (u + 0.35 * Math.sin(v * 2 * Math.PI)));
    else if (settings.pattern === 'marble')
      result =
        0.5 +
        0.5 * Math.sin(2 * Math.PI * (u + 2 * fractalNoise(u, v, settings.seed, settings.octaves)));
    else if (settings.pattern === 'cellular') {
      const ix = Math.floor(u),
        iy = Math.floor(v);
      let nearest = Infinity;
      for (let dy = -1; dy <= 1; dy++)
        for (let dx = -1; dx <= 1; dx++) {
          const px = ix + dx + 0.1 + 0.8 * noise2D((ix + dx) * 31, (iy + dy) * 17, settings.seed),
            py =
              iy +
              dy +
              0.1 +
              0.8 * noise2D((ix + dx) * 13 + 97, (iy + dy) * 19, settings.seed + 131);
          nearest = Math.min(nearest, Math.hypot(u - px, v - py));
        }
      result = Math.min(1, nearest / Math.SQRT2);
    } else if (settings.pattern === 'fbm')
      result = fractalNoise(u, v, settings.seed, settings.octaves);
    else {
      let sum = 0,
        total = 0,
        weight = 1;
      for (let octave = 0; octave < settings.octaves; octave++) {
        const sample = 2 * Math.abs(noise2D(u, v, settings.seed + octave * 101) - 0.5);
        sum += (settings.pattern === 'ridged' ? (1 - sample) ** 2 : sample) * weight;
        total += weight;
        weight *= 0.5;
        u *= 2;
        v *= 2;
      }
      result = sum / total;
    }
    return Math.max(0, Math.min(1, (result - 0.5) * settings.contrast + 0.5 + settings.bias));
  };
  const color = (amount: number) => {
    let a = stops[0],
      b = a;
    if (amount >= stops[stops.length - 1].offset) a = b = stops[stops.length - 1];
    else if (amount > stops[0].offset)
      for (let i = 1; i < stops.length; i++)
        if (amount <= stops[i].offset) {
          a = stops[i - 1];
          b = stops[i];
          break;
        }
    const t = a === b ? 0 : (amount - a.offset) / (b.offset - a.offset),
      alpha = a.alpha + (b.alpha - a.alpha) * t;
    return [0, 1, 2]
      .map((i) => (alpha ? (a.rgb[i] * a.alpha * (1 - t) + b.rgb[i] * b.alpha * t) / alpha : 0))
      .concat(alpha * 255);
  };
  return { settings, value, color };
}
