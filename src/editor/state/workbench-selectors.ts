import {
  useCallback,
  useRef,
  useSyncExternalStore,
  type SetStateAction,
  type Dispatch,
} from 'react';
import { useWorkbenchStore } from './workbench-store.js';
import type { WorkbenchState } from './workbench-types.js';
import type { WorkbenchSlice, WorkbenchAction } from './workbench-actions.js';
export function useWorkbenchSelector<T>(selector: (state: WorkbenchState) => T): T {
  const store = useWorkbenchStore(),
    cache = useRef<{ state: WorkbenchState; selector: typeof selector; value: T } | undefined>(
      undefined,
    );
  const get = () => {
    const state = store.getSnapshot(),
      old = cache.current;
    if (old?.state === state && old.selector === selector) return old.value;
    const value = selector(state);
    cache.current = {
      state,
      selector,
      value: old && Object.is(old.value, value) ? old.value : value,
    };
    return cache.current.value;
  };
  return useSyncExternalStore(store.subscribe, get, get);
}
export function useWorkbenchField<S extends WorkbenchSlice, K extends keyof WorkbenchState[S]>(
  slice: S,
  key: K,
): [WorkbenchState[S][K], Dispatch<SetStateAction<WorkbenchState[S][K]>>] {
  const store = useWorkbenchStore();
  const value = useWorkbenchSelector(useCallback((state) => state[slice][key], [slice, key]));
  const set = useCallback(
    (next: SetStateAction<WorkbenchState[S][K]>) => {
      const old = store.getSnapshot()[slice][key];
      const changed =
        typeof next === 'function'
          ? (next as (value: WorkbenchState[S][K]) => WorkbenchState[S][K])(old)
          : next;
      store.dispatch({ type: 'patch', slice, patch: { [key]: changed } } as WorkbenchAction);
    },
    [store, slice, key],
  );
  return [value, set];
}
