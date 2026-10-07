import { VmotionError } from '../core/model.js';

export type Matrix = readonly (readonly number[])[];
export type Vector = readonly number[] | Float64Array;
const tolerance = 1e-12;
function invalid(message: string): never {
  throw new VmotionError('MATRIX_SHAPE', message);
}
function finite(values: Iterable<number>) {
  for (const value of values)
    if (!Number.isFinite(value))
      throw new VmotionError('MATRIX_NONFINITE', 'Matrix inputs and results must be finite');
}
function dense(a: Matrix) {
  const rows = a.length,
    cols = a[0]?.length ?? 0;
  if (!rows || !cols || rows > 256 || cols > 256 || a.some((r) => r.length !== cols))
    invalid('Expected a rectangular matrix with 1–256 rows and columns');
  const data = Float64Array.from(a.flat());
  finite(data);
  return { rows, cols, data };
}
const unpack = (data: Float64Array, rows: number, cols: number) => {
  finite(data);
  return Array.from({ length: rows }, (_, i) =>
    Array.from(data.subarray(i * cols, (i + 1) * cols)),
  );
};
export function matrixIdentity(size: number): number[][] {
  if (!Number.isInteger(size) || size < 1 || size > 256) invalid('Identity size must be 1–256');
  return Array.from({ length: size }, (_, i) =>
    Array.from({ length: size }, (_, j) => Number(i === j)),
  );
}
export function matrixTranspose(a: Matrix): number[][] {
  const { rows, cols, data } = dense(a);
  return Array.from({ length: cols }, (_, j) =>
    Array.from({ length: rows }, (_, i) => data[i * cols + j]),
  );
}
export function matrixMultiply(a: Matrix, b: Matrix): number[][] {
  const left = dense(a),
    right = dense(b);
  if (left.cols !== right.rows) invalid('Matrix product inner dimensions must match');
  const out = new Float64Array(left.rows * right.cols);
  // Row-major i/k/j loop reuses a scalar and contiguous rows, without per-cell allocations.
  for (let i = 0; i < left.rows; i++)
    for (let k = 0; k < left.cols; k++) {
      const value = left.data[i * left.cols + k];
      for (let j = 0; j < right.cols; j++)
        out[i * right.cols + j] += value * right.data[k * right.cols + j];
    }
  return unpack(out, left.rows, right.cols);
}
export function matrixVector(a: Matrix, b: Vector): number[] {
  const { rows, cols, data } = dense(a);
  if (b.length !== cols) invalid('Matrix/vector dimensions must match');
  finite(b);
  const out = new Float64Array(rows);
  for (let i = 0; i < rows; i++) for (let j = 0; j < cols; j++) out[i] += data[i * cols + j] * b[j];
  finite(out);
  return Array.from(out);
}
/** Factor once outside render(ctx), then reuse solve() for many frames/right hand sides. */
export function matrixLU(a: Matrix, relativeTolerance = tolerance) {
  const { rows: n, cols, data } = dense(a);
  if (n !== cols) invalid('LU requires a square matrix');
  if (!(relativeTolerance > 0 && relativeTolerance < 1))
    invalid('Tolerance must be between 0 and 1');
  const permutation = Array.from({ length: n }, (_, i) => i),
    scale = new Float64Array(n);
  let sign = 1;
  for (let i = 0; i < n; i++)
    scale[i] = Math.max(...data.subarray(i * n, (i + 1) * n).map(Math.abs));
  for (let k = 0; k < n; k++) {
    let pivot = k,
      best = -1;
    for (let i = k; i < n; i++) {
      const score = scale[i] ? Math.abs(data[i * n + k]) / scale[i] : 0;
      if (score > best) {
        best = score;
        pivot = i;
      }
    }
    if (best <= relativeTolerance)
      throw new VmotionError(
        'MATRIX_SINGULAR',
        'Matrix is singular or numerically rank deficient at the requested tolerance',
        { pivot: k, relativeTolerance },
      );
    if (pivot !== k) {
      for (let j = 0; j < n; j++)
        [data[k * n + j], data[pivot * n + j]] = [data[pivot * n + j], data[k * n + j]];
      [scale[k], scale[pivot]] = [scale[pivot], scale[k]];
      [permutation[k], permutation[pivot]] = [permutation[pivot], permutation[k]];
      sign = -sign;
    }
    for (let i = k + 1; i < n; i++) {
      data[i * n + k] /= data[k * n + k];
      for (let j = k + 1; j < n; j++) data[i * n + j] -= data[i * n + k] * data[k * n + j];
    }
  }
  finite(data);
  return {
    size: n,
    determinant: () => {
      let value = sign;
      for (let i = 0; i < n; i++) value *= data[i * n + i];
      finite([value]);
      return value;
    },
    solve: (b: Vector): number[] => {
      if (b.length !== n) invalid('Right hand side must match matrix size');
      finite(b);
      const x = Float64Array.from(permutation.map((i) => b[i]));
      for (let i = 0; i < n; i++) for (let j = 0; j < i; j++) x[i] -= data[i * n + j] * x[j];
      for (let i = n - 1; i >= 0; i--) {
        for (let j = i + 1; j < n; j++) x[i] -= data[i * n + j] * x[j];
        x[i] /= data[i * n + i];
      }
      finite(x);
      return Array.from(x);
    },
  };
}
export const matrixSolve = (a: Matrix, b: Vector) => matrixLU(a).solve(b);
export function matrixDeterminant(a: Matrix): number {
  try {
    return matrixLU(a).determinant();
  } catch (e) {
    if (e instanceof VmotionError && e.code === 'MATRIX_SINGULAR') return 0;
    throw e;
  }
}
export function matrixInverse(a: Matrix): number[][] {
  const factor = matrixLU(a),
    columns = matrixIdentity(factor.size).map((b) => factor.solve(b));
  return matrixTranspose(columns);
}
export function vectorDot(a: Vector, b: Vector): number {
  if (a.length !== b.length || !a.length) invalid('Dot product requires equal nonempty vectors');
  finite(a);
  finite(b);
  let sum = 0,
    correction = 0;
  for (let i = 0; i < a.length; i++) {
    const term = a[i] * b[i] - correction,
      next = sum + term;
    correction = next - sum - term;
    sum = next;
  }
  finite([sum]);
  return sum;
}
export function vectorNorm(a: Vector): number {
  finite(a);
  let norm = 0;
  for (const value of a) norm = Math.hypot(norm, value);
  finite([norm]);
  return norm;
}

