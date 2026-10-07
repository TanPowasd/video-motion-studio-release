import { parseExpression, type ExpressionAST as AST } from './expression-parser.js';
import { VmotionError } from './model.js';
import { random } from './time.js';
type Ref = { reference: true; nodeId: string; path: string; source: 'final' | 'base' | 'scene' };
export type ExpressionContext = {
  nodeId: string;
  frame: number;
  fps: number;
  width: number;
  height: number;
  duration: number;
  property: string;
  parentId?: string;
  read: (id: string, path: string, source: 'final' | 'base' | 'scene') => unknown;
  resolve: (id: string) => string;
  tick: () => void;
};
const forbidden = new Set(['__proto__', 'prototype', 'constructor', 'length']),
  cache = new Map<string, { ast: AST; references: string[]; symbols: string[] }>(),
  symbols = new Set([
    'value',
    'frame',
    'fps',
    'time',
    'seconds',
    'width',
    'height',
    'duration',
    'self',
    'base',
    'parent',
    'scene',
    'Math',
  ]),
  constants: Record<string, number> = {
    PI: Math.PI,
    E: Math.E,
    LN2: Math.LN2,
    LN10: Math.LN10,
    SQRT2: Math.SQRT2,
    SQRT1_2: Math.SQRT1_2,
  },
  functions: Record<string, (...values: number[]) => number> = {
    sin: Math.sin,
    cos: Math.cos,
    tan: Math.tan,
    asin: Math.asin,
    acos: Math.acos,
    atan: Math.atan,
    atan2: Math.atan2,
    abs: Math.abs,
    min: Math.min,
    max: Math.max,
    floor: Math.floor,
    ceil: Math.ceil,
    round: Math.round,
    trunc: Math.trunc,
    sign: Math.sign,
    pow: Math.pow,
    sqrt: Math.sqrt,
    cbrt: Math.cbrt,
    exp: Math.exp,
    expm1: Math.expm1,
    log: Math.log,
    log2: Math.log2,
    log10: Math.log10,
    hypot: Math.hypot,
    clamp: (x, a = 0, b = 1) => Math.max(a, Math.min(b, x)),
    lerp: (a, b, t) => a + (b - a) * t,
    rad: (degrees) => (degrees * Math.PI) / 180,
    deg: (radians) => (radians * 180) / Math.PI,
    smoothstep: (a, b, x) => {
      const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
      return t * t * (3 - 2 * t);
    },
    random: (seed) => random(Math.floor(seed))(),
  };
export const expressionReference = {
  symbols: [...symbols].filter((symbol) => symbol !== 'Math'),
  functions: Object.keys(functions),
  constants: Object.keys(constants).map((name) => 'Math.' + name),
  syntax:
    'Numeric arithmetic/comparisons/logical/conditional expressions; self/base/parent/scene properties, layer("stable ID") references, literal array indexes. random(seed) is deterministic; arbitrary JS, assignment, loops, async and Math.random are not executed.',
};
export function compileExpression(source: string) {
  if (cache.has(source)) {
    const value = cache.get(source)!;
    cache.delete(source);
    cache.set(source, value);
    return value;
  }
  if (!source || source.length > 4000)
    throw new VmotionError('EXPRESSION_SYNTAX', 'Expression must have 1–4000 characters');
  const value = parseExpression(source, symbols, new Set(Object.keys(functions)));
  if (cache.size >= 128) cache.delete(cache.keys().next().value!);
  cache.set(source, value);
  return value;
}
export function evaluateExpression(source: string, ctx: ExpressionContext) {
  const compiled = compileExpression(source),
    ref = (nodeId: string, source: Ref['source']): Ref => ({
      reference: true,
      nodeId,
      path: '',
      source,
    });
  const material = (value: any): any =>
      value?.reference === true ? ctx.read(value.nodeId, value.path, value.source) : value,
    number = (value: any) => {
      const result = material(value);
      if (typeof result !== 'number' || !Number.isFinite(result))
        throw new VmotionError('EXPRESSION_VALUE', 'Expression needs finite numeric values');
      return result;
    };
  const evalAST = (ast: AST): any => {
    ctx.tick();
    if (ast.type === 'literal') return ast.value;
    if (ast.type === 'symbol') {
      if (ast.name === 'self' || ast.name === 'base')
        return ref(ctx.nodeId, ast.name === 'base' ? 'base' : 'final');
      if (ast.name === 'parent')
        return ctx.parentId ? ref(ctx.parentId, 'final') : ref('', 'scene');
      if (ast.name === 'scene') return ref('', 'scene');
      if (ast.name === 'Math') return { math: true };
      if (ast.name === 'value') return ctx.read(ctx.nodeId, ctx.property, 'base');
      if (ast.name === 'time' || ast.name === 'seconds') return ctx.frame / ctx.fps;
      return ctx[ast.name as 'frame' | 'fps' | 'width' | 'height' | 'duration'];
    }
    if (ast.type === 'get') {
      const object = evalAST(ast.object);
      if (object?.reference)
        return { ...object, path: object.path ? object.path + '.' + ast.key : ast.key };
      if (object?.math && Object.hasOwn(constants, ast.key)) return constants[ast.key];
      const value = material(object);
      if (!value || typeof value !== 'object' || !Object.hasOwn(value, ast.key))
        throw new VmotionError('EXPRESSION_PROPERTY', 'Property is not present', {
          property: ast.key,
        });
      return value[ast.key];
    }
    if (ast.type === 'call') {
      if (ast.name === 'layer')
        return ref(
          ctx.resolve((ast.args[0] as Extract<AST, { type: 'literal' }>).value as string),
          'final',
        );
      ctx.tick();
      const result = functions[ast.name](...ast.args.map((arg) => number(evalAST(arg))));
      if (!Number.isFinite(result))
        throw new VmotionError('EXPRESSION_VALUE', 'Function produced a nonfinite result', {
          function: ast.name,
        });
      return result;
    }
    if (ast.type === 'conditional') return evalAST(material(evalAST(ast.test)) ? ast.yes : ast.no);
    if (ast.type === 'unary') {
      const value = evalAST(ast.value);
      return ast.op === '!' ? !material(value) : ast.op === '-' ? -number(value) : number(value);
    }
    const a = evalAST(ast.a);
    if (ast.op === '&&') return material(a) && material(evalAST(ast.b));
    if (ast.op === '||') return material(a) || material(evalAST(ast.b));
    const b = evalAST(ast.b);
    if (ast.op === '===') return material(a) === material(b);
    if (ast.op === '!==') return material(a) !== material(b);
    const x = number(a),
      y = number(b);
    switch (ast.op) {
      case '+':
        return x + y;
      case '-':
        return x - y;
      case '*':
        return x * y;
      case '/':
        return x / y;
      case '%':
        return x % y;
      case '**':
        return x ** y;
      case '<':
        return x < y;
      case '>':
        return x > y;
      case '<=':
        return x <= y;
      case '>=':
        return x >= y;
      default:
        throw new VmotionError('EXPRESSION_SYNTAX', 'Unsupported operator');
    }
  };
  const result = number(evalAST(compiled.ast));
  return result;
}
