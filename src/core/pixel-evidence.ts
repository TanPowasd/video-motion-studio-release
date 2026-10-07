import { VmotionError } from './model.js';
export type PixelRegion = { x: number; y: number; width: number; height: number };
export type PixelEvidenceOptions = {
  region?: PixelRegion;
  bins?: number;
  columns?: number;
  vectorSize?: number;
  distributions?: boolean;
  analysis: 'full' | 'sampled';
  maxSamples?: number;
  alpha: 'visible' | 'weighted' | 'black';
};
function region(width: number, height: number, requested?: PixelRegion) {
  const area = requested ?? { x: 0, y: 0, width, height };
  if (
    !Number.isInteger(width) ||
    !Number.isInteger(height) ||
    width <= 0 ||
    height <= 0 ||
    !Object.values(area).every(Number.isInteger) ||
    area.x < 0 ||
    area.y < 0 ||
    area.width < 1 ||
    area.height < 1 ||
    area.x + area.width > width ||
    area.y + area.height > height
  )
    throw new VmotionError('PIXEL_REGION', 'Pixel region must fit inside rendered dimensions');
  return area;
}
export function pixelEvidence(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  p: PixelEvidenceOptions,
) {
  if (pixels.length !== width * height * 4)
    throw new VmotionError('PIXEL_BUFFER', 'RGBA dimensions do not match');
  const area = region(width, height, p.region),
    bins = p.bins ?? 64,
    columns = p.columns ?? 32,
    vectorSize = p.vectorSize ?? 32;
  if (
    !['full', 'sampled'].includes(p.analysis) ||
    !['visible', 'weighted', 'black'].includes(p.alpha)
  )
    throw new VmotionError('PIXEL_OPTIONS', 'Choose an explicit analysis and alpha mode');
  if (
    !Number.isInteger(bins) ||
    bins < 8 ||
    bins > 256 ||
    !Number.isInteger(columns) ||
    columns < 4 ||
    columns > 128 ||
    !Number.isInteger(vectorSize) ||
    vectorSize < 8 ||
    vectorSize > 64
  )
    throw new VmotionError('PIXEL_SCOPE_SIZE', 'Scope dimensions exceed bounded limits');
  const max = p.maxSamples ?? 65536;
  if (!Number.isInteger(max) || max < 1 || max > 1000000)
    throw new VmotionError('PIXEL_SAMPLES', 'Sampling requires a positive bounded integer');
  const histogram = Array.from({ length: 4 }, () => new Float64Array(bins)),
    waveform = p.distributions
      ? Array.from({ length: 4 }, () => new Float64Array(bins * columns))
      : undefined,
    vectors = p.distributions ? new Float64Array(vectorSize * vectorSize) : undefined,
    totals = [0, 0, 0, 0],
    low = [0, 0, 0, 0],
    high = [0, 0, 0, 0],
    values = new Float64Array(4),
    areaPixels = area.width * area.height,
    stride = p.analysis === 'full' ? 1 : Math.max(1, Math.ceil(areaPixels / max));
  let visited = 0,
    visible = 0,
    alphaSum = 0,
    weightSum = 0,
    squaredLuma = 0;
  for (let index = 0; index < areaPixels; index += stride) {
    const x = area.x + (index % area.width),
      y = area.y + Math.floor(index / area.width),
      at = (y * width + x) * 4,
      a = pixels[at + 3] / 255;
    visited++;
    alphaSum += a;
    if (a > 0) visible++;
    const weight = p.alpha === 'weighted' ? a : p.alpha === 'visible' ? (a > 0 ? 1 : 0) : 1;
    if (!weight) continue;
    const multiplier = p.alpha === 'black' ? a : 1,
      r = (pixels[at] / 255) * multiplier,
      g = (pixels[at + 1] / 255) * multiplier,
      b = (pixels[at + 2] / 255) * multiplier,
      luma = r * 0.2126 + g * 0.7152 + b * 0.0722;
    values[0] = r;
    values[1] = g;
    values[2] = b;
    values[3] = luma;
    weightSum += weight;
    squaredLuma += luma * luma * weight;
    for (let c = 0; c < 4; c++) {
      const value = values[c],
        bin = Math.min(bins - 1, Math.floor(value * bins));
      histogram[c][bin] += weight;
      totals[c] += value * weight;
      if (value <= 1 / 255) low[c] += weight;
      if (value >= 254 / 255) high[c] += weight;
      if (waveform) {
        const column = Math.min(columns - 1, Math.floor(((x - area.x) * columns) / area.width));
        waveform[c][column * bins + bin] += weight;
      }
    }
    if (vectors) {
      const u = (b - luma) / 1.8556,
        v = (r - luma) / 1.5748,
        vx = Math.min(vectorSize - 1, Math.max(0, Math.floor((u + 0.5) * vectorSize))),
        vy = Math.min(vectorSize - 1, Math.max(0, Math.floor((0.5 - v) * vectorSize)));
      vectors[vy * vectorSize + vx] += weight;
    }
  }
  const names = ['red', 'green', 'blue', 'luma'],
    percentiles = (data: Float64Array) =>
      [0.01, 0.1, 0.5, 0.9, 0.99].map((q) => {
        if (!weightSum) return null;
        let total = 0;
        for (let i = 0; i < data.length; i++) {
          total += data[i];
          if (total >= weightSum * q) return (i + 0.5) / bins;
        }
        return 1;
      }),
    summaries = names.map((name, i) => ({
      channel: name,
      mean: weightSum ? totals[i] / weightSum : null,
      lowRatio: weightSum ? low[i] / weightSum : null,
      highRatio: weightSum ? high[i] / weightSum : null,
      percentiles: percentiles(histogram[i]),
    })),
    rounded = (values: Float64Array) => Array.from(values, (v) => Math.round(v * 1e6) / 1e6);
  return {
    region: area,
    coverage: {
      regionPixels: areaPixels,
      visited,
      visibleSamples: visible,
      stride,
      fullPixelCoverage: stride === 1,
      weight: weightSum,
      alphaMode: p.alpha,
      meanAlpha: visited ? alphaSum / visited : 0,
    },
    summary: {
      channels: summaries,
      lumaVariance: weightSum
        ? Math.max(0, squaredLuma / weightSum - (totals[3] / weightSum) ** 2)
        : null,
    },
    ...(p.distributions
      ? {
          histogram: {
            bins,
            channels: names.map((name, i) => ({ channel: name, counts: rounded(histogram[i]) })),
          },
          waveform: {
            bins,
            columns,
            layout: 'column-major, low to high',
            channels: names.map((name, i) => ({ channel: name, counts: rounded(waveform![i]) })),
          },
          vectorscope: {
            size: vectorSize,
            space: 'Encoded sRGB weighted Rec.709 UV, U left-right, V top-bottom',
            counts: rounded(vectors!),
          },
        }
      : {}),
  };
}
export function comparePixels(
  a: Uint8ClampedArray,
  b: Uint8ClampedArray,
  width: number,
  height: number,
  p: { region?: PixelRegion; tolerance?: number; diff?: boolean } = {},
) {
  if (a.length !== b.length || a.length !== width * height * 4)
    throw new VmotionError('PIXEL_BUFFER', 'Compare requires matching RGBA dimensions');
  const area = region(width, height, p.region),
    tolerance = p.tolerance ?? 0;
  if (!Number.isInteger(tolerance) || tolerance < 0 || tolerance > 255)
    throw new VmotionError('PIXEL_TOLERANCE', 'Tolerance is an 8-bit integer');
  let changed = 0,
    exact = 0,
    sum = 0,
    squares = 0,
    maximum = 0,
    x0 = width,
    y0 = height,
    x1 = -1,
    y1 = -1;
  const diff = p.diff ? new Uint8ClampedArray(a.length) : undefined;
  for (let y = area.y; y < area.y + area.height; y++)
    for (let x = area.x; x < area.x + area.width; x++) {
      const at = (y * width + x) * 4,
        aa = a[at + 3] / 255,
        ba = b[at + 3] / 255,
        d0 = Math.abs(a[at] * aa - b[at] * ba),
        d1 = Math.abs(a[at + 1] * aa - b[at + 1] * ba),
        d2 = Math.abs(a[at + 2] * aa - b[at + 2] * ba),
        d3 = Math.abs(a[at + 3] - b[at + 3]),
        max = Math.max(d0, d1, d2, d3);
      if (max > 0) exact++;
      if (max > tolerance) {
        changed++;
        x0 = Math.min(x0, x);
        y0 = Math.min(y0, y);
        x1 = Math.max(x1, x);
        y1 = Math.max(y1, y);
      }
      sum += d0 + d1 + d2 + d3;
      squares += d0 * d0 + d1 * d1 + d2 * d2 + d3 * d3;
      maximum = Math.max(maximum, max);
      if (diff) {
        const intensity = Math.round(max);
        diff[at] = intensity;
        diff[at + 1] = Math.round(intensity * 0.25);
        diff[at + 2] = intensity;
        diff[at + 3] = 255;
      }
    }
  const count = area.width * area.height;
  return {
    region: area,
    tolerance,
    comparedPixels: count,
    changedPixels: changed,
    exactChangedPixels: exact,
    changedRatio: changed / count,
    meanAbsolute8bit: sum / (count * 4),
    rms8bit: Math.sqrt(squares / (count * 4)),
    maximum8bit: maximum,
    changedBounds: changed ? { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 } : null,
    ...(diff ? { diff } : {}),
  };
}
