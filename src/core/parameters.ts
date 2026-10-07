type Common = { label?: string; description?: string };
export type NumberParameter = Common & {
  type: 'number';
  default?: number;
  min?: number;
  max?: number;
  integer?: boolean;
  step?: number;
};
export type Parameter =
  | NumberParameter
  | (Common & { type: 'string'; default?: string; minLength?: number; maxLength?: number })
  | (Common & { type: 'color'; default?: string })
  | (Common & { type: 'boolean'; default?: boolean })
  | (Common & { type: 'enum'; options: readonly (string | number)[]; default?: string | number })
  | (Common & {
      type: 'vec2';
      default?: Partial<{ x: number; y: number }>;
      min?: number;
      max?: number;
      step?: number;
    })
  | (Common & {
      type: 'vec3';
      default?: Partial<{ x: number; y: number; z: number }>;
      min?: number;
      max?: number;
      step?: number;
    })
  | (Common & {
      type: 'array';
      items: Parameter;
      default?: readonly unknown[];
      minLength?: number;
      maxLength?: number;
    })
  | (Common & {
      type: 'object';
      properties: Record<string, Parameter>;
      default?: Record<string, unknown>;
    });
export type ParameterDefinitions = Record<string, Parameter>;
export type ParameterValue<P, D extends unknown[] = []> = D['length'] extends 12
  ? unknown
  : P extends { type: 'number' }
    ? number
    : P extends { type: 'string' | 'color' }
      ? string
      : P extends { type: 'boolean' }
        ? boolean
        : P extends { type: 'enum'; options: readonly (infer V)[] }
          ? V
          : P extends { type: 'vec2' }
            ? { x: number; y: number }
            : P extends { type: 'vec3' }
              ? { x: number; y: number; z: number }
              : P extends { type: 'array'; items: infer I }
                ? ParameterValue<I, [...D, unknown]>[]
                : P extends { type: 'object'; properties: infer O }
                  ? { [K in keyof O]: ParameterValue<O[K], [...D, unknown]> }
                  : unknown;
export type ParameterValues<P extends ParameterDefinitions> = {
  [K in keyof P]: ParameterValue<P[K]>;
};
export class ParameterError extends Error {
  constructor(
    public code: 'PARAMETER_SCHEMA' | 'PARAMETER_VALUE',
    public path: string,
    message: string,
  ) {
    super(`${path}: ${message}`);
    this.name = 'ParameterError';
  }
}
const keyPattern = /^[a-zA-Z][\w-]*$/,
  badNames = new Set(['__proto__', 'prototype', 'constructor']);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
