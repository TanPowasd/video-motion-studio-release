import { storeAgentPlan } from '../service/agent-plans.js';
import type { PreflightRequest } from '../service/preflight.js';

/** Keep the reviewed payload and public plan metadata intact while sharing delivery/undo. */
export async function builtinCandidate<T extends Record<string, unknown>>(
  root: string,
  input: PreflightRequest,
  candidateRevision: string,
  delivery: 'stored' | 'inline',
  metadata: T,
) {
  const stored = delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: input.revision,
    candidateRevision,
    ...metadata,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidateRevision,
    },
  };
}
