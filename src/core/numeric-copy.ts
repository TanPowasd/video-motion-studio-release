import { getNumericPath } from './time.js';
/** Clone only containers along changed paths; immutable geometry/source/channel resources stay shared. */
export function copyNumericUpdates<T>(source: T, updates: Iterable<[string, number]>): T {
  const copy = (value: any) => (Array.isArray(value) ? [...value] : { ...value }),
    out = copy(source),
    owned = new WeakSet<object>([out]);
  for (const [path, value] of updates) {
    if (!Number.isFinite(value)) throw new Error(`Animation value for ${path} is not finite`);
    getNumericPath(source, path);
    const parts = path.split('.');
    let current = out;
    for (const part of parts.slice(0, -1)) {
      const child = current[part];
      if (!owned.has(child)) {
        current[part] = copy(child);
        owned.add(current[part]);
      }
      current = current[part];
    }
    current[parts.at(-1)!] = value;
  }
  return out;
}