function fail(path: string, message: string, schema = false): never {
  throw new ParameterError(schema ? 'PARAMETER_SCHEMA' : 'PARAMETER_VALUE', path, message);
}
function numberValue(
  spec: { min?: number; max?: number; integer?: boolean },
  value: unknown,
  path: string,
) {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'Expected a finite number');
  if (spec.integer && !Number.isInteger(value)) fail(path, 'Expected an integer');
  if (spec.min !== undefined && value < spec.min) fail(path, `Must be at least ${spec.min}`);
  if (spec.max !== undefined && value > spec.max) fail(path, `Must be at most ${spec.max}`);
  return value;
}
export function parameterDefault(
  spec: Parameter,
  budget = { remaining: 100000 },
  depth = 0,
): unknown {
  if (depth > 16 || --budget.remaining < 0)
    fail('parameters.default', 'Default value exceeds size/depth limits', true);
  if (spec.default !== undefined) return structuredClone(spec.default);
  switch (spec.type) {
    case 'number':
      return Math.min(
        spec.integer ? Math.floor(spec.max ?? Infinity) : (spec.max ?? Infinity),
        Math.max(spec.integer ? Math.ceil(spec.min ?? -Infinity) : (spec.min ?? -Infinity), 0),
      );
    case 'string':
      return ''.padEnd(spec.minLength ?? 0, ' ');
    case 'color':
      return '#ffffff';
    case 'boolean':
      return false;
    case 'enum':
      return spec.options[0];
    case 'vec2':
    case 'vec3': {
      const value = Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, 0));
      return spec.type === 'vec2' ? { x: value, y: value } : { x: value, y: value, z: value };
    }
    case 'array':
      return Array.from({ length: spec.minLength ?? 0 }, () =>
        parameterDefault(spec.items, budget, depth + 1),
      );
    case 'object':
      return Object.fromEntries(
        Object.entries(spec.properties).map(([key, value]) => [
          key,
          parameterDefault(value, budget, depth + 1),
        ]),
      );
  }
}
export function parameterValue(
  spec: Parameter,
  value: unknown,
  path = 'params',
  depth = 0,
  budget = { remaining: 100000 },
): unknown {
  if (depth > 16 || --budget.remaining < 0)
    fail(path, 'Parameter value exceeds the size/depth limit');
  if (value === undefined) value = parameterDefault(spec);
  switch (spec.type) {
    case 'number':
      return numberValue(spec, value, path);
    case 'string':
    case 'color': {
      if (typeof value !== 'string') fail(path, 'Expected a string');
      const min = spec.type === 'color' ? 1 : (spec.minLength ?? 0),
        max = spec.type === 'color' ? 1000 : (spec.maxLength ?? 1000000);
      if (value.length < min || value.length > max)
        fail(path, `String length must be ${min}–${max}`);
      return value;
    }
    case 'boolean':
      if (typeof value !== 'boolean') fail(path, 'Expected a boolean');
      return value;
    case 'enum':
      if (!spec.options.includes(value as string | number))
        fail(path, 'Expected one of the declared enum options');
      return value;
    case 'vec2':
    case 'vec3': {
      if (!record(value)) fail(path, 'Expected a vector object');
      const axes = spec.type === 'vec2' ? ['x', 'y'] : ['x', 'y', 'z'];
      for (const key of Object.keys(value))
        if (!axes.includes(key)) fail(`${path}.${key}`, 'Unknown vector coordinate');
      const defaults = parameterDefault(spec) as Record<string, number>;
      return Object.fromEntries(
        axes.map((key) => [
          key,
          numberValue(
            spec,
            value[key] === undefined
              ? (defaults[key] ??
                  Math.min(spec.max ?? Infinity, Math.max(spec.min ?? -Infinity, 0)))
              : value[key],
            `${path}.${key}`,
          ),
        ]),
      );
    }
    case 'array': {
      if (!Array.isArray(value)) fail(path, 'Expected an array');
      const min = spec.minLength ?? 0,
        max = spec.maxLength ?? 10000;
      if (value.length < min || value.length > max)
        fail(path, `Array length must be ${min}–${max}`);
      return value.map((item, i) =>
        parameterValue(spec.items, item, `${path}.${i}`, depth + 1, budget),
      );
    }
    case 'object': {
      if (!record(value)) fail(path, 'Expected an object');
      for (const key of Object.keys(value))
        if (!Object.hasOwn(spec.properties, key)) fail(`${path}.${key}`, 'Unknown object property');
      const defaults = spec.default ?? {};
      return Object.fromEntries(
        Object.entries(spec.properties).map(([key, child]) => [
          key,
          parameterValue(
            child,
            Object.hasOwn(value, key) ? value[key] : defaults[key],
            `${path}.${key}`,
            depth + 1,
            budget,
          ),
        ]),
      );
    }
  }
}
export function validateParameterDefinitions(input: unknown): ParameterDefinitions {
  if (!record(input)) fail('parameters', 'Expected parameter definitions', true);
  const seen = new Set<object>();
  let remaining = 4000;
  const inspect = (raw: unknown, path: string, depth: number): Parameter => {
    if (!record(raw) || typeof raw.type !== 'string')
      fail(path, 'Expected a parameter descriptor', true);
    if (depth > 16 || --remaining < 0 || seen.has(raw))
      fail(path, 'Parameter schema exceeds size/depth limits or contains a cycle', true);
    seen.add(raw);
    const allowed: Record<string, string[]> = {
        number: ['min', 'max', 'integer', 'step'],
        string: ['minLength', 'maxLength'],
        color: [],
        boolean: [],
        enum: ['options'],
        vec2: ['min', 'max', 'step'],
        vec3: ['min', 'max', 'step'],
        array: ['items', 'minLength', 'maxLength'],
        object: ['properties'],
      },
      extras = allowed[raw.type];
    if (!extras) fail(path, 'Unknown parameter type', true);
    for (const key of Object.keys(raw))
      if (!['type', 'default', 'label', 'description', ...extras].includes(key))
        fail(`${path}.${key}`, 'Unknown descriptor field', true);
    for (const key of ['label', 'description'])
      if (raw[key] !== undefined && typeof raw[key] !== 'string')
        fail(`${path}.${key}`, 'Expected a string', true);
    for (const key of ['min', 'max', 'step'])
      if (raw[key] !== undefined && (typeof raw[key] !== 'number' || !Number.isFinite(raw[key])))
        fail(`${path}.${key}`, 'Expected a finite number', true);
    if (raw.min !== undefined && raw.max !== undefined && (raw.min as number) > (raw.max as number))
      fail(path, 'Minimum exceeds maximum', true);
    if (raw.step !== undefined && (raw.step as number) <= 0)
      fail(path, 'Step must be positive', true);
    if (raw.integer !== undefined && typeof raw.integer !== 'boolean')
      fail(path, 'integer must be a boolean', true);
    for (const key of ['minLength', 'maxLength'])
      if (
        raw[key] !== undefined &&
        (!Number.isInteger(raw[key]) ||
          (raw[key] as number) < 0 ||
          (raw[key] as number) > (raw.type === 'array' ? 10000 : 1000000))
      )
        fail(`${path}.${key}`, 'Invalid length limit', true);
    if (
      raw.minLength !== undefined &&
      raw.maxLength !== undefined &&
      (raw.minLength as number) > (raw.maxLength as number)
    )
      fail(path, 'Minimum length exceeds maximum length', true);
    if (raw.type === 'enum') {
      if (
        !Array.isArray(raw.options) ||
        !raw.options.length ||
        raw.options.length > 1000 ||
        raw.options.some(
          (v) => !(typeof v === 'string' || (typeof v === 'number' && Number.isFinite(v))),
        ) ||
        new Set(raw.options).size !== raw.options.length
      )
        fail(path, 'Enum needs unique finite number/string options', true);
    }
    if (raw.type === 'array') inspect(raw.items, `${path}.items`, depth + 1);
    if (raw.type === 'object') {
      if (!record(raw.properties)) fail(path, 'Object needs property descriptors', true);
      for (const [key, value] of Object.entries(raw.properties)) {
        if (!keyPattern.test(key) || badNames.has(key))
          fail(`${path}.${key}`, 'Invalid property name', true);
        inspect(value, `${path}.${key}`, depth + 1);
      }
    }
    seen.delete(raw);
    const spec = raw as Parameter;
    try {
      parameterValue(spec, undefined, path);
    } catch (e) {
      if (e instanceof ParameterError)
        throw new ParameterError('PARAMETER_SCHEMA', e.path, `Invalid default: ${e.message}`);
      throw e;
    }
    return spec;
  };
  for (const [key, value] of Object.entries(input)) {
    if (!keyPattern.test(key) || badNames.has(key))
      fail(`parameters.${key}`, 'Invalid parameter name', true);
    inspect(value, `parameters.${key}`, 0);
  }
  return input as ParameterDefinitions;
}
export function resolveParameters<P extends ParameterDefinitions>(
  specs: P,
  input: Record<string, unknown> = {},
): ParameterValues<P> {
  if (!record(input)) fail('params', 'Expected a parameter object');
  for (const key of Object.keys(input))
    if (!Object.hasOwn(specs, key)) fail(`params.${key}`, 'Unknown component parameter');
  const budget = { remaining: 100000 };
  return Object.fromEntries(
    Object.entries(specs).map(([key, spec]) => [
      key,
      parameterValue(spec, input[key], `params.${key}`, 0, budget),
    ]),
  ) as ParameterValues<P>;
}
export function parameterJsonSchema(spec: Parameter): Record<string, unknown> {
  const info = {
    title: spec.label,
    description: spec.description,
    default: parameterDefault(spec),
  };
  switch (spec.type) {
    case 'number':
      return {
        ...info,
        type: spec.integer ? 'integer' : 'number',
        minimum: spec.min,
        maximum: spec.max,
      };
    case 'string':
      return { ...info, type: 'string', minLength: spec.minLength, maxLength: spec.maxLength };
    case 'color':
      return { ...info, type: 'string', minLength: 1 };
    case 'boolean':
      return { ...info, type: 'boolean' };
    case 'enum':
      return { ...info, enum: spec.options };
    case 'vec2':
    case 'vec3': {
      const axes = spec.type === 'vec2' ? ['x', 'y'] : ['x', 'y', 'z'];
      return {
        ...info,
        type: 'object',
        properties: Object.fromEntries(
          axes.map((axis) => [axis, { type: 'number', minimum: spec.min, maximum: spec.max }]),
        ),
        additionalProperties: false,
      };
    }
    case 'array':
      return {
        ...info,
        type: 'array',
        items: parameterJsonSchema(spec.items),
        minItems: spec.minLength,
        maxItems: spec.maxLength ?? 10000,
      };
    case 'object':
      return {
        ...info,
        type: 'object',
        properties: Object.fromEntries(
          Object.entries(spec.properties).map(([key, child]) => [key, parameterJsonSchema(child)]),
        ),
        additionalProperties: false,
      };
  }
}
