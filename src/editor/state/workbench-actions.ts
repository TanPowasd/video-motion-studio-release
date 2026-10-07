import type { WorkbenchState } from './workbench-types.js';
export type WorkbenchSlice = keyof WorkbenchState;
export type WorkbenchAction = {
  [S in WorkbenchSlice]: { type: 'patch'; slice: S; patch: Partial<WorkbenchState[S]> };
}[WorkbenchSlice];
