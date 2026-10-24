/*
 * "写回源码" apply sequence, separated from the React panel so it is testable.
 *
 * plan (fresh, stored) -> projectApply. projectApply already runs the same preflight
 * (typecheck, component validation, determinism + visual samples) before it commits and
 * refuses invalid candidates, so the panel no longer runs a separate projectPreflight
 * first: that doubled the slowest part of the round trip. Progress is reported per phase.
 */
export type WriteBackPhase = 'idle' | 'planning' | 'applying';
export const writeBackPhaseLabel: Record<WriteBackPhase, string> = {
  idle: '',
  planning: '检查覆盖…',
  applying: '写入并验证…',
};
type Call = (method: string, params?: unknown) => Promise<unknown>;
type Plan = {
  unchanged?: boolean;
  summary?: { written: number; file?: string };
  apply?: unknown;
};
export async function runWriteBack(
  call: Call,
  request: { sceneId: string; nodeId: string; ids?: string[] },
  onPhase: (phase: WriteBackPhase) => void,
  /** Called with the verified plan summary right before it is applied. */
  onPlanned?: (summary: { written?: number; file?: string }) => void,
): Promise<{ written?: number; file?: string; applied: boolean }> {
  onPhase('planning');
  const fresh = (await call('jsxWriteBackPlan', request)) as Plan;
  if (fresh.unchanged || !fresh.apply) return { applied: false };
  onPlanned?.(fresh.summary ?? {});
  onPhase('applying');
  const result = (await call('projectApply', fresh.apply)) as { applied?: boolean };
  return {
    applied: result?.applied !== false,
    written: fresh.summary?.written ?? 0,
    file: fresh.summary?.file,
  };
}
