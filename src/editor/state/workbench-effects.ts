import { z } from 'zod';
import type {
  ApplicationState,
  RpcMethod,
  RpcInput,
  RpcOutput,
} from '../../service/rpc-contract.js';
import { rpc, type RpcClient } from './rpc-client.js';
import type { WorkbenchStore } from './workbench-store.js';
export interface WorkbenchCommands {
  <M extends RpcMethod>(method: M, params?: unknown): Promise<RpcOutput<M> | undefined>;
  (method: string, params?: unknown): Promise<unknown>;
}
export function mergeApplicationState(
  previous: ApplicationState | undefined,
  result: unknown,
): ApplicationState | undefined {
  if (!result || typeof result !== 'object' || !('snapshot' in result)) return previous;
  const patch = result as Partial<ApplicationState>;
  if (!patch.snapshot || typeof patch.snapshot.revision !== 'string') return previous;
  return { ...previous, ...patch } as ApplicationState;
}
export function createWorkbenchCommands(
  store: WorkbenchStore,
  client: RpcClient = rpc,
): WorkbenchCommands {
  return async (method: string, params: unknown = {}) => {
    store.dispatch({ type: 'patch', slice: 'diagnostics', patch: { error: '' } });
    try {
      const result = await client(method, params);
      const previous = store.getSnapshot().project.state;
      const state = mergeApplicationState(previous, result);
      if (state !== previous) store.dispatch({ type: 'patch', slice: 'project', patch: { state } });
      return result;
    } catch (error) {
      store.dispatch({
        type: 'patch',
        slice: 'diagnostics',
        patch: { error: error instanceof Error ? error.message : String(error) },
      });
      return undefined;
    }
  };
}
export function subscribeWorkbench(store: WorkbenchStore, events: EventSource) {
  events.onmessage = (event) => {
    try {
      const value: z.infer<typeof update> = update.parse(JSON.parse(event.data));
      if (value.kind === 'change') {
        const state = mergeApplicationState(store.getSnapshot().project.state, value.state);
        store.dispatch({ type: 'patch', slice: 'project', patch: { state } });
      } else if (Array.isArray(value.jobs))
        store.dispatch({
          type: 'patch',
          slice: 'tasks',
          patch: { jobs: value.jobs as ApplicationState['jobs'] },
        });
    } catch (error) {
      store.dispatch({
        type: 'patch',
        slice: 'diagnostics',
        patch: { error: error instanceof Error ? error.message : String(error) },
      });
    }
  };
  return () => events.close();
}
const update = z.object({
  kind: z.string(),
  state: z.unknown().optional(),
  jobs: z.unknown().optional(),
});
