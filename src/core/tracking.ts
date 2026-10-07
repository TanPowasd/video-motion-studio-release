import {
  trackingDocumentSchema,
  type TrackingDocument,
  type TrackingSample,
} from './tracking-schema.js';
import { VmotionError } from './model.js';
import { leastSquares } from '../sdk/linear-algebra.js';
import { transform, type Matrix, type Point } from './interaction.js';
export type PreparedTracking = {
  document: TrackingDocument;
  points: Map<string, TrackingDocument['points'][number]>;
};
export function prepareTracking(input: unknown): PreparedTracking {
  const document = trackingDocumentSchema.parse(input);
  return { document, points: new Map(document.points.map((p) => [p.id, p])) };
}
export function sampleTrackedPoint(
  prepared: PreparedTracking,
  id: string,
  frame: number,
  loss: 'error' | 'hold' = 'error',
) {
  if (!Number.isFinite(frame))
    throw new VmotionError('TRACKING_FRAME', 'Tracking sample time must be finite');
  const point = prepared.points.get(id),
    doc = prepared.document;
  if (!point)
    throw new VmotionError('TRACKING_POINT', `Point ${id} is not in this tracking document`);
  if (frame < doc.range.start || frame >= doc.range.end)
    throw new VmotionError('TRACKING_RANGE', 'Tracking frame is outside recorded coverage', {
      frame,
      range: doc.range,
    });
  const at = frame - doc.range.start,
    low = Math.floor(at),
    high = Math.min(point.samples.length - 1, Math.ceil(at)),
    a = point.samples[low],
    b = point.samples[high];
  if (a.status === 'lost' || b.status === 'lost') {
    if (loss === 'hold')
      for (let i = low; i >= 0; i--)
        if (point.samples[i].status !== 'lost') return { ...point.samples[i], frame, held: true };
    throw new VmotionError('TRACKING_LOST', `Point ${id} has no reliable position at ${frame}f`, {
      pointId: id,
      frame,
      reason: a.reason ?? b.reason,
    });
  }
  const t = at - low;
  return {
    ...a,
    frame,
    x: a.x! + (b.x! - a.x!) * t,
    y: a.y! + (b.y! - a.y!) * t,
    confidence: Math.min(a.confidence, b.confidence),
    held: false,
  };
}
export function trackingGaps(samples: TrackingSample[]) {
  const gaps: Array<{ start: number; end: number; reason?: string }> = [];
  for (const s of samples)
    if (s.status === 'lost') {
      const old = gaps.at(-1);
      if (old?.end === s.frame && old.reason === s.reason) old.end = s.frame + 1;
      else gaps.push({ start: s.frame, end: s.frame + 1, reason: s.reason });
    }
  return gaps;
}
export type TrackingPair = { id: string; from: Point; to: Point; weight?: number };
export type TrackingModel = 'translation' | 'similarity' | 'affine';
function solve(pairs: TrackingPair[], model: TrackingModel): Matrix {
  if (model === 'translation') {
    const weights = pairs.map((p) => Math.max(1e-6, p.weight ?? 1)),
      total = weights.reduce((s, w) => s + w, 0);
    return [
      1,
      0,
      0,
      1,
      pairs.reduce((s, p, i) => s + (p.to.x - p.from.x) * weights[i], 0) / total,
      pairs.reduce((s, p, i) => s + (p.to.y - p.from.y) * weights[i], 0) / total,
    ];
  }
  const rows: number[][] = [],
    rhs: number[] = [];
  for (const p of pairs) {
    const { x, y } = p.from,
      w = Math.sqrt(Math.max(1e-6, p.weight ?? 1));
    rows.push(
      (model === 'similarity' ? [x, -y, 1, 0] : [x, y, 1, 0, 0, 0]).map((v) => v * w),
      (model === 'similarity' ? [y, x, 0, 1] : [0, 0, 0, x, y, 1]).map((v) => v * w),
    );
    rhs.push(p.to.x * w, p.to.y * w);
  }
  const fit = leastSquares(rows, rhs);
  if (fit.rank < (model === 'similarity' ? 4 : 6))
    throw new VmotionError(
      'TRACKING_DEGENERATE',
      'Tracked landmarks do not constrain this transform model',
    );
  const s = fit.solution;
  return model === 'similarity'
    ? [s[0], s[1], -s[1], s[0], s[2], s[3]]
    : [s[0], s[3], s[1], s[4], s[2], s[5]];
}
export function fitTrackingMotion(
  pairs: TrackingPair[],
  model: TrackingModel = 'similarity',
  threshold = 2,
) {
  const minimum = model === 'translation' ? 1 : model === 'similarity' ? 2 : 3;
  if (
    pairs.length < minimum ||
    pairs.length > 32 ||
    !Number.isFinite(threshold) ||
    threshold <= 0 ||
    pairs.some((p) => ![p.from.x, p.from.y, p.to.x, p.to.y, p.weight ?? 1].every(Number.isFinite))
  )
    throw new VmotionError(
      'TRACKING_FIT',
      `Use ${minimum}–32 finite landmark pairs and a positive residual threshold`,
    );
  const error = (matrix: Matrix, p: TrackingPair) => {
    const q = transform(matrix, p.from);
    return Math.hypot(q.x - p.to.x, q.y - p.to.y);
  };
  let best: TrackingPair[] = [],
    bestError = Infinity,
    attempts = 0;
  // Deterministic subsets; no dependence on global random state or frame order.
  const consider = (subset: TrackingPair[]) => {
    try {
      const m = solve(subset, model),
        inliers = pairs.filter((p) => error(m, p) <= threshold),
        residual = inliers.reduce((s, p) => s + error(m, p) ** 2, 0);
      if (
        inliers.length > best.length ||
        (inliers.length === best.length && residual < bestError)
      ) {
        best = inliers;
        bestError = residual;
      }
    } catch {}
    attempts++;
  };
  consider(pairs);
  if (best.length === pairs.length) {
    // The weighted fit already agrees with every landmark; avoid needless subset QR solves.
  } else if (pairs.length <= 10)
    for (let i = 0; i < pairs.length && attempts < 128; i++) {
      if (minimum === 1) consider([pairs[i]]);
      else
        for (let j = i + 1; j < pairs.length && attempts < 128; j++) {
          if (minimum === 2) consider([pairs[i], pairs[j]]);
          else
            for (let k = j + 1; k < pairs.length && attempts < 128; k++)
              consider([pairs[i], pairs[j], pairs[k]]);
        }
    }
  else {
    let seed = 7919;
    while (attempts < 128) {
      const indices = new Set<number>();
      while (indices.size < minimum) {
        seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
        indices.add(seed % pairs.length);
      }
      consider([...indices].map((i) => pairs[i]));
    }
  }
  if (best.length < minimum)
    throw new VmotionError('TRACKING_DEGENERATE', 'No reliable transform could be fitted');
  const matrix = solve(best, model),
    inliers = pairs.filter((p) => error(matrix, p) <= threshold);
  if (inliers.length < minimum || Math.abs(matrix[0] * matrix[3] - matrix[1] * matrix[2]) < 1e-10)
    throw new VmotionError('TRACKING_DEGENERATE', 'Tracking transform is singular or inconsistent');
  return {
    matrix,
    inliers: inliers.map((p) => p.id),
    rejected: pairs.filter((p) => !inliers.includes(p)).map((p) => p.id),
    rms: Math.sqrt(inliers.reduce((s, p) => s + error(matrix, p) ** 2, 0) / inliers.length),
    attempts,
  };
}
export function blendTrackingMotion(
  matrix: Matrix,
  strength: number,
  model: TrackingModel,
): Matrix {
  if (!Number.isFinite(strength) || strength < 0 || strength > 1)
    throw new VmotionError('TRACKING_STRENGTH', 'Strength must be 0–1');
  if (model === 'similarity') {
    const scale = Math.hypot(matrix[0], matrix[1]);
    if (scale < 1e-10) throw new VmotionError('TRACKING_DEGENERATE', 'Similarity scale is zero');
    const angle = Math.atan2(matrix[1], matrix[0]) * strength,
      s = Math.exp(Math.log(scale) * strength),
      c = Math.cos(angle) * s,
      t = Math.sin(angle) * s;
    return [c, t, -t, c, matrix[4] * strength, matrix[5] * strength];
  }
  const m = matrix.map(
    (v, i) => [1, 0, 0, 1, 0, 0][i] + (v - [1, 0, 0, 1, 0, 0][i]) * strength,
  ) as Matrix;
  if (Math.abs(m[0] * m[3] - m[1] * m[2]) < 1e-10)
    throw new VmotionError('TRACKING_DEGENERATE', 'Blended affine transform is singular');
  return m;
}
export function smoothTrackingMotion(
  matrices: Matrix[],
  radius: number,
  model: TrackingModel,
): Matrix[] {
  if (!Number.isInteger(radius) || radius < 0 || radius > 120)
    throw new VmotionError('TRACKING_SMOOTH', 'Smoothing radius uses 0–120 frames');
  if (!radius) return matrices.map(() => [1, 0, 0, 1, 0, 0]);
  const values = matrices.map((m) =>
    model === 'similarity'
      ? [Math.atan2(m[1], m[0]), Math.log(Math.max(1e-10, Math.hypot(m[0], m[1]))), m[4], m[5]]
      : [...m],
  );
  if (model === 'similarity')
    for (let i = 1; i < values.length; i++) {
      while (values[i][0] - values[i - 1][0] > Math.PI) values[i][0] -= Math.PI * 2;
      while (values[i][0] - values[i - 1][0] < -Math.PI) values[i][0] += Math.PI * 2;
    }
  const prefix = Array.from({ length: values[0]?.length ?? 0 }, (_, j) => {
    const sums = [0];
    for (const v of values) sums.push(sums.at(-1)! + v[j]);
    return sums;
  });
  return values.map((_, i) => {
    const from = Math.max(0, i - radius),
      end = Math.min(values.length, i + radius + 1),
      v = prefix.map((s) => (s[end] - s[from]) / (end - from));
    if (model !== 'similarity') return v as Matrix;
    const scale = Math.exp(v[1]),
      c = Math.cos(v[0]) * scale,
      s = Math.sin(v[0]) * scale;
    return [c, s, -s, c, v[2], v[3]];
  });
}
export function trackingMotion(
  prepared: PreparedTracking,
  fromFrame: number,
  toFrame: number,
  pointIds: string[],
  model: TrackingModel = 'similarity',
  loss: 'error' | 'hold' = 'error',
  threshold = 2,
) {
  return fitTrackingMotion(
    pointIds.map((id) => {
      const a = sampleTrackedPoint(prepared, id, fromFrame, loss),
        b = sampleTrackedPoint(prepared, id, toFrame, loss);
      return {
        id,
        from: { x: a.x!, y: a.y! },
        to: { x: b.x!, y: b.y! },
        weight: Math.min(a.confidence, b.confidence),
      };
    }),
    model,
    threshold,
  );
}
