import { diffLines } from 'diff';
import type { Conflict } from './model.js';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function mergeJson(
  base: unknown,
  ours: unknown,
  theirs: unknown,
  file: string,
  path = '',
): { value: unknown; conflicts: Conflict[] } {
  if (same(ours, theirs)) return { value: ours, conflicts: [] };
  if (same(base, ours)) return { value: theirs, conflicts: [] };
  if (same(base, theirs)) return { value: ours, conflicts: [] };
  if (
    [base, ours, theirs].every((v) => Array.isArray(v)) &&
    [base, ours, theirs].every((v) =>
      (v as unknown[]).every((n) => typeof n === 'object' && n !== null && 'id' in n),
    )
  ) {
    const b = base as Array<{ id: string }>,
      o = ours as Array<{ id: string }>,
      t = theirs as Array<{ id: string }>;
    const keys = [...new Set([...o, ...t].map((n) => n.id))],
      value: unknown[] = [],
      conflicts: Conflict[] = [];
    for (const key of keys) {
      const r = mergeJson(
        b.find((n) => n.id === key),
        o.find((n) => n.id === key),
        t.find((n) => n.id === key),
        file,
        `${path}/${key}`,
      );
      if (r.value !== undefined) value.push(r.value);
      conflicts.push(...r.conflicts);
    }
    const existing = b
        .map((n) => n.id)
        .filter((k) => o.some((n) => n.id === k) && t.some((n) => n.id === k)),
      order = (v: typeof b) => v.map((n) => n.id).filter((k) => existing.includes(k));
    const bo = order(b),
      oo = order(o),
      to = order(t);
    if (!same(bo, oo) && !same(bo, to) && !same(oo, to))
      conflicts.push({ file, path: `${path}/$order`, base: bo, ours: oo, theirs: to });
    else if (same(bo, oo) && !same(bo, to)) {
      const remoteOrder = [
        ...t.map((n) => n.id),
        ...o.map((n) => n.id).filter((k) => !t.some((n) => n.id === k)),
      ];
      value.sort(
        (a, b) =>
          remoteOrder.indexOf((a as { id: string }).id) -
          remoteOrder.indexOf((b as { id: string }).id),
      );
    }
    return { value, conflicts };
  }
  if ([base, ours, theirs].every((v) => v !== null && typeof v === 'object' && !Array.isArray(v))) {
    const b = base as Record<string, unknown>,
      o = ours as typeof b,
      t = theirs as typeof b,
      value: typeof b = {},
      conflicts: Conflict[] = [];
    for (const key of new Set([...Object.keys(b), ...Object.keys(o), ...Object.keys(t)])) {
      const r = mergeJson(b[key], o[key], t[key], file, `${path}/${key}`);
      if (r.value !== undefined) value[key] = r.value;
      conflicts.push(...r.conflicts);
    }
    return { value, conflicts };
  }
  return { value: ours, conflicts: [{ file, path, base, ours, theirs }] };
}
interface Hunk {
  start: number;
  end: number;
  lines: string[];
}
function hunks(base: string, changed: string): Hunk[] {
  let cursor = 0;
  const out: Hunk[] = [];
  for (const part of diffLines(base, changed)) {
    const lines = part.value.match(/[^\n]*\n|[^\n]+$/g) ?? [];
    if (part.added) {
      const prev = out.at(-1);
      if (prev && prev.end === cursor) prev.lines.push(...lines);
      else out.push({ start: cursor, end: cursor, lines });
    } else if (part.removed) {
      out.push({ start: cursor, end: cursor + lines.length, lines: [] });
      cursor += lines.length;
    } else cursor += lines.length;
  }
  return out;
}
export function mergeText(
  base: string,
  ours: string,
  theirs: string,
  file: string,
): { value: string; conflicts: Conflict[] } {
  if (ours === theirs || base === theirs) return { value: ours, conflicts: [] };
  if (base === ours) return { value: theirs, conflicts: [] };
  const a = hunks(base, ours),
    b = hunks(base, theirs);
  for (const x of a)
    for (const y of b) {
      const overlap =
        x.start === x.end && y.start === y.end
          ? x.start === y.start
          : x.start === x.end
            ? x.start >= y.start && x.start < y.end
            : y.start === y.end
              ? y.start >= x.start && y.start < x.end
              : x.start < y.end && y.start < x.end;
      if (overlap && JSON.stringify(x) !== JSON.stringify(y))
        return { value: ours, conflicts: [{ file, path: '$source', base, ours, theirs }] };
    }
  const lines = base.match(/[^\n]*\n|[^\n]+$/g) ?? [];
  const unique = [...new Map([...a, ...b].map((h) => [JSON.stringify(h), h])).values()].sort(
    (x, y) => y.start - x.start,
  );
  for (const h of unique) lines.splice(h.start, h.end - h.start, ...h.lines);
  return { value: lines.join(''), conflicts: [] };
}
