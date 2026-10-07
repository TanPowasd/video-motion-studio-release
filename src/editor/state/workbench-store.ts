import { createContext, createElement, useContext, useRef, type ReactNode } from 'react';
import { workbenchReducer } from './workbench-reducer.js';
import { createWorkbenchState, type WorkbenchState } from './workbench-types.js';
import type { WorkbenchAction } from './workbench-actions.js';
import { readCompositionRoute } from '../navigation.js';
export interface WorkbenchStore {
  getSnapshot(): WorkbenchState;
  subscribe(listener: () => void): () => void;
  dispatch(action: WorkbenchAction): void;
}
export function createWorkbenchStore(initial: WorkbenchState): WorkbenchStore {
  let state = initial;
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => state,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    dispatch(action) {
      const next = workbenchReducer(state, action);
      if (next === state) return;
      state = next;
      for (const listener of [...listeners]) listener();
    },
  };
}
const Context = createContext<WorkbenchStore | undefined>(undefined);
export function WorkbenchProvider({
  children,
  store: suppliedStore,
}: {
  children: ReactNode;
  store?: WorkbenchStore;
}) {
  const store = useRef<WorkbenchStore | undefined>(undefined);
  store.current ??=
    suppliedStore ?? createWorkbenchStore(createWorkbenchState(readCompositionRoute()));
  return createElement(Context.Provider, { value: store.current }, children);
}
export function useWorkbenchStore() {
  const store = useContext(Context);
  if (!store) throw new Error('WorkbenchProvider is required');
  return store;
}
