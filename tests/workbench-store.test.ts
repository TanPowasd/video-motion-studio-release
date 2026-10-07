import { it, expect, vi } from 'vitest';
import { createWorkbenchState } from '../src/editor/state/workbench-types.js';
import { createWorkbenchStore } from '../src/editor/state/workbench-store.js';
import { workbenchReducer } from '../src/editor/state/workbench-reducer.js';
import { createWorkbenchCommands } from '../src/editor/state/workbench-effects.js';
import type { RpcClient } from '../src/editor/state/rpc-client.js';
const initial = () => createWorkbenchState({ sceneId: 'intro', path: [], workspace: 'animation' });
it('changes only the requested slice and preserves pure no-op/reducer snapshots', () => {
  const before = initial();
  Object.freeze(before);
  Object.freeze(before.selection);
  const selected = workbenchReducer(before, {
    type: 'patch',
    slice: 'selection',
    patch: { selectedIds: ['label', 'particle'] },
  });
  expect(selected.selection.selectedIds).toEqual(['label', 'particle']);
  expect(before.selection.selectedIds).toEqual([]);
  expect(selected.code).toBe(before.code);
  expect(selected.preview).toBe(before.preview);
  expect(
    workbenchReducer(selected, {
      type: 'patch',
      slice: 'selection',
      patch: { selectedIds: selected.selection.selectedIds },
    }),
  ).toBe(selected);
  const route = workbenchReducer(selected, {
    type: 'patch',
    slice: 'route',
    patch: { sceneId: 'other', focusPath: ['group'], focusContextFrames: [10] },
  });
  expect(route.route.focusPath).toEqual(['group']);
  expect(route.selection).toBe(selected.selection);
  const playing = workbenchReducer(route, {
    type: 'patch',
    slice: 'preview',
    patch: { playing: true, sequenceFrame: 30 },
  });
  expect(playing.preview.playing).toBe(true);
  expect(playing.route).toBe(route.route);
});
it('notifies once per change, isolates listeners and supports unsubscribe', () => {
  const store = createWorkbenchStore(initial()),
    called = vi.fn(),
    off = store.subscribe(called);
  store.dispatch({ type: 'patch', slice: 'diagnostics', patch: { error: '' } });
  expect(called).not.toHaveBeenCalled();
  store.dispatch({ type: 'patch', slice: 'diagnostics', patch: { error: 'invalid' } });
  expect(called).toHaveBeenCalledTimes(1);
  off();
  store.dispatch({ type: 'patch', slice: 'tasks', patch: { saving: true } });
  expect(called).toHaveBeenCalledTimes(1);
});
it('routes commands/errors through the store and keeps unrelated state references', async () => {
  const store = createWorkbenchStore(initial());
  const code = store.getSnapshot().code;
  const call = vi.fn(async () => {
    throw Error('revision changed');
  }) as RpcClient;
  const run = createWorkbenchCommands(store, call);
  expect(await run('state')).toBeUndefined();
  expect(store.getSnapshot().diagnostics.error).toBe('revision changed');
  expect(store.getSnapshot().code).toBe(code);
});
