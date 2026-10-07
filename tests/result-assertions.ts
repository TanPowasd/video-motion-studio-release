/** Narrow optional/union responses at the assertion that needs a concrete value. */
export function present<T>(value: T): NonNullable<T> {
  if (value === undefined || value === null) throw new Error('Expected a present response value');
  return value;
}
type Field<T, K extends PropertyKey> = T extends unknown
  ? K extends keyof T
    ? T[K]
    : unknown extends T
      ? unknown
      : undefined
  : never;
export function field<T, K extends PropertyKey>(value: T, key: K): Field<T, K> {
  if (
    value === null ||
    value === undefined ||
    (typeof value !== 'object' && typeof value !== 'function')
  )
    throw new Error(`Expected an object when inspecting ${String(key)}`);
  return (value as Record<PropertyKey, unknown>)[key] as Field<T, K>;
}
