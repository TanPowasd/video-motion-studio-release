import { it, expect } from 'vitest';
import { SparseTracker } from '../src/core/tracking-engine.js';
import { trackingSettingsSchema } from '../src/core/tracking-schema.js';
import {
  fitTrackingMotion,
  blendTrackingMotion,
  smoothTrackingMotion,
} from '../src/core/tracking.js';
const w = 192,
  h = 128;
it('blends rotation without scale collapse and smooths unwrapped angles', () => {
  const half = blendTrackingMotion([-1, 0, 0, -1, 20, 10], 0.5, 'similarity');
  expect(Math.hypot(half[0], half[1])).toBeCloseTo(1, 10);
  expect(half[1]).toBeCloseTo(1, 10);
  expect(half[4]).toBe(10);
  const matrices = [179, -179, -177].map((a) => {
      const r = (a * Math.PI) / 180;
      return [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0] as [
        number,
        number,
        number,
        number,
        number,
        number,
      ];
    }),
    smoothed = smoothTrackingMotion(matrices, 1, 'similarity');
  expect(Math.hypot(smoothed[0][0], smoothed[0][1])).toBeCloseTo(1, 10);
  expect(smoothed[0][0]).toBeLessThan(-0.999);
  expect(smoothTrackingMotion(matrices, 0, 'similarity')[0]).toEqual([1, 0, 0, 1, 0, 0]);
});
it('spreads deterministic fit hypotheses across landmarks when early IDs are outliers', () => {
  const pairs = Array.from({ length: 32 }, (_, i) => ({
    id: String(i),
    from: { x: (i % 8) * 25, y: Math.floor(i / 8) * 25 },
    to: { x: (i % 8) * 25 + 5, y: Math.floor(i / 8) * 25 - 3 },
  }));
  for (let i = 0; i < 6; i++) pairs[i].to = { x: 900 + i * 7, y: 400 - i * 11 };
  const fit = fitTrackingMotion(pairs, 'affine');
  expect(fit.inliers.length).toBe(26);
  expect(fit.matrix[4]).toBeCloseTo(5, 6);
  expect(fit.matrix[5]).toBeCloseTo(-3, 6);
  expect(fitTrackingMotion(pairs.slice(6), 'translation').attempts).toBe(1);
});
function image(dx = 0, dy = 0, angle = 0, blank = false) {
  const data = new Uint8Array(w * h * 4),
    c = Math.cos(angle),
    s = Math.sin(angle);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const px = c * (x - dx - w / 2) + s * (y - dy - h / 2) + w / 2,
        py = -s * (x - dx - w / 2) + c * (y - dy - h / 2) + h / 2,
        v = blank
          ? 110
          : Math.round(
              128 +
                42 * Math.sin(px * 0.33) +
                37 * Math.sin(py * 0.37) +
                28 * Math.sin((px + py) * 0.2),
            );
      const i = (y * w + x) * 4;
      data[i] = data[i + 1] = data[i + 2] = Math.max(0, Math.min(255, v));
      data[i + 3] = 255;
    }
  return data;
}
it('tracks subpixel translations/rotation with forward-backward evidence and bounded frame pyramids', () => {
  const tracker = new SparseTracker(trackingSettingsSchema.parse({ levels: 3 })),
    seed = { x: 78, y: 58 };
  expect(tracker.frame(image(), w, h, 0, [{ id: 'p', seed }]).points[0].sample.status).toBe(
    'manual',
  );
  const r = tracker.frame(image(3.25, -1.5), w, h, 1, [{ id: 'p' }]).points[0].sample;
  expect(r.status).toBe('tracked');
  expect(r.x).toBeCloseTo(seed.x + 3.25, 0);
  expect(r.y).toBeCloseTo(seed.y - 1.5, 0);
  expect(r.correlation).toBeGreaterThan(0.95);
  expect(r.forwardBackward).toBeLessThan(0.15);
  const b = tracker.frame(image(5, 1, 0.025), w, h, 2, [{ id: 'p' }]).points[0].sample;
  expect(b.status).toBe('tracked');
  expect(b.x).toBeCloseTo(
    w / 2 + Math.cos(0.025) * (seed.x - w / 2) - Math.sin(0.025) * (seed.y - h / 2) + 5,
    0,
  );
  expect(tracker.metrics.peakBufferBytes).toBeLessThan(2 * 1024 * 1024);
  expect(tracker.metrics.frameCalls).toBe(3);
});
it('marks occlusion/low texture as explicit loss and requires a manual reseed', () => {
  const tracker = new SparseTracker(trackingSettingsSchema.parse({}));
  tracker.frame(image(), w, h, 0, [{ id: 'p', seed: { x: 78, y: 58 } }]);
  const lost = tracker.frame(image(0, 0, 0, true), w, h, 1, [{ id: 'p' }]).points[0].sample;
  expect(lost.status).toBe('lost');
  expect(lost.x).toBeNull();
  expect(lost.confidence).toBe(0);
  expect(tracker.frame(image(4, 0), w, h, 2, [{ id: 'p' }]).points[0].sample.reason).toBe(
    'stopped',
  );
  expect(
    tracker.frame(image(4, 0), w, h, 3, [{ id: 'p', seed: { x: 82, y: 58 } }]).points[0].sample
      .status,
  ).toBe('manual');
  expect(tracker.frame(image(6, 0), w, h, 4, [{ id: 'p' }]).points[0].sample.x).toBeCloseTo(84, 0);
  const flat = new SparseTracker(trackingSettingsSchema.parse({}));
  flat.frame(image(0, 0, 0, true), w, h, 0, [{ id: 'f', seed: { x: 80, y: 60 } }]);
  expect(flat.frame(image(0, 0, 0, true), w, h, 1, [{ id: 'f' }]).points[0].sample.reason).toBe(
    'lowTexture',
  );
});
it('detects spatially separated repeatable corner seeds inside the requested region', () => {
  const a = new SparseTracker(trackingSettingsSchema.parse({})),
    b = new SparseTracker(trackingSettingsSchema.parse({})),
    x = a.frame(image(), w, h, 0, [], 4, { x: 40, y: 30, width: 100, height: 70 }),
    y = b.frame(image(), w, h, 0, [], 4, { x: 40, y: 30, width: 100, height: 70 });
  expect(x.detected).toEqual(y.detected);
  expect(x.detected).toHaveLength(4);
  for (const p of x.detected) expect(p.x >= 40 && p.x < 140 && p.y >= 30 && p.y < 100).toBe(true);
});
it('robust transform fitting rejects an outlier and preserves affine/similarity conventions', () => {
  const points = [
      { x: 0, y: 0 },
      { x: 100, y: 0 },
      { x: 100, y: 100 },
      { x: 0, y: 100 },
      { x: 50, y: 50 },
    ],
    pairs = points.map((p, i) => ({
      id: String(i),
      from: p,
      to: { x: 1.2 * p.x - 0.2 * p.y + 7, y: 0.2 * p.x + 1.2 * p.y - 3 },
    }));
  pairs[4].to = { x: 400, y: 500 };
  const fit = fitTrackingMotion(pairs, 'similarity');
  expect(fit.rejected).toEqual(['4']);
  expect(fit.matrix).toEqual(expect.arrayContaining([expect.any(Number)]));
  fit.matrix.forEach((v, i) => expect(v).toBeCloseTo([1.2, 0.2, -0.2, 1.2, 7, -3][i], 8));
  const affine = fitTrackingMotion(
    pairs.slice(0, 4).map((p) => ({
      ...p,
      to: { x: p.from.x + 0.3 * p.from.y + 7, y: 0.1 * p.from.x + 0.8 * p.from.y - 3 },
    })),
    'affine',
  );
  affine.matrix.forEach((v, i) => expect(v).toBeCloseTo([1, 0.1, 0.3, 0.8, 7, -3][i], 8));
  expect(() => fitTrackingMotion(pairs.slice(0, 1), 'similarity')).toThrow('2–32');
});
