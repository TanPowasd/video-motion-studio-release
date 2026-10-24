import { describe, it, expect, vi, afterEach } from 'vitest';
import { createWorkbenchState } from '../src/editor/state/workbench-types.js';
import { createWorkbenchStore } from '../src/editor/state/workbench-store.js';
import {
  commitWithRevisionRetry,
  REVISION_DROPPED_MESSAGE,
  sameLayers,
} from '../src/editor/state/workbench-effects.js';
import { RpcError, rpc, isRevisionConflict } from '../src/editor/state/rpc-client.js';

/*
 * Bug: dragging a layer right after the project files were saved externally failed with
 * "Project changed before composition editing" (REVISION_CONFLICT) and lost the drag.
 */
const store = () =>
  createWorkbenchStore(createWorkbenchState({ sceneId: 'opener', path: [], workspace: 'animation' }));
const state = (revision: string) => ({ snapshot: { revision, scenes: [] } }) as never;
const conflict = () =>
  new RpcError('Project changed before composition editing', 'REVISION_CONFLICT');

afterEach(() => vi.unstubAllGlobals());

describe('rpc client keeps the service error code', () => {
  it('throws RpcError with code and details from the error envelope', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => ({
        json: async () => ({
          error: { code: 'REVISION_CONFLICT', message: 'Project changed before composition editing' },
        }),
      })),
    );
    const error = await rpc('compositionTransactBatch', {}).catch((e) => e);
    expect(error).toBeInstanceOf(RpcError);
    expect(error.code).toBe('REVISION_CONFLICT');
    expect(error.message).toBe('Project changed before composition editing');
    expect(isRevisionConflict(error)).toBe(true);
    expect(isRevisionConflict(new Error('x'))).toBe(false);
  });
});

describe('drag commit after an external edit', () => {
  it('re-sends the same edit once on the new revision when the dragged layers are unchanged', async () => {
    const s = store(),
      sent: Array<{ method: string; revision?: string }> = [];
    const client = vi.fn(async (method: string, params?: any) => {
      if (method === 'state') return state('r2');
      sent.push({ method, revision: params?.revision });
      if (params?.revision === 'r1') throw conflict();
      return state('r3');
    });
    const unchanged = vi.fn(async () => true);
    const out = await commitWithRevisionRetry(
      s,
      'compositionTransactBatch',
      (revision) => ({ edits: [{ nodeId: 'opener/stage/title', patch: { x: 1 } }], revision }),
      'r1',
      unchanged,
      client as never,
    );
    expect(sent).toEqual([
      { method: 'compositionTransactBatch', revision: 'r1' },
      { method: 'compositionTransactBatch', revision: 'r2' },
    ]);
    expect(out.retried).toBe(true);
    expect(unchanged).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().project.state?.snapshot.revision).toBe('r3');
    expect(s.getSnapshot().diagnostics.error).toBe('');
  });
  it('drops the drag with a notice and keeps the refreshed state when the layer changed', async () => {
    const s = store(),
      sent: string[] = [];
    const client = vi.fn(async (method: string, params?: any) => {
      if (method === 'state') return state('r2');
      sent.push(params?.revision);
      throw conflict();
    });
    const out = await commitWithRevisionRetry(
      s,
      'compositionTransactBatch',
      (revision) => ({ revision }),
      'r1',
      async () => false,
      client as never,
    );
    expect(sent).toEqual(['r1']);
    expect(out).toEqual({ dropped: true });
    expect(s.getSnapshot().project.state?.snapshot.revision).toBe('r2');
    expect(s.getSnapshot().diagnostics.error).toBe(REVISION_DROPPED_MESSAGE);
  });
  it('retries only once and reports other errors unchanged', async () => {
    const s = store();
    let calls = 0;
    const always = vi.fn(async (method: string) => {
      if (method === 'state') return state('r' + ++calls);
      throw conflict();
    });
    const out = await commitWithRevisionRetry(s, 'transact', (r) => ({ r }), 'r0', async () => true, always as never);
    expect(out.dropped).toBe(true);
    expect(always.mock.calls.filter(([m]) => m === 'transact')).toHaveLength(2);
    const other = vi.fn(async () => {
      throw new RpcError('Expected 1–1000 operations', 'OPERATIONS');
    });
    expect(await commitWithRevisionRetry(s, 'transact', () => ({}), 'r0', async () => true, other as never)).toEqual({});
    expect(other).toHaveBeenCalledTimes(1);
    expect(s.getSnapshot().diagnostics.error).toBe('Expected 1–1000 operations');
  });
  it('compares dragged layers by node data (key order free) and matrix', () => {
    const layer = (node: { id: string; x: number; y: number }, matrix: number[]) => ({ node, matrix });
    const a = [layer({ id: 'n', x: 1, y: 2 }, [1, 0, 0, 1, 10, 20])];
    expect(sameLayers(a, [layer({ y: 2, x: 1, id: 'n' }, [1, 0, 0, 1, 10, 20])], ['n'])).toBe(true);
    expect(sameLayers(a, [layer({ id: 'n', x: 1, y: 2 }, [1, 0, 0, 1, 11, 20])], ['n'])).toBe(false);
    expect(sameLayers(a, [layer({ id: 'n', x: 5, y: 2 }, [1, 0, 0, 1, 10, 20])], ['n'])).toBe(false);
    expect(sameLayers(a, [], ['n'])).toBe(false);
  });
});
