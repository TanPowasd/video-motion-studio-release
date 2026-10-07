import { Path2D, PathOp, FillType, StrokeCap, StrokeJoin } from '@napi-rs/canvas';
import { VmotionError, type Node } from './model.js';
import { GeometryCache } from './geometry-cache.js';
import { shapeOperatorSchema, type ShapeOperatorInput } from './shape-operator-schema.js';
import {
  pathGeometrySchema,
  pathTrimSchema,
  outlineOptionsSchema,
  pathOperationSchema,
  type PathTrim,
  type PathOperation,
  type OutlineOptions,
  type PathGeometryRequest,
} from './vector-schema.js';

const operations: Record<PathOperation, PathOp> = {
  union: PathOp.Union,
  difference: PathOp.Difference,
  intersect: PathOp.Intersect,
  xor: PathOp.Xor,
  reverseDifference: PathOp.ReverseDifference,
};
const caps = { butt: StrokeCap.Butt, round: StrokeCap.Round, square: StrokeCap.Square };
const joins = { miter: StrokeJoin.Miter, round: StrokeJoin.Round, bevel: StrokeJoin.Bevel };
const clamp = (value: number) => Math.max(0, Math.min(1, value));
const wrap = (value: number) => ((value % 1) + 1) % 1;
export function parsePath(svg: string, fillRule: Node['fillRule'] = 'nonzero') {
  try {
    const p = new Path2D(svg);
    p.setFillType(fillRule === 'evenodd' ? FillType.EvenOdd : FillType.Winding);
    if (!p.computeTightBounds().every(Number.isFinite)) throw new Error('Nonfinite coordinates');
    return p;
  } catch (error) {
    throw new VmotionError('VECTOR_PATH', `Invalid SVG path: ${(error as Error).message}`);
  }
}
// Native PathKit methods mutate their receiver. Never mutate a caller-owned path.
export function trimNativePath(source: Path2D, trim: PathTrim) {
  const start = clamp(trim.start),
    end = clamp(trim.end),
    delta = end - start;
  const path = new Path2D(source);
  if (Math.abs(delta) >= 1) return path;
  if (Math.abs(delta) < 1e-12) return new Path2D();
  const length = delta < 0 ? 1 + delta : delta,
    from = wrap(start + trim.offset),
    to = from + length;
  return to <= 1 + 1e-12 ? path.trim(from, Math.min(1, to)) : path.trim(to - 1, from, true);
}
export const sharedShapeCache = new GeometryCache<Path2D>();
export function applyShapeOperators(source: Path2D, operators: ShapeOperatorInput[]) {
  let shape = new Path2D(source);
  for (const input of operators) {
    const op = shapeOperatorSchema.parse(input);
    if (!op.enabled) continue;
    if (op.type === 'trim') shape = trimNativePath(shape, op);
    else if (op.type === 'round') shape.round(op.radius);
    else if (op.type === 'outline')
      shape = outlineNativePath(shape, {
        width: op.width,
        cap: op.cap,
        join: op.join,
        miterLimit: op.miterLimit,
      });
    else if (op.type === 'dash') shape.dash(op.on, op.off, op.phase);
    else if (op.type === 'transform') {
      const [a, b, c, d, e, f] = op.matrix;
      shape.transform({ a, b, c, d, e, f });
    } else if (op.type === 'boolean') {
      for (const item of op.paths) {
        const operand = parsePath(item.path, item.fillRule);
        if (item.transform) {
          const [a, b, c, d, e, f] = item.transform;
          operand.transform({ a, b, c, d, e, f });
        }
        shape.op(operand, operations[op.operation]);
      }
    } else if (op.amount) {
      const contours = shape.toSVGString().match(/M[^M]*/gi) ?? [];
      if (contours.some((contour) => !/Z\s*$/i.test(contour)))
        throw new VmotionError(
          'VECTOR_OFFSET_OPEN',
          'Offset requires closed contours; outline open paths first',
        );
      shape = new Path2D(shape).simplify().asWinding();
      const boundary = outlineNativePath(shape, {
        width: Math.abs(op.amount) * 2,
        join: op.join,
        miterLimit: op.miterLimit,
      });
      shape.op(boundary, op.amount > 0 ? PathOp.Union : PathOp.Difference);
    }
    if (!shape.computeTightBounds().every(Number.isFinite))
      throw new VmotionError('VECTOR_OPERATOR', `Operator ${op.id} produced nonfinite geometry`);
  }
  return shape;
}
export function shapePath(n: Node, cache = sharedShapeCache): Path2D {
  const key = cache.budgetBytes
      ? JSON.stringify([
          n.type,
          n.path,
          n.width,
          n.height,
          n.radius,
          n.fillRule,
          n.shapeOperators,
          n.reveal,
          n.pathTrim,
        ])
      : '',
    hit = key ? cache.get(key) : undefined;
  if (hit) return new Path2D(hit);
  let shape: Path2D;
  if (n.type === 'path') shape = parsePath(n.path, n.fillRule);
  else {
    shape = new Path2D();
    if (n.type === 'rect')
      shape.roundRect(0, 0, n.width, n.height, Math.min(n.radius, n.width / 2, n.height / 2));
    else if (n.type === 'ellipse' && n.width > 0 && n.height > 0)
      shape.ellipse(n.width / 2, n.height / 2, n.width / 2, n.height / 2, 0, 0, Math.PI * 2);
    else if (n.type !== 'ellipse')
      throw new VmotionError('VECTOR_TYPE', 'Expected a rect, ellipse or path');
    shape.setFillType(n.fillRule === 'evenodd' ? FillType.EvenOdd : FillType.Winding);
  }
  shape = applyShapeOperators(shape, n.shapeOperators ?? []);
  // Primitive → ordered operators → legacy path.reveal → layer trim.
  if (n.type === 'path' && n.reveal < 1) shape = shape.trim(0, clamp(n.reveal));
  if (n.pathTrim) shape = trimNativePath(shape, n.pathTrim);
  if (cache.budgetBytes) cache.put(key, new Path2D(shape), shape.toSVGString().length * 2);
  return shape;
}
export function outlineNativePath(source: Path2D, options: OutlineOptions = {}) {
  const stroke = outlineOptionsSchema.parse(options);
  return new Path2D(source).stroke({
    width: stroke.width,
    cap: caps[stroke.cap],
    join: joins[stroke.join],
    miterLimit: stroke.miterLimit,
  });
}
export function shapeBounds(n: Node, shape = shapePath(n)) {
  const shapes: Path2D[] = [];
  if (n.fill !== 'transparent' || n.gradient) shapes.push(shape);
  if (n.strokeWidth > 0 && n.stroke)
    shapes.push(
      outlineNativePath(shape, {
        width: n.strokeWidth,
        cap: n.strokeCap,
        join: n.strokeJoin,
        miterLimit: n.strokeMiterLimit,
      }),
    );
  // An entirely trimmed or unpainted shape has no selection rectangle.
  const boxes = shapes.filter((p) => p.toSVGString()).map((p) => p.computeTightBounds());
  if (!boxes.length) return { x: 0, y: 0, width: 0, height: 0 };
  const left = Math.min(...boxes.map((b) => b[0])),
    top = Math.min(...boxes.map((b) => b[1])),
    right = Math.max(...boxes.map((b) => b[2])),
    bottom = Math.max(...boxes.map((b) => b[3]));
  return { x: left, y: top, width: right - left, height: bottom - top };
}
function serializePath(path: Path2D) {
  // SVG doesn't carry PathKit's fill type; normalize boolean/outline output winding.
  const result = new Path2D(path).asWinding(),
    svg = result.toSVGString(),
    [left, top, right, bottom] = result.computeTightBounds();
  if (![left, top, right, bottom].every(Number.isFinite))
    throw new VmotionError('VECTOR_PATH', 'Operation produced nonfinite geometry');
  return {
    path: svg,
    fillRule: 'nonzero' as const,
    empty: !svg,
    bounds: { x: left, y: top, width: right - left, height: bottom - top },
  };
}
export function pathGeometry(input: PathGeometryRequest) {
  const request = pathGeometrySchema.parse(input),
    paths = request.paths.map((item) => {
      const path = parsePath(item.path, item.fillRule);
      if (item.transform) {
        const [a, b, c, d, e, f] = item.transform;
        path.transform({ a, b, c, d, e, f });
      }
      return path;
    });
  const binary = request.operation in operations;
  if (binary ? paths.length < 2 : paths.length !== 1)
    throw new VmotionError(
      'VECTOR_OPERANDS',
      binary ? 'Boolean operations require 2–32 paths' : 'This operation requires one path',
    );
  let result = new Path2D(paths[0]);
  if (binary)
    for (const path of paths.slice(1))
      result.op(path, operations[request.operation as PathOperation]);
  else if (request.operation === 'simplify') result.simplify();
  else if (request.operation === 'round') result.round(request.radius);
  else if (request.operation === 'outline') result = outlineNativePath(result, request.stroke);
  else if (request.operation === 'trim') result = trimNativePath(result, request.trim);
  return {
    ...serializePath(result),
    operation: request.operation,
    trimMode: 'combined-contour-length' as const,
  };
}
export const booleanPath = (
  paths: string[],
  operation: PathOperation,
  fillRule: Node['fillRule'] = 'nonzero',
) =>
  pathGeometry({
    paths: paths.map((path) => ({ path, fillRule })),
    operation: pathOperationSchema.parse(operation),
  }).path;
export const trimPath = (path: string, trim: Partial<PathTrim>) =>
  trimNativePath(parsePath(path), pathTrimSchema.parse(trim)).toSVGString();
export const outlinePath = (path: string, stroke: OutlineOptions = {}) =>
  outlineNativePath(parsePath(path), stroke).toSVGString();
export const simplifyPath = (path: string) =>
  pathGeometry({ paths: [{ path }], operation: 'simplify' }).path;
export const roundPath = (path: string, radius: number) =>
  pathGeometry({ paths: [{ path }], operation: 'round', radius }).path;
