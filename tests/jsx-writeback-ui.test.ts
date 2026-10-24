import { describe, it, expect } from 'vitest';
import { runWriteBack, type WriteBackPhase } from '../src/editor/jsx-writeback-run.js';

describe('写回源码 apply (bug: button stuck on 写回中…, ~90 s apply)', () => {
  it('plans then applies once, without a separate preflight round trip, reporting phases', async () => {
    const calls: string[] = [],
      phases: WriteBackPhase[] = [];
    const call = async (method: string) => {
      calls.push(method);
      if (method === 'jsxWriteBackPlan')
        return { summary: { written: 2, file: 'components/opener.tsx' }, apply: { planId: 'p' } };
      return { applied: true };
    };
    let planned: unknown;
    const result = await runWriteBack(call, { sceneId: 's', nodeId: 'opener' }, (p) => phases.push(p), (s) => (planned = s));
    expect(calls).toEqual(['jsxWriteBackPlan', 'projectApply']);
    expect(phases).toEqual(['planning', 'applying']);
    expect(planned).toEqual({ written: 2, file: 'components/opener.tsx' });
    expect(result).toEqual({ applied: true, written: 2, file: 'components/opener.tsx' });
  });
  it('stops after planning when nothing changes and propagates apply failures', async () => {
    const calls: string[] = [];
    expect(
      await runWriteBack(async (m) => (calls.push(m), { unchanged: true }), { sceneId: 's', nodeId: 'o' }, () => {}),
    ).toEqual({ applied: false });
    expect(calls).toEqual(['jsxWriteBackPlan']);
    await expect(
      runWriteBack(
        async (m) => {
          if (m === 'projectApply') throw new Error('Preflight failed; no project changes saved');
          return { apply: {}, summary: { written: 1 } };
        },
        { sceneId: 's', nodeId: 'o' },
        () => {},
      ),
    ).rejects.toThrow('Preflight failed');
  });
});
