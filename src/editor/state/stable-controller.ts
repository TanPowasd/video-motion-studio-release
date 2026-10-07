import { useRef } from 'react';
/** Stable command identities with current closures; state values retain their normal references. */
export function useStableControllerValues<T extends object>(values: T): T {
  const current = useRef(values);
  current.current = values;
  const functions = useRef(new Map<string, (...args: unknown[]) => unknown>());
  const result = { ...values };
  for (const key of Object.keys(values)) {
    if (typeof Reflect.get(values, key) !== 'function') continue;
    if (!functions.current.has(key))
      functions.current.set(key, (...args: unknown[]) => {
        const callback: unknown = Reflect.get(current.current, key);
        if (typeof callback !== 'function') throw new Error('Controller command is unavailable');
        return Reflect.apply(callback, undefined, args);
      });
    Reflect.set(result, key, functions.current.get(key));
  }
  return result;
}
