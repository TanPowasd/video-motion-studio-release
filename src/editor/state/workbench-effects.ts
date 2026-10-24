import { z } from 'zod';
import type {
  ApplicationState,
  RpcMethod,
  RpcInput,
  RpcOutput,
} from '../../service/rpc-contract.js';
import { isRevisionConflict, rpc, type RpcClient } from './rpc-client.js';
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
/** Key-order independent JSON, so a node re-serialised by a reload compares equal. */
export function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, v) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, (v as Record<string, unknown>)[k]]))
      : v,
  );
}
/** Same edited layers: identical node data and on-canvas matrix, in the same order of ids. */
export function sameLayers(
  before: ReadonlyArray<{ node: { id: string }; matrix?: readonly number[] }>,
  after: ReadonlyArray<{ node: { id: string }; matrix?: readonly number[] }>,
  ids: readonly string[],
) {
  return ids.every((id) => {
    const a = before.find((l) => l.node.id === id),
      b = after.find((l) => l.node.id === id);
    return !!a && !!b && stableJson(a.node) === stableJson(b.node) && stableJson(a.matrix) === stableJson(b.matrix);
  });
}
export const REVISION_DROPPED_MESSAGE =
  '项目文件刚在外部修改，拖动的图层也随之改变：已刷新到最新版本，这次拖动没有保存，请重新拖动。';
/**
 * Commit an edit made against `revision`. When the project changed underneath it (an external
 * file save, a hot reload) the service answers REVISION_CONFLICT. Then the client reloads the
 * state once and, if `unchanged` confirms the edited layers are exactly as the edit saw them,
 * re-sends the same edit on the new revision. Otherwise the edit is dropped with a notice and
 * the panels show the refreshed project. Any other failure is reported like `run` does.
 */
export async function commitWithRevisionRetry(
  store: WorkbenchStore,
  method: string,
  build: (revision: string | undefined) => unknown,
  revision: string | undefined,
  unchanged: (fresh: ApplicationState) => Promise<boolean>,
  client: RpcClient = rpc,
): Promise<{ result?: unknown; retried?: boolean; dropped?: boolean }> {
  const report = (error: unknown) =>
    store.dispatch({
      type: 'patch',
      slice: 'diagnostics',
      patch: { error: error instanceof Error ? error.message : String(error) },
    });
  const accept = (result: unknown) => {
    const previous = store.getSnapshot().project.state;
    const state = mergeApplicationState(previous, result);
    if (state !== previous) store.dispatch({ type: 'patch', slice: 'project', patch: { state } });
    return result;
  };
  store.dispatch({ type: 'patch', slice: 'diagnostics', patch: { error: '' } });
  try {
    return { result: accept(await client(method, build(revision))) };
  } catch (error) {
    if (!isRevisionConflict(error)) {
      report(error);
      return {};
    }
  }
  try {
    const fresh = (await client('state')) as ApplicationState;
    store.dispatch({ type: 'patch', slice: 'project', patch: { state: fresh } });
    if (!(await unchanged(fresh))) {
      report(REVISION_DROPPED_MESSAGE);
      return { dropped: true };
    }
    return { result: accept(await client(method, build(fresh.snapshot.revision))), retried: true };
  } catch (error) {
    report(isRevisionConflict(error) ? REVISION_DROPPED_MESSAGE : error);
    return { dropped: isRevisionConflict(error) };
  }
}
export function subscribeWorkbench(store: WorkbenchStore, events: EventSource) {
  events.onmessage = (event) => {
    try {
      const value: z.infer<typeof update> = update.parse(JSON.parse(event.data));
      if (value.kind === 'change') {
        const state = mergeApplicationState(store.getSnapshot().project.state, value.state);
        store.dispatch({ type: 'patch', slice: 'project', patch: { state } });
      } else if (value.kind === 'agents') {
        const previous = store.getSnapshot().project.state;
        if (previous && value.agents && typeof value.agents === 'object')
          store.dispatch({
            type: 'patch',
            slice: 'project',
            patch: {
              state: { ...previous, agents: value.agents as ApplicationState['agents'] },
            },
          });
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
  agents: z.unknown().optional(),
});
