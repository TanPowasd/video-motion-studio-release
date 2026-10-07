// The worker owns two frame pyramids. It does not retain decoded video or execute models.
import type { TrackingSettings, TrackingSample } from './tracking-schema.js';
type Point = { x: number; y: number };
type Gray = { width: number; height: number; data: Float32Array };
type Result = { point: Point; feature: number; correlation: number; residual: number };
const fail = (code: string, message: string): never => {
  throw Object.assign(new Error(message), { code });
};
const clamp = (x: number, a = 0, b = 1) => Math.max(a, Math.min(b, x));
function sample(image: Gray, x: number, y: number) {
  const ix = Math.floor(x),
    iy = Math.floor(y),
    u = x - ix,
    v = y - iy,
    a = iy * image.width + ix;
  return (
    (image.data[a] * (1 - u) + image.data[a + 1] * u) * (1 - v) +
    (image.data[a + image.width] * (1 - u) + image.data[a + image.width + 1] * u) * v
  );
}
function inside(image: Gray, p: Point, r: number) {
  return p.x >= r + 1 && p.y >= r + 1 && p.x < image.width - r - 2 && p.y < image.height - r - 2;
}
export class SparseTracker {
  private previous?: Gray[];
  private states = new Map<string, { position?: Point; velocity: Point }>();
  readonly metrics = {
    pyramidPixels: 0,
    patchSamples: 0,
    iterations: 0,
    forwardBackwardChecks: 0,
    frameCalls: 0,
    peakBufferBytes: 0,
  };
  constructor(readonly settings: TrackingSettings) {}
  private pyramid(rgba: Uint8Array, width: number, height: number) {
    if (
      width < 32 ||
      height < 32 ||
      width > 1280 ||
      height > 1280 ||
      rgba.length !== width * height * 4
    )
      fail('TRACKING_FRAME', 'Use RGBA frames of 32–1280 pixels per dimension');
    const data = new Float32Array(width * height);
    for (let i = 0; i < data.length; i++)
      data[i] = (rgba[i * 4] * 0.2126 + rgba[i * 4 + 1] * 0.7152 + rgba[i * 4 + 2] * 0.0722) / 255;
    const levels: Gray[] = [{ width, height, data }];
    while (levels.length < this.settings.levels) {
      const prev = levels.at(-1)!,
        w = Math.floor(prev.width / 2),
        h = Math.floor(prev.height / 2);
      if (w < 16 || h < 16) break;
      const out = new Float32Array(w * h),
        scratch = new Float32Array(prev.width * prev.height),
        weights = [1, 4, 6, 4, 1];
      for (let y = 0; y < prev.height; y++)
        for (let x = 0; x < prev.width; x++) {
          let total = 0;
          for (let k = -2; k <= 2; k++)
            total += prev.data[y * prev.width + clamp(x + k, 0, prev.width - 1)] * weights[k + 2];
          scratch[y * prev.width + x] = total / 16;
        }
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let total = 0;
          for (let k = -2; k <= 2; k++)
            total +=
              scratch[clamp(2 * y + k, 0, prev.height - 1) * prev.width + 2 * x] * weights[k + 2];
          out[y * w + x] = total / 16;
        }
      levels.push({ width: w, height: h, data: out });
    }
    this.metrics.pyramidPixels += levels.reduce((n, v) => n + v.data.length, 0);
    this.metrics.peakBufferBytes = Math.max(
      this.metrics.peakBufferBytes,
      rgba.byteLength +
        4 * width * height +
        (this.previous ?? []).concat(levels).reduce((n, v) => n + v.data.byteLength, 0),
    );
    return levels;
  }
  private flow(
    from: Gray[],
    to: Gray[],
    p: Point,
    estimate: Point,
  ): Result | { reason: TrackingSample['reason'] } {
    let q = { ...estimate },
      feature = 0;
    const r = this.settings.radius,
      count = (r * 2 + 1) ** 2;
    for (let level = Math.min(from.length, to.length) - 1; level >= 0; level--) {
      const scale = 2 ** level,
        a = from[level],
        b = to[level],
        origin = { x: p.x / scale, y: p.y / scale };
      let pos = { x: q.x / scale, y: q.y / scale };
      if (!inside(a, origin, r) || !inside(b, pos, r)) {
        if (level === 0) return { reason: 'bounds' };
        continue;
      }
      const gx = new Float32Array(count),
        gy = new Float32Array(count),
        values = new Float32Array(count);
      let xx = 0,
        xy = 0,
        yy = 0,
        mean = 0,
        index = 0;
      for (let y = -r; y <= r; y++)
        for (let x = -r; x <= r; x++) {
          const px = origin.x + x,
            py = origin.y + y,
            v = sample(a, px, py),
            dx = (sample(a, px + 1, py) - sample(a, px - 1, py)) / 2,
            dy = (sample(a, px, py + 1) - sample(a, px, py - 1)) / 2;
          gx[index] = dx;
          gy[index] = dy;
          values[index++] = v;
          mean += v;
          xx += dx * dx;
          xy += dx * dy;
          yy += dy * dy;
        }
      mean /= count;
      const determinant = xx * yy - xy * xy,
        eigen = (xx + yy - Math.sqrt((xx - yy) ** 2 + 4 * xy * xy)) / (2 * count);
      feature = eigen;
      if (eigen < this.settings.minFeature || determinant < 1e-12) {
        if (level === 0) return { reason: 'lowTexture' };
        continue;
      }
      for (let iteration = 0; iteration < this.settings.iterations; iteration++) {
        if (!inside(b, pos, r)) {
          if (level === 0) return { reason: 'bounds' };
          break;
        }
        let sum = 0;
        for (let y = -r; y <= r; y++)
          for (let x = -r; x <= r; x++) sum += sample(b, pos.x + x, pos.y + y);
        const brightness = sum / count - mean;
        let bx = 0,
          by = 0;
        iLoop: for (let i = 0, y = -r; y <= r; y++)
          for (let x = -r; x <= r; x++, i++) {
            const difference = values[i] - sample(b, pos.x + x, pos.y + y) + brightness;
            bx += gx[i] * difference;
            by += gy[i] * difference;
          }
        this.metrics.iterations++;
        this.metrics.patchSamples += count * 2;
        const dx = (yy * bx - xy * by) / determinant,
          dy = (xx * by - xy * bx) / determinant;
        if (!Number.isFinite(dx) || !Number.isFinite(dy)) return { reason: 'lowTexture' };
        pos.x += clamp(dx, -3, 3);
        pos.y += clamp(dy, -3, 3);
        if (dx * dx + dy * dy < 0.0001) break;
      }
      q = { x: pos.x * scale, y: pos.y * scale };
    }
    const a = from[0],
      b = to[0];
    if (!inside(a, p, r) || !inside(b, q, r)) return { reason: 'bounds' };
    if (Math.hypot(q.x - p.x, q.y - p.y) > this.settings.maxDisplacement)
      return { reason: 'displacement' };
    let ma = 0,
      mb = 0;
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        ma += sample(a, p.x + x, p.y + y);
        mb += sample(b, q.x + x, q.y + y);
      }
    ma /= count;
    mb /= count;
    let varianceA = 0,
      varianceB = 0,
      covariance = 0,
      error = 0;
    for (let y = -r; y <= r; y++)
      for (let x = -r; x <= r; x++) {
        const av = sample(a, p.x + x, p.y + y) - ma,
          bv = sample(b, q.x + x, q.y + y) - mb;
        varianceA += av * av;
        varianceB += bv * bv;
        covariance += av * bv;
        error += (av - bv) ** 2;
      }
    this.metrics.patchSamples += count * 2;
    const correlation = clamp(
        covariance / Math.sqrt(Math.max(1e-15, varianceA * varianceB)),
        -1,
        1,
      ),
      residual = Math.sqrt(error / count);
    if (correlation < this.settings.minCorrelation || residual > this.settings.maxResidual)
      return { reason: 'photometric' };
    return { point: q, feature, correlation, residual };
  }
  detect(
    image: Gray,
    count: number,
    region?: { x: number; y: number; width: number; height: number },
  ) {
    const { width: w, height: h } = image,
      stride = w + 1,
      xx = new Float32Array(stride * (h + 1)),
      xy = new Float32Array(xx.length),
      yy = new Float32Array(xx.length);
    for (let y = 1; y < h - 1; y++) {
      let sx = 0,
        sxy = 0,
        sy = 0;
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x,
          gx = (image.data[i + 1] - image.data[i - 1]) / 2,
          gy = (image.data[i + w] - image.data[i - w]) / 2,
          j = (y + 1) * stride + x + 1;
        sx += gx * gx;
        sxy += gx * gy;
        sy += gy * gy;
        xx[j] = xx[j - stride] + sx;
        xy[j] = xy[j - stride] + sxy;
        yy[j] = yy[j - stride] + sy;
      }
    }
    const candidates: Array<Point & { score: number }> = [],
      r = 3,
      margin = this.settings.radius + 3,
      box = region ?? { x: margin, y: margin, width: w - margin * 2, height: h - margin * 2 },
      sum = (a: Float32Array, x: number, y: number) =>
        a[(y + r + 1) * stride + x + r + 1] -
        a[(y - r) * stride + x + r + 1] -
        a[(y + r + 1) * stride + x - r] +
        a[(y - r) * stride + x - r];
    for (
      let y = Math.max(margin, Math.ceil(box.y));
      y < Math.min(h - margin, box.y + box.height);
      y += 2
    )
      for (
        let x = Math.max(margin, Math.ceil(box.x));
        x < Math.min(w - margin, box.x + box.width);
        x += 2
      ) {
        const a = sum(xx, x, y),
          b = sum(xy, x, y),
          c = sum(yy, x, y),
          score = (a + c - Math.sqrt((a - c) ** 2 + 4 * b * b)) / (2 * 49);
        if (score >= this.settings.minFeature) candidates.push({ x, y, score });
      }
    candidates.sort((a, b) => b.score - a.score || a.y - b.y || a.x - b.x);
    const selected: Point[] = [];
    for (const p of candidates) {
      if (selected.every((q) => Math.hypot(p.x - q.x, p.y - q.y) > this.settings.radius * 3))
        selected.push({ x: p.x, y: p.y });
      if (selected.length >= count) break;
    }
    this.metrics.peakBufferBytes = Math.max(
      this.metrics.peakBufferBytes,
      xx.byteLength * 3 + image.data.byteLength * 2,
    );
    return selected;
  }
  frame(
    rgba: Uint8Array,
    width: number,
    height: number,
    frame: number,
    points: Array<{ id: string; seed?: Point }>,
    autoCount = 0,
    region?: { x: number; y: number; width: number; height: number },
  ) {
    const current = this.pyramid(rgba, width, height),
      detected = !this.previous && autoCount ? this.detect(current[0], autoCount, region) : [];
    points = [...points, ...detected.map((p, i) => ({ id: `feature-${i + 1}`, seed: p }))];
    const results: Array<{ id: string; sample: TrackingSample }> = [];
    for (const item of points) {
      const old = this.states.get(item.id) ?? { velocity: { x: 0, y: 0 } },
        lost = (reason: TrackingSample['reason'], evidence: Partial<TrackingSample> = {}) => ({
          frame,
          x: null,
          y: null,
          status: 'lost' as const,
          confidence: 0,
          reason,
          ...evidence,
        });
      let result: TrackingSample;
      if (item.seed) {
        if (!inside(current[0], item.seed, this.settings.radius)) result = lost('bounds');
        else result = { frame, ...item.seed, status: 'manual', confidence: 1 };
        this.states.set(item.id, {
          position: result.status === 'lost' ? undefined : item.seed,
          velocity: { x: 0, y: 0 },
        });
      } else if (!this.previous || !old.position)
        result = lost(this.states.has(item.id) ? 'stopped' : 'noSeed');
      else {
        const forward = this.flow(this.previous, current, old.position, {
          x: old.position.x + old.velocity.x,
          y: old.position.y + old.velocity.y,
        });
        if ('reason' in forward) result = lost(forward.reason);
        else {
          const backward = this.flow(current, this.previous, forward.point, old.position);
          this.metrics.forwardBackwardChecks++;
          const fb =
            'point' in backward
              ? Math.hypot(backward.point.x - old.position.x, backward.point.y - old.position.y)
              : this.settings.maxForwardBackward + 1;
          if (fb > this.settings.maxForwardBackward)
            result = lost('forwardBackward', {
              correlation: forward.correlation,
              residual: forward.residual,
              forwardBackward: fb,
            });
          else {
            result = {
              frame,
              ...forward.point,
              status: 'tracked',
              confidence: clamp(
                forward.correlation *
                  Math.exp(-fb / this.settings.maxForwardBackward) *
                  Math.exp(-forward.residual / this.settings.maxResidual),
              ),
              correlation: forward.correlation,
              residual: forward.residual,
              forwardBackward: fb,
            };
            this.states.set(item.id, {
              position: forward.point,
              velocity: {
                x: forward.point.x - old.position.x,
                y: forward.point.y - old.position.y,
              },
            });
          }
        }
        if (result.status === 'lost') this.states.set(item.id, { velocity: { x: 0, y: 0 } });
      }
      results.push({ id: item.id, sample: result });
    }
    this.previous = current;
    this.metrics.frameCalls++;
    return { points: results, detected, metrics: { ...this.metrics } };
  }
}
