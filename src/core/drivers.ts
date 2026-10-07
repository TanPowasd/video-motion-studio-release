import { nodeSchema, VmotionError, type Node } from './model.js';
import { evaluateNode, setNumericPath } from './time.js';
import { evaluateExpression, compileExpression } from './expressions.js';
import { sampleCurvePath } from './curve-path.js';
import { shapePath } from './vector.js';
import {
  nodeMatrix,
  inverse,
  multiply,
  transform,
  identity,
  type Matrix,
  type Bounds,
} from './interaction.js';
export type DriverContext = {
  frame: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  budget?: { remaining: number };
};
export type DriverReport = {
  nodes: Node[];
  dependencies: Array<{ nodeId: string; property: string; inputs: string[] }>;
  values: Array<{
    nodeId: string;
    property: string;
    value: number;
    source: 'expression' | 'layout' | 'path';
  }>;
};
export const hasDrivers = (nodes: readonly Node[]) =>
  nodes.some(
    (node) => Object.keys(node.expressions ?? {}).length || node.layout || node.motionPath,
  );
export function evaluateDrivers(
  raw: Node[],
  ctx: DriverContext,
  animated: Node[] = raw.map((node) => evaluateNode(node, ctx.frame)),
): DriverReport {
  if (
    ![ctx.frame, ctx.fps, ctx.width, ctx.height, ctx.duration].every(Number.isFinite) ||
    ctx.frame < 0 ||
    ctx.frame > 1e9 ||
    ctx.fps <= 0 ||
    ctx.width <= 0 ||
    ctx.height <= 0 ||
    ctx.duration <= 0
  )
    throw new VmotionError(
      'DRIVER_CONTEXT',
      'Driver clocks and dimensions must be finite and valid',
    );
  const byId = new Map(animated.map((node) => [node.id, node]));
  if (byId.size !== raw.length)
    throw new VmotionError('DUPLICATE_ID', 'Driver graph requires unique layer IDs');
  const out = new Map(
      animated.map((node) => [node.id, hasDrivers([node]) ? structuredClone(node) : node]),
    ),
    done = new Map<string, unknown>(),
    stack: string[] = [],
    dependencies: DriverReport['dependencies'] = [],
    values: DriverReport['values'] = [],
    budget = ctx.budget ?? { remaining: 200000 },
    tick = () => {
      if (--budget.remaining < 0)
        throw new VmotionError(
          'DRIVER_BUDGET',
          'Property evaluation exceeded the operation budget',
        );
    },
    source = (id: string) => {
      const node = byId.get(id);
      if (!node)
        throw new VmotionError('DRIVER_REFERENCE', 'Referenced layer is missing', { nodeId: id });
      return node;
    };
  const resolveId = (owner: string, id: string) => {
    if (byId.has(id)) return id;
    const parts = owner.split('/');
    parts.pop();
    while (parts.length) {
      const candidate = parts.join('/') + '/' + id;
      if (byId.has(candidate)) return candidate;
      parts.pop();
    }
    throw new VmotionError('DRIVER_REFERENCE', 'Referenced stable layer ID is missing', {
      nodeId: owner,
      reference: id,
    });
  };
  const key = (id: string, property: string) => id + ':' + property;
  const world = (id: string, visited = new Set<string>()): Matrix => {
    if (visited.has(id) || visited.size >= 32)
      throw new VmotionError('DRIVER_CYCLE', 'Parent transform hierarchy contains a cycle', {
        nodeId: id,
      });
    visited.add(id);
    const node = source(id),
      changed = { ...node };
    for (const property of ['x', 'y', 'rotation', 'scaleX', 'scaleY', 'originX', 'originY'])
      (changed as any)[property] = read(id, property);
    changed.matrix = node.matrix.map((_, index) => read(id, 'matrix.' + index)) as Matrix;
    return node.parentId
      ? multiply(world(node.parentId, visited), nodeMatrix(changed))
      : nodeMatrix(changed);
  };
  const parentWorld = (id: string) =>
    source(id).parentId ? world(source(id).parentId!) : identity;
  const referenceBounds = (id: string): Bounds => {
    const node = source(id),
      layout = node.layout!;
    if (layout.reference === 'parent')
      return {
        x: 0,
        y: 0,
        width: node.parentId ? (read(node.parentId, 'width') as number) : ctx.width,
        height: node.parentId ? (read(node.parentId, 'height') as number) : ctx.height,
      };
    const inv = inverse(parentWorld(id));
    if (!inv)
      throw new VmotionError('DRIVER_TRANSFORM', 'Cannot solve layout inside a singular parent', {
        nodeId: id,
      });
    let matrix: Matrix = inv,
      width = ctx.width,
      height = ctx.height;
    if (typeof layout.reference === 'object') {
      const target = resolveId(id, layout.reference.nodeId);
      matrix = multiply(inv, world(target));
      width = read(target, 'width') as number;
      height = read(target, 'height') as number;
    }
    const points = [
        { x: 0, y: 0 },
        { x: width, y: 0 },
        { x: width, y: height },
        { x: 0, y: height },
      ].map((point) => transform(matrix, point)),
      x = Math.min(...points.map((p) => p.x)),
      y = Math.min(...points.map((p) => p.y));
    return {
      x,
      y,
      width: Math.max(...points.map((p) => p.x)) - x,
      height: Math.max(...points.map((p) => p.y)) - y,
    };
  };
  const poseCache = new Map<string, { x: number; y: number; rotation: number }>();
  const pathPose = (id: string) => {
    if (poseCache.has(id)) return poseCache.get(id)!;
    const node = source(id),
      path = node.motionPath!,
      progress = read(id, 'motionPath.progress') as number;
    let svg = path.path!,
      matrix: Matrix = identity;
    if (path.nodeId) {
      const target = resolveId(id, path.nodeId),
        other = source(target);
      if (!['path', 'rect', 'ellipse'].includes(other.type))
        throw new VmotionError('MOTION_PATH_TYPE', 'Path reference must be a vector shape', {
          nodeId: target,
        });
      const evaluated = {
        ...other,
        width: read(target, 'width') as number,
        height: read(target, 'height') as number,
        radius: read(target, 'radius') as number,
        reveal: read(target, 'reveal') as number,
      };
      if (other.pathTrim)
        evaluated.pathTrim = {
          start: read(target, 'pathTrim.start') as number,
          end: read(target, 'pathTrim.end') as number,
          offset: read(target, 'pathTrim.offset') as number,
        };
      svg = path.useRendered
        ? shapePath(evaluated).toSVGString()
        : other.type === 'path'
          ? other.path
          : shapePath({
              ...evaluated,
              reveal: 1,
              pathTrim: { start: 0, end: 1, offset: 0 },
            }).toSVGString();
      const inv = inverse(parentWorld(id));
      if (!inv)
        throw new VmotionError(
          'DRIVER_TRANSFORM',
          'Cannot place a motion path through a singular parent',
          { nodeId: id },
        );
      matrix = multiply(inv, world(target));
    }
    const sample = sampleCurvePath(svg, progress, path.repeat),
      position = transform(matrix, sample),
      vx = matrix[0] * sample.tangentX + matrix[2] * sample.tangentY,
      vy = matrix[1] * sample.tangentX + matrix[3] * sample.tangentY,
      offsetX = read(id, 'motionPath.offsetX') as number,
      offsetY = read(id, 'motionPath.offsetY') as number,
      angle = path.autoRotate
        ? (Math.atan2(vy, vx) * 180) / Math.PI + (read(id, 'motionPath.rotationOffset') as number)
        : (read(id, 'rotation') as number),
      modified = { ...node, x: 0, y: 0, rotation: angle };
    for (const property of ['scaleX', 'scaleY', 'originX', 'originY'])
      (modified as any)[property] = read(id, property);
    modified.matrix = node.matrix.map((_, index) => read(id, 'matrix.' + index)) as Matrix;
    const anchor =
        path.anchor === 'center'
          ? { x: (read(id, 'width') as number) / 2, y: (read(id, 'height') as number) / 2 }
          : path.anchor === 'origin'
            ? { x: modified.originX, y: modified.originY }
            : { x: 0, y: 0 },
      placed = transform(nodeMatrix(modified), anchor),
      result = {
        x: position.x + offsetX - placed.x,
        y: position.y + offsetY - placed.y,
        rotation: angle,
      };
    poseCache.set(id, result);
    return result;
  };
  const layoutValue = (id: string, property: string): number | undefined => {
    const node = source(id),
      layout = node.layout;
    if (!layout || !['x', 'y', 'width', 'height'].includes(property)) return;
    const b = referenceBounds(id),
      insets = layout.insets;
    if (property === 'width' || property === 'height') {
      const horizontal = property === 'width',
        spec = layout[property],
        start = horizontal ? insets?.left : insets?.top,
        end = horizontal ? insets?.right : insets?.bottom,
        dimension = horizontal ? b.width : b.height;
      if (start !== undefined && end !== undefined) {
        if (spec)
          throw new VmotionError(
            'LAYOUT_CONFLICT',
            'Insets and size both drive the same dimension',
            { nodeId: id, property },
          );
        return Math.max(
          0,
          dimension -
            (read(id, horizontal ? 'layout.insets.left' : 'layout.insets.top') as number) -
            (read(id, horizontal ? 'layout.insets.right' : 'layout.insets.bottom') as number),
        );
      }
      if (spec) {
        const value = read(id, `layout.${property}.value`) as number,
          min = read(id, `layout.${property}.min`) as number,
          max = spec.max === undefined ? Infinity : (read(id, `layout.${property}.max`) as number);
        if (min < 0 || max < min)
          throw new VmotionError('LAYOUT_RANGE', 'Evaluated layout size limits are invalid', {
            nodeId: id,
            property,
            min,
            max,
          });
        return Math.max(min, Math.min(max, (spec.unit === 'fraction' ? dimension : 1) * value));
      }
      if (layout.aspectRatio) {
        const other = property === 'width' ? 'height' : 'width';
        if (
          layout[other] ||
          (other === 'width'
            ? insets?.left !== undefined && insets?.right !== undefined
            : insets?.top !== undefined && insets?.bottom !== undefined)
        )
          return (
            (read(id, other) as number) *
            (property === 'width' ? layout.aspectRatio : 1 / layout.aspectRatio)
          );
      }
      return;
    }
    const horizontal = property === 'x',
      spec = layout[property as 'x' | 'y'],
      start = horizontal ? insets?.left : insets?.top,
      end = horizontal ? insets?.right : insets?.bottom,
      base = horizontal ? b.x : b.y,
      dimension = horizontal ? b.width : b.height,
      size = read(id, horizontal ? 'width' : 'height') as number;
    if ((start !== undefined || end !== undefined) && spec)
      throw new VmotionError('LAYOUT_CONFLICT', 'Insets and anchor both drive the same position', {
        nodeId: id,
        property,
      });
    if (start !== undefined)
      return base + (read(id, horizontal ? 'layout.insets.left' : 'layout.insets.top') as number);
    if (end !== undefined)
      return (
        base +
        dimension -
        size -
        (read(id, horizontal ? 'layout.insets.right' : 'layout.insets.bottom') as number)
      );
    if (spec) {
      const factor = { start: 0, center: 0.5, end: 1 };
      return (
        base +
        dimension * factor[spec.at] -
        size * factor[spec.self] +
        (read(id, `layout.${property}.offset`) as number)
      );
    }
  };
  function read(id: string, property: string, mode: 'final' | 'base' | 'scene' = 'final'): unknown {
    tick();
    if (mode === 'scene') {
      const scene = {
        width: ctx.width,
        height: ctx.height,
        duration: ctx.duration,
        fps: ctx.fps,
        frame: ctx.frame,
      };
      if (!Object.hasOwn(scene, property))
        throw new VmotionError('EXPRESSION_PROPERTY', 'Scene property is not available', {
          property,
        });
      return (scene as any)[property];
    }
    const node = source(id);
    if (mode === 'base') {
      let value: any = node;
      for (const part of property.split('.')) {
        if (
          ['__proto__', 'prototype', 'constructor'].includes(part) ||
          !value ||
          typeof value !== 'object' ||
          !Object.hasOwn(value, part)
        )
          throw new VmotionError('EXPRESSION_PROPERTY', 'Base property is not present', {
            nodeId: id,
            property,
          });
        value = value[part];
      }
      return value;
    }
    const k = key(id, property);
    if (stack.length) {
      const current = stack.at(-1)!;
      const report = dependencies.find((report) => key(report.nodeId, report.property) === current);
      if (report && !report.inputs.includes(k)) report.inputs.push(k);
    }
    if (done.has(k)) return done.get(k);
    if (stack.includes(k))
      throw new VmotionError('DRIVER_CYCLE', 'Property dependency cycle', {
        cycle: [...stack.slice(stack.indexOf(k)), k],
      });
    if (stack.length >= 128)
      throw new VmotionError('DRIVER_BUDGET', 'Property dependency depth exceeds 128');
    stack.push(k);
    let value: unknown, driver: DriverReport['values'][number]['source'] | undefined;
    try {
      const expression = node.expressions?.[property],
        layout = layoutValue;
      if (expression) {
        if (property.startsWith('animationLayers.'))
          throw new VmotionError(
            'DRIVER_LAYER_CONTROL',
            'Layer controls use ordinary keys or TypeScript before mixing',
            { nodeId: id, property },
          );
        driver = 'expression';
        dependencies.push({ nodeId: id, property, inputs: [] });
        value = evaluateExpression(expression, {
          nodeId: id,
          frame: ctx.frame,
          fps: ctx.fps,
          width: ctx.width,
          height: ctx.height,
          duration: ctx.duration,
          property,
          parentId: node.parentId,
          read: (target, path, source) => read(target, path, source),
          resolve: (target) => resolveId(id, target),
          tick,
        });
      } else if (
        node.motionPath &&
        ['x', 'y', 'rotation'].includes(property) &&
        (property !== 'rotation' || node.motionPath.autoRotate)
      ) {
        if ((property === 'x' || property === 'y') && layoutValue(id, property) !== undefined)
          throw new VmotionError('DRIVER_CONFLICT', 'Layout and motion path both drive position', {
            nodeId: id,
            property,
          });
        driver = 'path';
        dependencies.push({ nodeId: id, property, inputs: [] });
        value = pathPose(id)[property as 'x' | 'y' | 'rotation'];
      } else {
        if (node.layout && ['x', 'y', 'width', 'height'].includes(property)) {
          dependencies.push({ nodeId: id, property, inputs: [] });
          value = layout(id, property);
          if (value !== undefined) driver = 'layout';
        }
        if (value === undefined) value = read(id, property, 'base');
      }
      if (driver) {
        if (typeof value !== 'number' || !Number.isFinite(value))
          throw new VmotionError('DRIVER_VALUE', 'Driver must produce a finite numeric property', {
            nodeId: id,
            property,
          });
        if (property === 'opacity' || property === 'reveal')
          value = Math.max(0, Math.min(1, value));
        setNumericPath(out.get(id)!, property, value as number);
        values.push({ nodeId: id, property, value: value as number, source: driver });
      }
      done.set(k, value);
      return value;
    } catch (error) {
      if (error instanceof VmotionError)
        throw new VmotionError(error.code, error.message, {
          nodeId: id,
          property,
          ...(typeof error.details === 'object' ? error.details : {}),
        });
      throw error;
    } finally {
      stack.pop();
    }
  }
  for (const node of animated) {
    for (const property of Object.keys(node.expressions ?? {})) read(node.id, property);
    if (node.layout) for (const property of ['width', 'height', 'x', 'y']) read(node.id, property);
    if (node.motionPath) {
      read(node.id, 'x');
      read(node.id, 'y');
      if (node.motionPath.autoRotate) read(node.id, 'rotation');
    }
  }
  const result = animated.map((node) => out.get(node.id)!);
  for (const node of result)
    if (node.expressions || node.layout || node.motionPath) nodeSchema.parse(node);
  return { nodes: result, dependencies, values };
}
export function validateDriverSyntax(node: Node) {
  for (const [property, source] of Object.entries(node.expressions ?? {})) {
    if (property.startsWith('animationLayers.'))
      throw new VmotionError(
        'DRIVER_LAYER_CONTROL',
        'Layer controls use ordinary keys or TypeScript before the layer stack, not post-stack expressions',
        { nodeId: node.id, property },
      );
    compileExpression(source);
  }
  if (node.motionPath?.path)
    sampleCurvePath(node.motionPath.path, node.motionPath.progress, node.motionPath.repeat);
}
