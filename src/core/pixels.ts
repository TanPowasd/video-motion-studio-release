import type { Effect } from './model.js';
import { VmotionError } from './model.js';
import { applySpatialEffect, type SpatialOptions } from './spatial-pixels.js';
const clamp = (value: number, min = 0, max = 1) => Math.max(min, Math.min(max, value));
export const toLinear = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
export const fromLinear = (c: number) =>
  c <= 0.0031308 ? c * 12.92 : 1.055 * c ** (1 / 2.4) - 0.055;
export function noise2D(x: number, y: number, seed = 1) {
  const hash = (x: number, y: number) => {
      let n = Math.imul(x ^ seed, 374761393) ^ Math.imul(y, 668265263);
      n = Math.imul(n ^ (n >>> 13), 1274126177);
      return ((n ^ (n >>> 16)) >>> 0) / 4294967295;
    },
    ix = Math.floor(x),
    iy = Math.floor(y),
    sx = x - ix,
    sy = y - iy,
    tx = sx * sx * (3 - 2 * sx),
    ty = sy * sy * (3 - 2 * sy),
    a = hash(ix, iy),
    b = hash(ix + 1, iy),
    c = hash(ix, iy + 1),
    d = hash(ix + 1, iy + 1);
  return (a + (b - a) * tx) * (1 - ty) + (c + (d - c) * tx) * ty;
}
export function fractalNoise(x: number, y: number, seed = 1, octaves = 3) {
  let result = 0,
    weight = 1,
    total = 0;
  for (let i = 0; i < octaves; i++) {
    result += noise2D(x, y, seed + i * 101) * weight;
    total += weight;
    weight *= 0.5;
    x *= 2;
    y *= 2;
  }
  return result / total;
}
export function samplePremultiplied(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  x: number,
  y: number,
  output: Uint8ClampedArray,
  index: number,
  edge: 'transparent' | 'clamp' | 'wrap' = 'transparent',
) {
  const x0 = Math.floor(x),
    y0 = Math.floor(y),
    tx = x - x0,
    ty = y - y0;
  let alpha = 0,
    r = 0,
    g = 0,
    b = 0;
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 2; dx++) {
      let px = x0 + dx,
        py = y0 + dy;
      if (edge === 'wrap') {
        px = ((px % width) + width) % width;
        py = ((py % height) + height) % height;
      } else if (edge === 'clamp') {
        px = clamp(px, 0, width - 1);
        py = clamp(py, 0, height - 1);
      } else if (px < 0 || px >= width || py < 0 || py >= height) continue;
      const position = (py * width + px) * 4,
        weight = (dx ? tx : 1 - tx) * (dy ? ty : 1 - ty),
        a = (source[position + 3] / 255) * weight;
      alpha += a;
      r += source[position] * a;
      g += source[position + 1] * a;
      b += source[position + 2] * a;
    }
  if (alpha > 0) {
    output[index] = r / alpha;
    output[index + 1] = g / alpha;
    output[index + 2] = b / alpha;
    output[index + 3] = alpha * 255;
  }
}
export function applyPixelEffect(
  source: Uint8ClampedArray,
  width: number,
  height: number,
  effect: Effect,
  options: { frame: number; fps: number; scale?: number } & SpatialOptions,
): Uint8ClampedArray {
  const result = new Uint8ClampedArray(source),
    scale = options.scale ?? 1;
  if (effect.enabled === false) return result;
  if (effect.type === 'effectGraph')
    throw new VmotionError(
      'EFFECT_GRAPH_SOURCE',
      'Effect graphs need a graph runtime/source provider',
    );
  if (effect.type === 'motionBlur' || effect.type === 'echo')
    throw new VmotionError('TEMPORAL_SOURCE', 'Temporal effects need a time-sampled layer source');
  if (
    [
      'liquify',
      'meshWarp',
      'cornerPin',
      'waveWarp',
      'twirl',
      'bulge',
      'rgbSplit',
      'linearWipe',
      'radialWipe',
    ].includes(effect.type)
  )
    return applySpatialEffect(
      source,
      width,
      height,
      effect as Extract<
        Effect,
        {
          type:
            | 'liquify'
            | 'meshWarp'
            | 'cornerPin'
            | 'waveWarp'
            | 'twirl'
            | 'bulge'
            | 'rgbSplit'
            | 'linearWipe'
            | 'radialWipe';
        }
      >,
      options,
    );
  if (effect.type === 'displacement') {
    result.fill(0);
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const fx = x / (effect.scale * scale) + effect.evolution,
          fy = y / (effect.scale * scale) + effect.evolution * 0.73,
          dx =
            (fractalNoise(fx, fy, effect.seed, effect.octaves) - 0.5) * 2 * effect.amountX * scale,
          dy =
            (fractalNoise(fx + 91, fy + 57, effect.seed + 703, effect.octaves) - 0.5) *
            2 *
            effect.amountY *
            scale;
        samplePremultiplied(
          source,
          width,
          height,
          x + dx,
          y + dy,
          result,
          (y * width + x) * 4,
          effect.edge,
        );
      }
    return result;
  }
  if (effect.type === 'pixelate') {
    const size = Math.max(1, Math.round(effect.size * scale));
    for (let y = 0; y < height; y += size)
      for (let x = 0; x < width; x += size) {
        let a = 0,
          r = 0,
          g = 0,
          b = 0,
          count = 0;
        for (let dy = y; dy < Math.min(height, y + size); dy++)
          for (let dx = x; dx < Math.min(width, x + size); dx++) {
            const i = (dy * width + dx) * 4,
              alpha = source[i + 3] / 255;
            a += alpha;
            r += source[i] * alpha;
            g += source[i + 1] * alpha;
            b += source[i + 2] * alpha;
            count++;
          }
        for (let dy = y; dy < Math.min(height, y + size); dy++)
          for (let dx = x; dx < Math.min(width, x + size); dx++) {
            const i = (dy * width + dx) * 4;
            result[i] = a ? r / a : 0;
            result[i + 1] = a ? g / a : 0;
            result[i + 2] = a ? b / a : 0;
            result[i + 3] = (a / count) * 255;
          }
      }
    return result;
  }
  if (effect.type === 'gradientMap') {
    if (effect.stops.some((s, i) => i > 0 && s.offset <= effect.stops[i - 1].offset))
      throw new VmotionError('GRADIENT_MAP', 'Color stop offsets must increase');
    const stops = effect.stops.map((s) => ({
        ...s,
        rgb: [1, 3, 5].map((i) => parseInt(s.color.slice(i, i + 2), 16)),
      })),
      lut = Array.from({ length: 256 }, (_, i) => {
        const v = i / 255;
        let a = stops[0],
          b = a;
        for (let k = 1; k < stops.length; k++) {
          b = stops[k];
          if (v <= b.offset) break;
          a = b;
        }
        const t = a === b ? 0 : Math.max(0, Math.min(1, (v - a.offset) / (b.offset - a.offset)));
        return a.rgb.map((c, k) => c + (b.rgb[k] - c) * t);
      });
    for (let at = 0; at < source.length; at += 4)
      if (source[at + 3]) {
        const v = Math.round(
          source[at] * 0.2126 + source[at + 1] * 0.7152 + source[at + 2] * 0.0722,
        );
        for (let c = 0; c < 3; c++)
          result[at + c] = source[at + c] * (1 - effect.intensity) + lut[v][c] * effect.intensity;
      }
    return result;
  }
  let curves: number[][] | undefined;
  let key: number[] | undefined;
  let chroma: number[] | undefined;
  if (effect.type === 'levels' && effect.inputWhite <= effect.inputBlack)
    throw new VmotionError('LEVELS_RANGE', 'Input white must be greater than input black');
  if (effect.type === 'curves') {
    const lut = (points?: Array<{ x: number; y: number }>) =>
      Array.from({ length: 256 }, (_, i) => {
        if (!points) return i / 255;
        const x = i / 255;
        if (x <= points[0].x) return points[0].y;
        for (let k = 1; k < points.length; k++)
          if (x < points[k].x) {
            const a = points[k - 1],
              b = points[k];
            return a.y + ((b.y - a.y) * (x - a.x)) / (b.x - a.x);
          }
        return points.at(-1)!.y;
      });
    curves = [lut(effect.master), lut(effect.red), lut(effect.green), lut(effect.blue)];
  }
  if (effect.type === 'chromaKey') {
    key = [1, 3, 5].map((offset) => parseInt(effect.color.slice(offset, offset + 2), 16) / 255);
    const [r, g, b] = key;
    chroma = [-0.168736 * r - 0.331264 * g + 0.5 * b, 0.5 * r - 0.418688 * g - 0.081312 * b];
  }
  if (effect.type === 'lut3d') {
    if (
      effect.data.length !== effect.size ** 3 * 3 ||
      effect.domainMax.some((v, i) => v <= effect.domainMin[i])
    )
      throw new VmotionError('LUT_FORMAT', '3D LUT length or input domain is invalid');
  }
  for (let i = 0; i < source.length; i += 4) {
    if (source[i + 3] === 0) continue;
    const x = (i / 4) % width,
      y = Math.floor(i / 4 / width);
    let r = source[i] / 255,
      g = source[i + 1] / 255,
      b = source[i + 2] / 255;
    if (effect.type === 'chromaKey') {
      const cb = -0.168736 * r - 0.331264 * g + 0.5 * b,
        cr = 0.5 * r - 0.418688 * g - 0.081312 * b,
        distance = Math.hypot(cb - chroma![0], cr - chroma![1]),
        t = clamp((distance - effect.tolerance) / effect.softness),
        alpha = t * t * (3 - 2 * t);
      result[i + 3] = source[i + 3] * alpha;
      const dominant = key!.indexOf(Math.max(...key!));
      if (effect.despill > 0 && alpha < 1) {
        const channels = [r, g, b],
          other = channels.filter((_, index) => index !== dominant),
          ceiling = Math.max(...other);
        channels[dominant] -=
          Math.max(0, channels[dominant] - ceiling) * effect.despill * (1 - alpha);
        [r, g, b] = channels;
      }
    } else if (effect.type === 'levels') {
      const f = (v: number) =>
        effect.outputBlack +
        (effect.outputWhite - effect.outputBlack) *
          clamp((v - effect.inputBlack) / (effect.inputWhite - effect.inputBlack)) **
            (1 / effect.gamma);
      r = f(r);
      g = f(g);
      b = f(b);
    } else if (effect.type === 'curves') {
      const f = (v: number, channel: number) =>
        curves![channel][Math.round(clamp(curves![0][Math.round(v * 255)]) * 255)];
      r = f(r, 1);
      g = f(g, 2);
      b = f(b, 3);
    } else if (effect.type === 'lut3d') {
      const coordinates = [r, g, b].map(
          (v, c) =>
            clamp((v - effect.domainMin[c]) / (effect.domainMax[c] - effect.domainMin[c])) *
            (effect.size - 1),
        ),
        low = coordinates.map(Math.floor),
        fraction = coordinates.map((v, c) => v - low[c]),
        color = [0, 0, 0];
      for (let dz = 0; dz < 2; dz++)
        for (let dy = 0; dy < 2; dy++)
          for (let dx = 0; dx < 2; dx++) {
            const indexes = [
                Math.min(effect.size - 1, low[0] + dx),
                Math.min(effect.size - 1, low[1] + dy),
                Math.min(effect.size - 1, low[2] + dz),
              ],
              index = (indexes[0] + indexes[1] * effect.size + indexes[2] * effect.size ** 2) * 3,
              weight =
                (dx ? fraction[0] : 1 - fraction[0]) *
                (dy ? fraction[1] : 1 - fraction[1]) *
                (dz ? fraction[2] : 1 - fraction[2]);
            for (let c = 0; c < 3; c++) color[c] += effect.data[index + c] * weight;
          }
      r += (color[0] - r) * effect.intensity;
      g += (color[1] - g) * effect.intensity;
      b += (color[2] - b) * effect.intensity;
    } else if (effect.type === 'vignette') {
      const nx = (x / width - effect.center.x) * 2,
        ny = (y / height - effect.center.y) * 2,
        t = clamp((Math.hypot(nx, ny) - effect.radius) / effect.softness),
        factor = 1 - effect.amount * t * t * (3 - 2 * t);
      r = fromLinear(toLinear(r) * factor);
      g = fromLinear(toLinear(g) * factor);
      b = fromLinear(toLinear(b) * factor);
    } else if (effect.type === 'grain') {
      const frame = effect.animated ? Math.floor(options.frame) : 0;
      const grain = (channel: number) =>
        (noise2D(
          Math.floor(x / Math.max(scale, 1e-6)) * 1.91 + frame * 31,
          Math.floor(y / Math.max(scale, 1e-6)) * 1.91 + channel * 73,
          effect.seed,
        ) -
          0.5) *
        effect.amount;
      r += grain(0);
      g += grain(effect.monochrome ? 0 : 1);
      b += grain(effect.monochrome ? 0 : 2);
    }
    result[i] = clamp(r) * 255;
    result[i + 1] = clamp(g) * 255;
    result[i + 2] = clamp(b) * 255;
  }
  return result;
}
export function lumaMatte(source: Uint8ClampedArray) {
  const result = new Uint8ClampedArray(source);
  for (let i = 0; i < result.length; i += 4) {
    const luma =
      0.2126 * toLinear(source[i] / 255) +
      0.7152 * toLinear(source[i + 1] / 255) +
      0.0722 * toLinear(source[i + 2] / 255);
    result[i] = result[i + 1] = result[i + 2] = 255;
    result[i + 3] = source[i + 3] * luma;
  }
  return result;
}
