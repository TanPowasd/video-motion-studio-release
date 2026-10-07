import { readFile } from 'node:fs/promises';
import { hash, safePath, atomicWrite } from './project.js';
import { VmotionError } from '../core/model.js';
const immutable = new Set(['operations', 'files', 'revision', 'version', 'assetChecks']);
/** Cache a precise candidate without echoing thousands of vertices into model context. */
export async function storeAgentPlan(root: string, input: Record<string, unknown>) {
  if (input.planId !== undefined)
    throw new VmotionError('AGENT_PLAN', 'Cannot store a recursive candidate plan');
  const content = JSON.stringify(input),
    bytes = Buffer.byteLength(content);
  if (bytes > 16 * 1024 * 1024)
    throw new VmotionError('AGENT_PLAN_LIMIT', 'Stored candidate exceeds 16MB');
  const id = hash(content),
    file = safePath(root, `.vmotion/agent-plans/${id}.json`);
  await atomicWrite(file, content);
  return { planId: id, bytes, file };
}
export async function resolveAgentPlan(root: string, input: any) {
  if (!input?.planId) return input;
  if (typeof input.planId !== 'string' || !/^[a-f0-9]{64}$/.test(input.planId))
    throw new VmotionError('AGENT_PLAN', 'Plan ID must be a SHA-256 hash');
  let text: string;
  try {
    text = await readFile(safePath(root, `.vmotion/agent-plans/${input.planId}.json`), 'utf8');
  } catch {
    throw new VmotionError('AGENT_PLAN_MISSING', 'Candidate plan was not found; regenerate it', {
      planId: input.planId,
    });
  }
  if (Buffer.byteLength(text) > 16 * 1024 * 1024 || hash(text) !== input.planId)
    throw new VmotionError(
      'AGENT_PLAN_CHANGED',
      'Stored candidate failed its content check; regenerate it',
    );
  const stored = JSON.parse(text);
  if (stored.planId !== undefined)
    throw new VmotionError('AGENT_PLAN', 'Recursive plans are not supported');
  for (const key of Object.keys(input))
    if (immutable.has(key))
      throw new VmotionError(
        'AGENT_PLAN_OVERRIDE',
        `Do not replace ${key} on a stored candidate; create a new plan`,
      );
  const { planId, ...overrides } = input;
  return { ...stored, ...overrides };
}
