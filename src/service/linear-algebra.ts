import { z } from 'zod';
import {
  matrixMultiply,
  matrixSolve,
  matrixInverse,
  matrixDeterminant,
  matrixTranspose,
  leastSquares,
  transformPoints,
  conjugateGradient,
  matrixVector,
  vectorNorm,
} from '../sdk/linear-algebra.js';
const row = z.array(z.number().finite()).min(1).max(128),
  matrix = z.array(row).min(1).max(128);
export const linearAlgebraSchema = z.discriminatedUnion('operation', [
  z.object({ operation: z.literal('multiply'), a: matrix, b: matrix }).strict(),
  z.object({ operation: z.literal('solve'), a: matrix, b: row }).strict(),
  z.object({ operation: z.literal('inverse'), a: matrix }).strict(),
  z.object({ operation: z.literal('determinant'), a: matrix }).strict(),
  z.object({ operation: z.literal('transpose'), a: matrix }).strict(),
  z
    .object({
      operation: z.literal('leastSquares'),
      a: matrix,
      b: row,
      relativeTolerance: z.number().positive().max(0.1).optional(),
    })
    .strict(),
  z
    .object({
      operation: z.literal('transformPoints'),
      a: matrix,
      points: z.array(row).min(1).max(10000),
      project: z.boolean().default(false),
    })
    .strict(),
  z
    .object({
      operation: z.literal('conjugateGradient'),
      a: matrix,
      b: row,
      initial: row.optional(),
      relativeTolerance: z.number().positive().max(0.1).optional(),
      maxIterations: z.number().int().min(1).max(512).optional(),
      trace: z.boolean().default(false),
    })
    .strict(),
]);
export function linearAlgebra(raw: unknown) {
  const request = linearAlgebraSchema.parse(raw),
    started = performance.now();
  let result: unknown;
  switch (request.operation) {
    case 'multiply':
      result = { matrix: matrixMultiply(request.a, request.b) };
      break;
    case 'solve': {
      const solution = matrixSolve(request.a, request.b),
        residual = matrixVector(request.a, solution).map((v, i) => v - request.b[i]);
      result = { solution, residualNorm: vectorNorm(residual), method: 'scaled-partial-pivot-lu' };
      break;
    }
    case 'inverse':
      result = { matrix: matrixInverse(request.a) };
      break;
    case 'transpose':
      result = { matrix: matrixTranspose(request.a) };
      break;
    case 'determinant':
      result = { determinant: matrixDeterminant(request.a) };
      break;
    case 'leastSquares':
      result = leastSquares(request.a, request.b, request.relativeTolerance);
      break;
    case 'transformPoints':
      result = { points: transformPoints(request.a, request.points, request.project) };
      break;
    case 'conjugateGradient':
      result = conjugateGradient(request.a, request.b, request);
      break;
  }
  return {
    operation: request.operation,
    convention: 'row-major; column vectors; composition A*B applies B first',
    result,
    computeMs: performance.now() - started,
  };
}
