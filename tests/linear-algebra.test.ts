import { it, expect } from 'vitest';
import {
  matrixMultiply,
  matrixIdentity,
  matrixLU,
  matrixSolve,
  matrixInverse,
  matrixDeterminant,
  leastSquares,
  preparePointTransform,
  transformPoints,
  conjugateGradient,
} from '../src/sdk/linear-algebra.js';
import { linearAlgebra } from '../src/service/linear-algebra.js';
const close = (actual: readonly number[], expected: readonly number[], digits = 9) => {
  expect(actual.length).toBe(expected.length);
  actual.forEach((v, i) => expect(v).toBeCloseTo(expected[i], digits));
};
it('solves with pivoting, preserves differently scaled equations and reuses an immutable factor', () => {
  const a = [
      [0, 2, 1],
      [3, -1, 2],
      [1, 1, 1],
    ],
    original = structuredClone(a),
    factor = matrixLU(a);
  a[0][0] = 100;
  close(factor.solve([7, 7, 6]), [1, 2, 3]);
  close(factor.solve([3, 1, 2]), [0, 1, 1]);
  close(
    matrixSolve(
      [
        [1e20, 0],
        [0, 1e-20],
      ],
      [2e20, -3e-20],
    ),
    [2, -3],
  );
  const product = matrixMultiply(original, matrixInverse(original));
  product.forEach((row, i) => close(row, matrixIdentity(3)[i]));
  expect(
    matrixDeterminant([
      [0, 2],
      [3, 4],
    ]),
  ).toBeCloseTo(-6);
  expect(
    matrixDeterminant([
      [1, 2],
      [2, 4],
    ]),
  ).toBe(0);
  expect(() =>
    matrixSolve(
      [
        [1, 2],
        [2, 4],
      ],
      [1, 2],
    ),
  ).toThrow('rank deficient');
});
it('fits a line with pivoted QR and returns the actual residual, without forming normal equations', () => {
  const a = [
      [1, 0],
      [1, 1],
      [1, 2],
      [1, 3],
    ],
    result = leastSquares(a, [1, 2, 2, 4]);
  close(result.solution, [0.9, 0.9]);
  close(result.residual, [-0.1, -0.2, 0.7, -0.4]);
  expect(result.residualNorm).toBeCloseTo(Math.sqrt(0.7));
  const near = [
    [1, 1],
    [1, 1 + 1e-7],
    [1, 1 - 1e-7],
  ];
  close(leastSquares(near, [3, 3 + 2e-7, 3 - 2e-7]).solution, [1, 2], 6);
  expect(() =>
    leastSquares(
      [
        [1, 2],
        [2, 4],
        [3, 6],
      ],
      [1, 2, 3],
    ),
  ).toThrow('rank deficient');
});
it('prepares batched affine and perspective transforms with explicit coordinate conventions', () => {
  const a = [
      [2, 0, 10],
      [0, -1, 20],
    ],
    apply = preparePointTransform(a, 2);
  a[0][0] = 9;
  expect(
    apply([
      [1, 3],
      [-2, 7],
    ]),
  ).toEqual([
    [12, 17],
    [6, 13],
  ]);
  expect(
    transformPoints(
      [
        [2, 0, 0],
        [0, 2, 0],
        [0, 0, 2],
      ],
      [[4, 6]],
      true,
    ),
  ).toEqual([[4, 6]]);
  expect(() =>
    transformPoints(
      [
        [1, 0, 0],
        [0, 1, 0],
        [0, 0, 0],
      ],
      [[4, 6]],
      true,
    ),
  ).toThrow('denominator');
});
it('optimizes an SPD quadratic with numerical convergence evidence and reproducible steps', () => {
  const a = [
      [4, 1],
      [1, 3],
    ],
    b = [1, 2],
    result = conjugateGradient(a, b, { trace: true });
  expect(result.converged).toBe(true);
  close(result.solution, [1 / 11, 7 / 11]);
  expect(result.steps[0].solution).toEqual([0, 0]);
  expect(result.steps.at(-1)?.solution).toEqual(result.solution);
  expect(conjugateGradient(a, b, { trace: true })).toEqual(result);
  expect(conjugateGradient(a, b, { maxIterations: 1 }).converged).toBe(false);
  expect(() =>
    conjugateGradient(
      [
        [1, 2],
        [0, 1],
      ],
      b,
    ),
  ).toThrow('symmetric');
});
it('rejects malformed, nonfinite and incompatible calculations instead of emitting NaN JSON', () => {
  expect(() => matrixMultiply([[1, 2], [3]], [[1], [1]])).toThrow('rectangular');
  expect(() => matrixMultiply([[1, 2]], [[1, 2]])).toThrow('dimensions');
  expect(() => matrixInverse([[Infinity]])).toThrow('finite');
  const result: any = linearAlgebra({
    operation: 'solve',
    a: [
      [2, 1],
      [1, 3],
    ],
    b: [5, 5],
  });
  close(result.result.solution, [2, 1]);
  expect(result.result.residualNorm).toBeLessThan(1e-12);
});
