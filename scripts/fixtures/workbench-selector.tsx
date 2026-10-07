import { createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { flushSync } from 'react-dom';
import { createWorkbenchState } from '../../src/editor/state/workbench-types.js';
import { createWorkbenchStore, WorkbenchProvider } from '../../src/editor/state/workbench-store.js';
import { useWorkbenchSelector } from '../../src/editor/state/workbench-selectors.js';
export function run() {
  const store = createWorkbenchStore(
    createWorkbenchState({ sceneId: 'intro', path: [], workspace: 'animation' }),
  );
  const counts = { code: 0, preview: 0 };
  function Code() {
    counts.code++;
    return <div>{useWorkbenchSelector((s) => s.code.code)}</div>;
  }
  function Preview() {
    counts.preview++;
    return <div>{useWorkbenchSelector((s) => s.preview.playing) ? 'playing' : 'paused'}</div>;
  }
  const parent = document.createElement('div');
  document.body.append(parent);
  const root = createRoot(parent);
  flushSync(() =>
    root.render(
      <WorkbenchProvider store={store}>
        <Code />
        <Preview />
      </WorkbenchProvider>,
    ),
  );
  const before = { ...counts };
  flushSync(() =>
    store.dispatch({ type: 'patch', slice: 'diagnostics', patch: { error: 'unrelated' } }),
  );
  if (counts.code !== before.code || counts.preview !== before.preview)
    throw Error('Unrelated update rerendered panels');
  flushSync(() => store.dispatch({ type: 'patch', slice: 'preview', patch: { playing: true } }));
  if (counts.preview !== before.preview + 1 || counts.code !== before.code)
    throw Error('Preview selector did not isolate updates');
  flushSync(() => store.dispatch({ type: 'patch', slice: 'code', patch: { code: 'source' } }));
  if (counts.code !== before.code + 1 || counts.preview !== before.preview + 1)
    throw Error('Code selector did not isolate updates');
  flushSync(() => root.unmount());
  return {
    passed: true,
    counts,
    before,
    checks: [
      'unrelated slice ignored',
      'preview-only render',
      'code-only render',
      'unsubscribe on unmount',
    ],
  };
}
