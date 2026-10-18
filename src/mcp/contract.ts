import { resolveAgentPlan, storeAgentPlan } from '../service/agent-plans.js';
import type { ToolDefinition } from './tool-definition.js';

/**
 * Uniform agent contract for capabilities that plan or write.
 *
 * Planner (effect=plan, or a write tool called with mode=plan):
 *   { committed:false, effect:'plan', plan:{ planId, candidateRevision, summary, samples? }, next, ... }
 *   The candidate is always stored with storeAgentPlan, so the next step is always
 *   project_preflight({planId}) then project_apply({planId}). Exact operations/files are inlined in
 *   plan.operations/plan.files only with detail:true (or response=full).
 *   Legacy fields (candidate/apply with inline payloads or planIds) stay for one version and are
 *   listed in `deprecated`.
 * Write (effect=write): { committed:true|false, effect:'write', next, ... }.
 */
type JsonRecord = Record<string, unknown>;
const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === 'object' && value !== null && !Array.isArray(value);
export const deprecatedPlanFields = ['candidate', 'apply'] as const;
const PLAN_NEXT =
  'project_preflight({planId}) then project_apply({planId}); visual:false or samples:false skips sample renders.';

function bounded(value: unknown, limit = 600): unknown {
  if (value === undefined) return undefined;
  if (typeof value === 'string') return value.length > 240 ? value.slice(0, 240) + '…' : value;
  const json = JSON.stringify(value);
  if (json === undefined) return undefined;
  if (json.length <= limit) return value;
  if (Array.isArray(value)) return { items: value.length, truncated: true };
  if (isRecord(value)) return { keys: Object.keys(value).slice(0, 24), truncated: true };
  return undefined;
}
function planIdOf(result: JsonRecord): string | undefined {
  for (const source of [result.plan, result.candidate, result.apply, result])
    if (
      isRecord(source) &&
      typeof source.planId === 'string' &&
      /^[a-f0-9]{64}$/.test(source.planId)
    )
      return source.planId;
  return undefined;
}
function inlineCandidate(result: JsonRecord): JsonRecord | undefined {
  if (isRecord(result.candidate) && result.candidate.planId === undefined) return result.candidate;
  if (isRecord(result.apply) && result.apply.planId === undefined) {
    const { expectedCandidateRevision: _ignored, ...rest } = result.apply;
    return rest;
  }
  return undefined;
}
function sampleList(content: JsonRecord | undefined) {
  if (!content || !Array.isArray(content.samples) || !content.samples.length) return undefined;
  return content.samples
    .slice(0, 12)
    .filter(isRecord)
    .map((sample) => ({
      ...(sample.sceneId !== undefined ? { sceneId: sample.sceneId } : {}),
      ...(sample.sequenceId !== undefined ? { sequenceId: sample.sequenceId } : {}),
      ...(Array.isArray(sample.path) && sample.path.length ? { path: sample.path } : {}),
      frame: sample.frame,
    }));
}

export async function planContract(
  tool: ToolDefinition,
  result: unknown,
  options: { root?: string; detail?: boolean } = {},
): Promise<unknown> {
  if (!isRecord(result)) return result;
  const legacy = deprecatedPlanFields.filter((key) => Object.hasOwn(result, key)),
    priorNext = typeof result.next === 'string' ? result.next : undefined;
  // Non-project planners (cache_plan → cache_apply) keep their own consumer.
  if (tool.applyWith) {
    const planId = planIdOf(result),
      { next: _next, ...own } = result;
    return {
      committed: false,
      effect: 'plan',
      ...(planId
        ? {
            plan: {
              planId,
              summary: bounded(result.summary) ?? {
                files: Array.isArray(result.files) ? result.files.length : undefined,
                bytes: result.bytes,
              },
            },
          }
        : {}),
      next: planId ? `${tool.applyWith}({planId})` : (priorNext ?? 'Nothing to apply.'),
      ...own,
      ...(planId && isRecord(result.plan) ? { plan: { ...result.plan, planId } } : {}),
      ...(legacy.length ? { deprecated: legacy } : {}),
    };
  }
  let planId = planIdOf(result),
    content: JsonRecord | undefined;
  const inline = planId ? undefined : inlineCandidate(result);
  if (!planId && inline && options.root) {
    const stored = await storeAgentPlan(options.root, inline);
    planId = stored.planId;
    content = inline;
  } else if (planId && options.root) {
    try {
      content = (await resolveAgentPlan(options.root, { planId })) as JsonRecord;
    } catch {
      content = undefined;
    }
  } else content = inline;
  if (!planId)
    return {
      committed: false,
      effect: 'plan',
      ...result,
      next:
        priorNext ??
        (result.unchanged
          ? 'No changes were planned; nothing to apply.'
          : 'No candidate was produced.'),
    };
  const candidateRevision =
      (typeof result.candidateRevision === 'string' ? result.candidateRevision : undefined) ??
      (isRecord(result.apply) && typeof result.apply.expectedCandidateRevision === 'string'
        ? result.apply.expectedCandidateRevision
        : undefined) ??
      (isRecord(result.plan) && typeof result.plan.candidateRevision === 'string'
        ? result.plan.candidateRevision
        : undefined),
    operations = Array.isArray(content?.operations) ? content.operations : [],
    files = Array.isArray(content?.files) ? content.files : [],
    samples = sampleList(content),
    extra = bounded(result.summary);
  const summary = {
    operations: operations.length,
    ...(files.length ? { files: files.length } : {}),
    ...(Array.isArray(content?.assetChecks) && content.assetChecks.length
      ? { assetChecks: content.assetChecks.length }
      : {}),
    ...(extra === undefined ? {} : { detail: extra }),
  };
  const plan = {
    ...(isRecord(result.plan) ? result.plan : {}),
    planId,
    candidateRevision,
    ...(typeof result.baseRevision === 'string' ? { baseRevision: result.baseRevision } : {}),
    summary,
    ...(samples ? { samples } : {}),
    ...(options.detail ? { operations, ...(files.length ? { files } : {}) } : {}),
  };
  const { plan: _old, next: _next, ...rest } = result;
  return {
    committed: false,
    effect: 'plan',
    plan,
    next: priorNext ? `${PLAN_NEXT} ${priorNext}` : PLAN_NEXT,
    ...rest,
    ...(legacy.length ? { deprecated: legacy } : {}),
  };
}

export function writeContract(tool: ToolDefinition, raw: unknown, result: unknown): unknown {
  if (!isRecord(result)) return result;
  const committed =
    tool.method === 'projectApply'
      ? result.applied === true
      : tool.method !== 'selection' &&
        isRecord(raw) &&
        (isRecord(raw.snapshot) || typeof raw.canUndo === 'boolean');
  const next =
    typeof result.next === 'string'
      ? result.next
      : committed
        ? 'project_undo reverts this step.'
        : tool.method === 'projectApply'
          ? 'Nothing was committed; fix diagnostics and preflight again.'
          : 'No project commit.';
  return { committed, effect: 'write', ...result, next };
}
