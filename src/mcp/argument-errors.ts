import { z, type ZodTypeAny } from 'zod';
import { VmotionError } from '../core/model.js';

/** One argument problem with everything needed to fix it without another schema round trip. */
export type ArgumentIssue = {
  path: string;
  message: string;
  code?: string;
  allowed?: unknown[];
  minimum?: number | bigint;
  maximum?: number | bigint;
  expected?: string;
  received?: unknown;
  allowedKeys?: string[];
  example?: unknown;
};

const MAX_ALLOWED = 64,
  MAX_ISSUES = 8;

function unwrap(schema: ZodTypeAny | undefined): ZodTypeAny | undefined {
  let current = schema;
  for (let i = 0; i < 16 && current; i++) {
    if (
      current instanceof z.ZodOptional ||
      current instanceof z.ZodNullable ||
      current instanceof z.ZodDefault
    )
      current = current._def.innerType;
    else if (current instanceof z.ZodEffects) current = current._def.schema;
    else if (current instanceof z.ZodLazy) current = current._def.getter();
    else if (current instanceof z.ZodBranded) current = current._def.type;
    else if (current instanceof z.ZodPipeline) current = current._def.in;
    else break;
  }
  return current;
}

/** Walk an issue path through objects, arrays, records and unions (first matching branch). */
function schemaAt(root: ZodTypeAny | undefined, path: Array<string | number>, value?: unknown) {
  let current = unwrap(root),
    data = value;
  for (const key of path) {
    if (!current) return undefined;
    if (current instanceof z.ZodObject) current = unwrap(current.shape[key as string]);
    else if (current instanceof z.ZodArray) current = unwrap(current.element);
    else if (current instanceof z.ZodRecord) current = unwrap(current._def.valueType);
    else if (current instanceof z.ZodTuple) current = unwrap(current.items[key as number]);
    else if (current instanceof z.ZodDiscriminatedUnion) {
      const discriminator = current.discriminator,
        selected =
          data && typeof data === 'object'
            ? current.optionsMap.get((data as Record<string, unknown>)[discriminator] as never)
            : undefined;
      current = unwrap((selected ?? current.options[0])?.shape[key as string]);
    } else if (current instanceof z.ZodUnion) {
      const options = current.options as ZodTypeAny[];
      const branch = options
        .map(unwrap)
        .find((o) => o instanceof z.ZodObject && Object.hasOwn(o.shape, key as string)) as
        z.ZodObject<z.ZodRawShape> | undefined;
      current = branch ? unwrap(branch.shape[key as string]) : undefined;
    } else return undefined;
    data =
      data && typeof data === 'object'
        ? (data as Record<string | number, unknown>)[key]
        : undefined;
  }
  return current;
}

/** A short value that satisfies a (sub)schema; used for per-field and whole-call examples. */
export function exampleFor(schema: ZodTypeAny | undefined, depth = 0): unknown {
  const s = unwrap(schema);
  if (!s || depth > 4) return undefined;
  if (s instanceof z.ZodEnum) return s.options[0];
  if (s instanceof z.ZodNativeEnum) return Object.values(s.enum)[0];
  if (s instanceof z.ZodLiteral) return s.value;
  if (s instanceof z.ZodBoolean) return true;
  if (s instanceof z.ZodNumber) {
    const min = s.minValue ?? undefined,
      max = s.maxValue ?? undefined;
    if (min !== undefined && Number.isFinite(min)) return min;
    if (max !== undefined && Number.isFinite(max)) return Math.min(max, s.isInt ? 1 : 1);
    return s.isInt ? 0 : 0;
  }
  if (s instanceof z.ZodString) {
    const min = s.minLength ?? 0;
    return min > 2 ? 'x'.repeat(min) : '<id>';
  }
  if (s instanceof z.ZodArray) {
    const min = s._def.minLength?.value ?? 0;
    return min > 0 ? [exampleFor(s.element, depth + 1)] : [];
  }
  if (s instanceof z.ZodTuple) return s.items.map((i: ZodTypeAny) => exampleFor(i, depth + 1));
  if (s instanceof z.ZodDiscriminatedUnion) return exampleFor(s.options[0], depth + 1);
  if (s instanceof z.ZodUnion) return exampleFor(s.options[0], depth + 1);
  if (s instanceof z.ZodObject) return requiredExample(s, depth + 1);
  if (s instanceof z.ZodRecord) return {};
  return undefined;
}
/** Only required fields: a minimal call that passes structural validation for simple tools. */
export function requiredExample(schema: z.ZodObject<z.ZodRawShape>, depth = 0) {
  const out: Record<string, unknown> = {};
  for (const [key, field] of Object.entries(schema.shape)) {
    if (field.isOptional()) continue;
    out[key] = exampleFor(field, depth);
  }
  return out;
}

