import { nodeSchema, VmotionError, type Node, type Snapshot } from './model.js';
import {
  themeBindingSchema,
  themeDocumentSchema,
  themePropertySchema,
  type ThemeBinding,
  type ThemeToken,
} from './theme-schema.js';
import { GeometryCache } from './geometry-cache.js';
export const themeEqual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function themePathValue(value: unknown, path: string): unknown {
  let current: any = value;
  for (const part of path.split('.')) {
    if (
      ['__proto__', 'prototype', 'constructor'].includes(part) ||
      !current ||
      typeof current !== 'object' ||
      !Object.hasOwn(current, part)
    )
      throw new VmotionError('THEME_PROPERTY', 'Theme property is not present', { property: path });
    current = current[part];
  }
  return current;
}
// Copy only modified branches; long animation arrays are shared unchanged.
export function themeSetPath<T extends object>(source: T, path: string, value: unknown): T {
  const parts = path.split('.');
  if (parts.some((p) => ['__proto__', 'prototype', 'constructor'].includes(p)))
    throw new VmotionError('THEME_PROPERTY', 'Unsafe property path');
  const write = (current: any, index: number): any => {
    if (!current || typeof current !== 'object' || !Object.hasOwn(current, parts[index]))
      throw new VmotionError('THEME_PROPERTY', 'Theme property is not present', { property: path });
    const next = Array.isArray(current) ? [...current] : { ...current };
    next[parts[index]] =
      index === parts.length - 1 ? structuredClone(value) : write(current[parts[index]], index + 1);
    return next;
  };
  return write(source, 0);
}
export function bindTheme(
  node: Node,
  input: {
    source: string;
    links: Record<string, string>;
    overrides?: Record<string, unknown>;
    enabled?: boolean;
  },
) {
  const baseline = Object.fromEntries(
    Object.keys(input.links).map((field) => [
      themePropertySchema.parse(field),
      structuredClone(themePathValue(node, field)),
    ]),
  );
  return { ...node, theme: themeBindingSchema.parse({ ...input, baseline }) };
}
type PreparedTheme = {
  tokens: Map<string, { token: ThemeToken; value: unknown; file: string }>;
  probes: Map<string, string>;
  source: string;
};
export class ThemeResolver {
  private readonly cache: GeometryCache<PreparedTheme>;
  private stats = { resolutions: 0, tokenReads: 0, nodeWrites: 0 };
  constructor(budget = 4 * 1024 * 1024) {
    this.cache = new GeometryCache(budget, 128);
  }
  report() {
    return { ...this.stats, cache: this.cache.report() };
  }
  clear() {
    this.cache.clear();
  }
  prepare(snapshot: Pick<Snapshot, 'files'>, file: string): PreparedTheme {
    const cached = this.cache.get(file);
    if (cached && [...cached.probes].every(([p, s]) => snapshot.files[p] === s)) return cached;
    const tokens = new Map<string, { token: ThemeToken; value: unknown; file: string }>(),
      probes = new Map<string, string>(),
      stack: string[] = [],
      load = (path: string) => {
        if (stack.includes(path) || stack.length >= 16)
          throw new VmotionError(
            'THEME_CYCLE',
            'Theme inheritance contains a cycle or exceeds depth 16',
            { files: [...stack, path] },
          );
        const source = snapshot.files[path];
        if (source === undefined)
          throw new VmotionError('THEME_SOURCE', 'Theme resource is missing', { file: path });
        let d;
        try {
          d = themeDocumentSchema.parse(JSON.parse(source));
        } catch (e) {
          throw new VmotionError('THEME_DOCUMENT', `Invalid theme: ${(e as Error).message}`, {
            file: path,
          });
        }
        probes.set(path, source);
        stack.push(path);
        if (d.parent) load(d.parent);
        for (const token of d.tokens) {
          const old = tokens.get(token.id);
          if (old && old.token.type !== token.type)
            throw new VmotionError('THEME_TYPE', 'Inherited token type cannot change', {
              file: path,
              tokenId: token.id,
            });
          tokens.set(token.id, { token, value: undefined, file: path });
        }
        stack.pop();
      };
    load(file);
    if (tokens.size > 2048)
      throw new VmotionError('THEME_BUDGET', 'Inherited theme exceeds 2048 tokens');
    const active: string[] = [],
      done = new Set<string>(),
      resolve = (id: string): unknown => {
        const entry = tokens.get(id);
        if (!entry)
          throw new VmotionError('THEME_TOKEN', 'Theme alias/token is missing', {
            tokenId: id,
            file,
          });
        if (done.has(id)) return entry.value;
        if (active.includes(id) || active.length >= 64)
          throw new VmotionError(
            'THEME_CYCLE',
            'Theme aliases contain a cycle or exceed depth 64',
            { tokens: [...active, id] },
          );
        active.push(id);
        const target = entry.token.alias ? tokens.get(entry.token.alias) : undefined;
        if (target && target.token.type !== entry.token.type)
          throw new VmotionError('THEME_TYPE', 'Alias target type differs', { tokenId: id });
        const value = entry.token.alias ? resolve(entry.token.alias) : entry.token.value;
        if (
          entry.token.type === 'number' &&
          (typeof value !== 'number' ||
            (entry.token.min !== undefined && value < entry.token.min) ||
            (entry.token.max !== undefined && value > entry.token.max))
        )
          throw new VmotionError('THEME_VALUE', 'Number token exceeds its constraints', {
            tokenId: id,
          });
        entry.value = structuredClone(value);
        done.add(id);
        active.pop();
        return entry.value;
      };
    for (const id of tokens.keys()) resolve(id);
    const prepared = { tokens, probes, source: file };
    this.stats.resolutions++;
    this.cache.put(
      file,
      prepared,
      [...probes.values()].reduce((n, s) => n + s.length * 2, 0) +
        JSON.stringify([...tokens]).length * 2,
    );
    return prepared;
  }
  value(snapshot: Pick<Snapshot, 'files'>, source: string, id: string) {
    const prepared = this.prepare(snapshot, source),
      entry = prepared.tokens.get(id);
    if (!entry)
      throw new VmotionError('THEME_TOKEN', 'Theme token is missing', {
        file: source,
        tokenId: id,
      });
    this.stats.tokenReads++;
    return structuredClone(entry.value);
  }
  resolveNode(snapshot: Pick<Snapshot, 'files'>, raw: Node): Node {
    const b = raw.theme;
    if (!b?.enabled || !Object.keys(b.links).length) return raw;
    const prepared = this.prepare(snapshot, b.source);
    for (const id of Object.values(b.links))
      if (!prepared.tokens.has(id))
        throw new VmotionError(
          'THEME_TOKEN',
          'Remove missing token links explicitly, including locally overridden fields',
          { file: b.source, nodeId: raw.id, tokenId: id },
        );
    let node = raw;
    for (const [field, id] of Object.entries(b.links)) {
      const literal = themePathValue(raw, field),
        baseline = b.baseline[field];
      if (!Object.hasOwn(b.overrides, field) && !themeEqual(literal, baseline)) continue;
      const entry = prepared.tokens.get(id);
      if (!entry)
        throw new VmotionError('THEME_TOKEN', 'Bound theme token is missing', {
          file: b.source,
          nodeId: raw.id,
          property: field,
          tokenId: id,
        });
      if (
        /^(fill|stroke|shadow\.color|gradient\.stops\.\d+\.color)$/.test(field) &&
        entry.token.type !== 'color'
      )
        throw new VmotionError('THEME_TYPE', 'Paint fields require a color token', {
          nodeId: raw.id,
          property: field,
          tokenId: id,
        });
      const value = Object.hasOwn(b.overrides, field) ? b.overrides[field] : entry.value;
      if (typeof value !== typeof literal || Array.isArray(value) !== Array.isArray(literal))
        throw new VmotionError('THEME_TYPE', 'Token value does not match the bound property', {
          nodeId: raw.id,
          property: field,
          tokenId: id,
        });
      node = themeSetPath(node, field, value);
      this.stats.tokenReads++;
      this.stats.nodeWrites++;
    }
    for (const root of new Set(Object.keys(b.links).map((p) => p.split('.')[0]))) {
      const schema = nodeSchema.shape[root as keyof typeof nodeSchema.shape];
      if (!schema) throw new VmotionError('THEME_PROPERTY', 'Unknown bound property');
      try {
        const parsed = schema.parse((node as any)[root]);
        node = { ...node, [root]: parsed };
      } catch (e) {
        throw new VmotionError('THEME_VALUE', `Invalid themed property: ${(e as Error).message}`, {
          nodeId: node.id,
          property: root,
          file: b.source,
        });
      }
    }
    return node;
  }
  inspectBinding(snapshot: Pick<Snapshot, 'files'>, node: Node) {
    const b = node.theme;
    if (!b) return [];
    const prepared = this.prepare(snapshot, b.source),
      resolved = this.resolveNode(snapshot, node);
    return Object.entries(b.links).map(([field, token]) => ({
      property: field,
      token,
      tokenType: prepared.tokens.get(token)?.token.type,
      baseline: b.baseline[field],
      literal: themePathValue(node, field),
      effective: themePathValue(resolved, field),
      source: !b.enabled
        ? 'disabled'
        : Object.hasOwn(b.overrides, field)
          ? 'override'
          : themeEqual(themePathValue(node, field), b.baseline[field])
            ? 'theme'
            : 'literal',
    }));
  }
}
