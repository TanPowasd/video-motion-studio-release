import type { WorkbenchState } from './workbench-types.js';
import type { WorkbenchAction } from './workbench-actions.js';
export function workbenchReducer(state: WorkbenchState, action: WorkbenchAction): WorkbenchState {
  const slice = state[action.slice];
  if (
    Object.entries(action.patch).every(([key, value]) => Object.is(Reflect.get(slice, key), value))
  )
    return state;
  return { ...state, [action.slice]: { ...slice, ...action.patch } };
}