function issueDetail(
  issue: z.ZodIssue,
  root: ZodTypeAny | undefined,
  value: unknown,
): ArgumentIssue {
  const path = '/' + issue.path.join('/'),
    base: ArgumentIssue = { path, message: issue.message, code: issue.code };
  const field = schemaAt(root, issue.path, value);
  switch (issue.code) {
    case 'invalid_enum_value': {
      const allowed = issue.options.slice(0, MAX_ALLOWED);
      return {
        ...base,
        message: `Invalid value ${JSON.stringify(issue.received)}; allowed: ${issue.options.map((o) => JSON.stringify(o)).join(', ')}`,
        allowed,
        received: issue.received,
        example: issue.options[0],
      };
    }
    case 'invalid_union_discriminator':
      return {
        ...base,
        allowed: issue.options.slice(0, MAX_ALLOWED) as unknown[],
        message: `Invalid discriminator; allowed: ${issue.options.map((o) => JSON.stringify(o)).join(', ')}`,
        example: field ? exampleFor(field) : issue.options[0],
      };
    case 'invalid_literal':
      return {
        ...base,
        allowed: [issue.expected],
        received: issue.received,
        example: issue.expected,
      };
    case 'too_big':
      return {
        ...base,
        maximum: issue.maximum,
        ...(field instanceof z.ZodNumber && field.minValue !== null
          ? { minimum: field.minValue }
          : {}),
        message: `${issue.message} (maximum ${String(issue.maximum)}${issue.inclusive ? ' inclusive' : ' exclusive'})`,
        example: issue.type === 'number' ? Number(issue.maximum) : undefined,
      };
    case 'too_small':
      return {
        ...base,
        minimum: issue.minimum,
        ...(field instanceof z.ZodNumber && field.maxValue !== null
          ? { maximum: field.maxValue }
          : {}),
        message: `${issue.message} (minimum ${String(issue.minimum)}${issue.inclusive ? ' inclusive' : ' exclusive'})`,
        example: field
          ? exampleFor(field)
          : issue.type === 'number'
            ? Number(issue.minimum)
            : undefined,
      };
    case 'invalid_type': {
      const enumField = field instanceof z.ZodEnum ? field : undefined;
      return {
        ...base,
        expected: issue.expected,
        received: issue.received,
        ...(enumField ? { allowed: enumField.options.slice(0, MAX_ALLOWED) } : {}),
        example: field ? exampleFor(field) : undefined,
      };
    }
    case 'unrecognized_keys': {
      const parent = schemaAt(root, issue.path, value);
      return {
        ...base,
        received: issue.keys,
        ...(parent instanceof z.ZodObject ? { allowedKeys: Object.keys(parent.shape) } : {}),
      };
    }
    case 'invalid_union': {
      // Report the closest branch's first issue instead of a bare "Invalid input".
      const nested = issue.unionErrors
        .map((e) => e.issues)
        .sort((a, b) => a.length - b.length)[0]?.[0];
      return nested
        ? {
            ...issueDetail(nested, root, value),
            message: `No union branch matched: ${nested.message}`,
          }
        : base;
    }
    default:
      return { ...base, ...(field ? { example: exampleFor(field) } : {}) };
  }
}

/** Convert a ZodError for one tool into a structured TOOL_ARGUMENTS error with fixes. */
export function argumentError(
  toolName: string,
  error: z.ZodError,
  schema: ZodTypeAny | undefined,
  value: unknown,
  via?: 'tool_call',
) {
  const issues = error.issues.slice(0, MAX_ISSUES).map((issue) => {
    const detail = issueDetail(issue, schema, value);
    for (const key of Object.keys(detail) as Array<keyof ArgumentIssue>)
      if (detail[key] === undefined) delete detail[key];
    return detail;
  });
  const object = unwrap(schema),
    example = object instanceof z.ZodObject ? requiredExample(object) : undefined,
    summary = issues
      .slice(0, 3)
      .map((i) => `${i.path} ${i.message}`)
      .join('; ');
  const result = new VmotionError(
    'TOOL_ARGUMENTS',
    `Invalid arguments for ${toolName}: ${summary}${error.issues.length > MAX_ISSUES ? ` (+${error.issues.length - MAX_ISSUES} more)` : ''}`,
    issues,
  );
  return Object.assign(result, {
    example:
      via === 'tool_call'
        ? { name: 'tool_call', arguments: { name: toolName, arguments: example ?? {} } }
        : { name: toolName, arguments: example ?? {} },
  });
}

/** Strict parse with the structured argument error contract. */
export function parseArguments<T extends ZodTypeAny>(
  toolName: string,
  schema: T,
  raw: unknown,
  via?: 'tool_call',
): z.output<T> {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) throw argumentError(toolName, parsed.error, schema, raw, via);
  return parsed.data;
}
