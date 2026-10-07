import type { RasterEffect } from './raster-pass.js';
import { VmotionError } from './model.js';
import { samplePremultiplied, toLinear, fromLinear } from './pixels.js';
import { transform, type Matrix, type Bounds } from './interaction.js';
export function radialRaysPixels(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Extract<RasterEffect, { type: 'radialRays' }>,
  options: {
    matrix?: Matrix;
    bounds?: Bounds;
    scale?: number;
    fullScan?: boolean;
    work?: (samples: number) => void;
  },
) {
  const output = new Uint8ClampedArray(source);
  if (effect.intensity === 0 || effect.length === 0) return output;
  const bounds = options.bounds ?? { x: 0, y: 0, width, height },
    matrix = options.matrix ?? [options.scale ?? 1, 0, 0, options.scale ?? 1, 0, 0],
    center = transform(matrix, {
      x: bounds.x + bounds.width * effect.center.x,
      y: bounds.y + bounds.height * effect.center.y,
    }),
    tint = [1, 3, 5].map((i) => toLinear(parseInt(effect.color.slice(i, i + 2), 16) / 255)),
    sample = new Uint8ClampedArray(4);
  let total = 0;
  const weights = Array.from({ length: effect.samples }, (_, i) => {
    const w = effect.decay ** i;
    total += w;
    return w;
  });
  let x0 = 0,
    y0 = 0,
    x1 = width - 1,
    y1 = height - 1;
  if (!options.fullScan && effect.length < 1) {
    let sx0 = width,
      sy0 = height,
      sx1 = -1,
      sy1 = -1;
    for (let at = 0; at < source.length; at += 4)
      if (
        source[at + 3] &&
        (effect.threshold === 1
          ? Math.max(source[at], source[at + 1], source[at + 2]) === 255
          : Math.max(source[at], source[at + 1], source[at + 2]) / 255 > effect.threshold)
      ) {
        const pixel = at / 4,
          x = pixel % width,
          y = Math.floor(pixel / width);
        sx0 = Math.min(sx0, x);
        sx1 = Math.max(sx1, x);
        sy0 = Math.min(sy0, y);
        sy1 = Math.max(sy1, y);
      }
    if (sx1 < 0) return output;
    const cx = center.x - 0.5,
      cy = center.y - 0.5,
      denominator = 1 - effect.length,
      expand = (v: number, c: number) => (v - c * effect.length) / denominator;
    x0 = Math.max(0, Math.floor(Math.min(sx0 - 1, expand(sx0 - 1, cx))));
    x1 = Math.min(width - 1, Math.ceil(Math.max(sx1 + 1, expand(sx1 + 1, cx))));
    y0 = Math.max(0, Math.floor(Math.min(sy0 - 1, expand(sy0 - 1, cy))));
    y1 = Math.min(height - 1, Math.ceil(Math.max(sy1 + 1, expand(sy1 + 1, cy))));
  }
  const work = Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) * effect.samples;
  options.work?.(work);
  if (work > 256 * 1024 * 1024)
    throw new VmotionError(
      'LIGHTING_BUDGET',
      'Radial rays exceed 256M pixel samples; reduce explicit samples or effect area',
    );
  for (let y = y0; y <= y1; y++)
    for (let x = x0; x <= x1; x++) {
      const at = (y * width + x) * 4;
      let r = 0,
        g = 0,
        b = 0;
      for (let i = 0; i < effect.samples; i++) {
        sample.fill(0);
        const t = (effect.length * i) / (effect.samples - 1);
        samplePremultiplied(
          source,
          width,
          height,
          x + (center.x - 0.5 - x) * t,
          y + (center.y - 0.5 - y) * t,
          sample,
          0,
        );
        const alpha = sample[3] / 255,
          brightness = Math.max(sample[0], sample[1], sample[2]) / 255,
          gate =
            effect.threshold === 1
              ? brightness === 1
                ? 1
                : 0
              : Math.max(0, (brightness - effect.threshold) / (1 - effect.threshold)),
          weight = (weights[i] / total) * alpha * gate * effect.intensity;
        r += toLinear(sample[0] / 255) * weight;
        g += toLinear(sample[1] / 255) * weight;
        b += toLinear(sample[2] / 255) * weight;
      }
      const light = [r * tint[0], g * tint[1], b * tint[2]],
        a = source[at + 3] / 255,
        la = Math.min(1, Math.max(...light)),
        oa = a + la - a * la;
      if (!oa) continue;
      for (let c = 0; c < 3; c++) {
        const d = toLinear(source[at + c] / 255),
          s = la ? Math.min(1, light[c] / la) : 0,
          blend = effect.mix === 'add' ? Math.min(1, d + s) : 1 - (1 - d) * (1 - s),
          premult = d * a * (1 - la) + s * la * (1 - a) + blend * a * la;
        output[at + c] = Math.max(0, Math.min(255, fromLinear(premult / oa) * 255));
      }
      output[at + 3] = oa * 255;
    }
  return output;
}