/** Column-pivoted Householder QR avoids the condition-number squaring of normal equations. */
export function leastSquares(a: Matrix, b: Vector, relativeTolerance = tolerance) {
  const { rows: m, cols: n, data } = dense(a);
  if (m < n || b.length !== m)
    invalid('Least squares requires rows >= columns and one RHS value per row');
  if (!(relativeTolerance > 0 && relativeTolerance < 1))
    invalid('Tolerance must be between 0 and 1');
  finite(b);
  const rhs = Float64Array.from(b),
    permutation = Array.from({ length: n }, (_, i) => i);
  const norm = (j: number, start: number) =>
    Math.hypot(...Array.from({ length: m - start }, (_, i) => data[(i + start) * n + j]));
  const initial = Math.max(...Array.from({ length: n }, (_, j) => norm(j, 0)));
  for (let k = 0; k < n; k++) {
    let pivot = k,
      length = norm(k, k);
    for (let j = k + 1; j < n; j++) {
      const candidate = norm(j, k);
      if (candidate > length) {
        length = candidate;
        pivot = j;
      }
    }
    if (!length || length <= relativeTolerance * initial)
      throw new VmotionError(
        'MATRIX_RANK',
        'Least-squares matrix is rank deficient; no unique solution',
        { rank: k, columns: n, relativeTolerance },
      );
    if (pivot !== k) {
      for (let i = 0; i < m; i++)
        [data[i * n + k], data[i * n + pivot]] = [data[i * n + pivot], data[i * n + k]];
      [permutation[k], permutation[pivot]] = [permutation[pivot], permutation[k]];
    }
    const alpha = data[k * n + k] >= 0 ? -length : length,
      v = Float64Array.from({ length: m - k }, (_, i) => data[(i + k) * n + k] / length);
    v[0] -= alpha / length;
    const beta = 2 / vectorDot(v, v);
    for (let j = k; j < n; j++) {
      let dot = 0;
      for (let i = k; i < m; i++) dot += v[i - k] * data[i * n + j];
      for (let i = k; i < m; i++) data[i * n + j] -= beta * v[i - k] * dot;
    }
    let dot = 0;
    for (let i = k; i < m; i++) dot += v[i - k] * rhs[i];
    for (let i = k; i < m; i++) rhs[i] -= beta * v[i - k] * dot;
    data[k * n + k] = alpha;
  }
  const pivoted = new Float64Array(n),
    solution = new Float64Array(n);
  for (let i = n - 1; i >= 0; i--) {
    let value = rhs[i];
    for (let j = i + 1; j < n; j++) value -= data[i * n + j] * pivoted[j];
    pivoted[i] = value / data[i * n + i];
    solution[permutation[i]] = pivoted[i];
  }
  finite(solution);
  const residual = matrixVector(a, solution).map((v, i) => v - b[i]);
  return {
    solution: Array.from(solution),
    rank: n,
    residualNorm: vectorNorm(residual),
    residual,
    permutation,
    method: 'column-pivoted-householder-qr' as const,
  };
}

/** Prepared immutable matrix with a batch loop, useful for grids, particles and mesh projections. */
export function preparePointTransform(a: Matrix, dimensions: number, project = false) {
  const { rows, cols, data } = dense(a);
  if (
    !Number.isInteger(dimensions) ||
    dimensions < 1 ||
    dimensions > 16 ||
    (cols !== dimensions && cols !== dimensions + 1)
  )
    invalid('Transform columns must match point dimensions, with an optional translation column');
  if (project && (rows !== dimensions + 1 || cols !== dimensions + 1))
    invalid('Perspective division requires a homogeneous square matrix');
  return (points: readonly Vector[]): number[][] => {
    if (points.length > 100000) invalid('Point batch exceeds 100000');
    return points.map((p) => {
      if (p.length !== dimensions) invalid('All points must share the declared dimension');
      finite(p);
      const result = new Float64Array(rows);
      for (let i = 0; i < rows; i++) {
        result[i] = cols > dimensions ? data[i * cols + dimensions] : 0;
        for (let j = 0; j < dimensions; j++) result[i] += data[i * cols + j] * p[j];
      }
      if (project) {
        const w = result[rows - 1];
        if (w === 0)
          throw new VmotionError(
            'POINT_AT_INFINITY',
            'Homogeneous point has zero projection denominator',
          );
        const projected = Array.from(result.subarray(0, rows - 1), (v) => v / w);
        finite(projected);
        return projected;
      }
      finite(result);
      return Array.from(result);
    });
  };
}
export const transformPoints = (a: Matrix, points: readonly Vector[], project = false) => {
  if (!points.length) return [];
  return preparePointTransform(a, points[0].length, project)(points);
};

/** Jacobi-preconditioned conjugate gradient for SPD quadratics: min 1/2 xᵀAx − bᵀx. */
export function conjugateGradient(
  a: Matrix,
  b: Vector,
  options: {
    initial?: Vector;
    relativeTolerance?: number;
    maxIterations?: number;
    trace?: boolean;
  } = {},
) {
  const { rows: n, cols, data } = dense(a),
    relativeTolerance = options.relativeTolerance ?? 1e-10,
    maxIterations = options.maxIterations ?? n * 2;
  if (n !== cols || b.length !== n || (options.initial && options.initial.length !== n))
    invalid('Conjugate gradient requires a square matrix and matching vectors');
  if (
    !(relativeTolerance > 0 && relativeTolerance < 1) ||
    !Number.isInteger(maxIterations) ||
    maxIterations < 1 ||
    maxIterations > 1024
  )
    invalid('Use tolerance (0,1) and 1–1024 iterations');
  finite(b);
  if (options.initial) finite(options.initial);
  for (let i = 0; i < n; i++) {
    if (data[i * n + i] <= 0)
      throw new VmotionError(
        'MATRIX_NOT_SPD',
        'Conjugate gradient requires a symmetric positive definite matrix',
      );
    for (let j = 0; j < i; j++)
      if (
        Math.abs(data[i * n + j] - data[j * n + i]) >
        tolerance * Math.max(Math.abs(data[i * n + j]), Math.abs(data[j * n + i]))
      )
        throw new VmotionError('MATRIX_NOT_SPD', 'Matrix must be symmetric');
  }
  const multiply = (v: Float64Array) => {
      const out = new Float64Array(n);
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) out[i] += data[i * n + j] * v[j];
      finite(out);
      return out;
    },
    x = options.initial ? Float64Array.from(options.initial) : new Float64Array(n),
    initialAx = multiply(x),
    r = Float64Array.from(b, (value, i) => value - initialAx[i]),
    z = Float64Array.from(r, (value, i) => value / data[i * n + i]),
    p = z.slice(),
    target = relativeTolerance * (vectorNorm(b) || 1),
    steps: Array<{ iteration: number; solution: number[]; residualNorm: number }> = [];
  let rho = vectorDot(r, z),
    residualNorm = vectorNorm(r),
    iteration = 0;
  if (options.trace) steps.push({ iteration, solution: Array.from(x), residualNorm });
  while (residualNorm > target && iteration < maxIterations) {
    const ap = multiply(p),
      curvature = vectorDot(p, ap);
    if (curvature <= 0)
      throw new VmotionError(
        'MATRIX_NOT_SPD',
        'Nonpositive curvature encountered during conjugate gradient',
      );
    const alpha = rho / curvature;
    for (let i = 0; i < n; i++) x[i] += alpha * p[i];
    // Recompute the actual residual instead of reporting only the recursive estimate.
    const ax = multiply(x);
    for (let i = 0; i < n; i++) {
      r[i] = b[i] - ax[i];
      z[i] = r[i] / data[i * n + i];
    }
    const next = vectorDot(r, z),
      beta = next / rho;
    for (let i = 0; i < n; i++) p[i] = z[i] + beta * p[i];
    rho = next;
    residualNorm = vectorNorm(r);
    iteration++;
    if (options.trace) steps.push({ iteration, solution: Array.from(x), residualNorm });
  }
  finite(x);
  return {
    solution: Array.from(x),
    converged: residualNorm <= target,
    iterations: iteration,
    residualNorm,
    target,
    steps,
    method: 'jacobi-preconditioned-conjugate-gradient' as const,
  };
}
