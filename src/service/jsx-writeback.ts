/*
 * Verified JSX source write-back: promotes literal overrides on a .tsx component layer into
 * the component source, then proves the candidate renders the same generated nodes as the
 * current project (at sampled frames). Props whose source literal would not reproduce the
 * override — expression-driven attributes, flex/grid-positioned boxes, values a parent
 * component recomputes — stay as overrides and are reported per prop.
 */
import { z } from 'zod';
import type { Renderer } from '../core/renderer.js';
import { VmotionError, type Node, type Snapshot } from '../core/model.js';
import { planJsxWriteBack, type WriteBackPlan } from '../core/jsx-writeback.js';
import { applyOperations } from './operations.js';

export const jsxWriteBackSchema = z
  .object({
    sceneId: z.string().min(1),
    nodeId: z.string().min(1).describe('Component layer whose overrides go into its .tsx source'),
    ids: z.array(z.string().min(1)).max(500).optional().describe('Generated node IDs (default: all overridden)'),
    props: z.array(z.string().min(1)).max(100).optional().describe('Limit to these props'),
    frames: z.array(z.number().int().nonnegative()).max(8).optional().describe('Verification frames'),
    revision: z.string().optional(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export type JsxWriteBackRequest = z.input<typeof jsxWriteBackSchema>;

export type PropStatus =
  | 'written'
  | 'computed'
  | 'layout'
  | 'changed-output'
  | 'non-literal-value'
  | 'spread'
  | 'no-target'
  | 'ambiguous'
  | 'excluded';
export interface PropReport {
  id: string;
  prop: string;
  status: PropStatus;
  reason?: string;
}

const close = (a: unknown, b: unknown): boolean => {
  if (typeof a === 'number' && typeof b === 'number') return Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(a));
  return JSON.stringify(a) === JSON.stringify(b);
};
const frameSet = (snapshot: Snapshot, sceneId: string, owner: Node, frames?: number[]) => {
  if (frames?.length) return [...new Set(frames)];
  const scene = snapshot.scenes.find((s) => s.id === sceneId)!,
    start = owner.start,
    end = Math.max(start + 1, Math.min(owner.end ?? scene.duration, scene.duration));
  return [...new Set([start, Math.floor((start + end) / 2), end - 1])];
};

/**
 * Plan + verify. Returns files/operations for the normal preflight/apply path and a per-prop
 * report (status: written, computed, layout, changed-output, …).
 */
export async function planVerifiedJsxWriteBack(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: JsxWriteBackRequest,
) {
  const request = jsxWriteBackSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'The project changed; inspect the current revision and retry', {
      expected: request.revision,
      actual: snapshot.revision,
    });
  const owner = snapshot.scenes
    .find((s) => s.id === request.sceneId)
    ?.nodes.find((n) => n.id === request.nodeId);
  if (!owner) throw new VmotionError('NOT_FOUND', 'Component layer not found', request);
  const frames = frameSet(snapshot, request.sceneId, owner, request.frames);
  const base = new Map<number, Map<string, Node>>();
  for (const frame of frames)
    base.set(frame, new Map((await renderer.generatedNodes(snapshot, owner, frame)).map((n) => [n.id, n])));
  const exclude = new Map<string, PropStatus>();
  const filter = (id: string, prop: string) => {
    if (request.ids && !request.ids.includes(id)) return false;
    if (request.props && !request.props.includes(prop)) return false;
    return !exclude.has(`${id}\u0000${prop}`);
  };
  let plan: WriteBackPlan | undefined;
  for (let attempt = 0; attempt < 3; attempt++) {
    plan = planJsxWriteBack(snapshot, request.sceneId, request.nodeId, { filter });
    if (!plan.files.length) break;
    const candidate = applyOperations(root, snapshot, [
      ...plan.operations,
      { type: 'editFiles', edits: plan.files },
    ]);
    const candidateOwner = candidate.scenes
      .find((s) => s.id === request.sceneId)!
      .nodes.find((n) => n.id === request.nodeId)!;
    // Every generated node and prop must stay identical, not just the written ones: a literal
    // size on a flex item, for example, would re-flow its siblings.
    const written = new Set(plan.report.flatMap((r) => r.written.map((p) => `${r.id}\u0000${p}`)));
    const mismatched = new Set<string>();
    let elsewhere = false;
    for (const frame of frames) {
      const before = base.get(frame)!,
        after = new Map(
          (await renderer.generatedNodes(candidate, candidateOwner, frame)).map((n) => [n.id, n]),
        );
      if (before.size !== after.size) elsewhere = true;
      for (const [id, node] of before) {
        const now = after.get(id) as Record<string, unknown> | undefined;
        if (!now) {
          elsewhere = true;
          continue;
        }
        for (const [prop, value] of Object.entries(node))
          if (!close(value, now[prop])) {
            const key = `${id}\u0000${prop}`;
            if (written.has(key)) mismatched.add(key);
            else elsewhere = true;
          }
      }
    }
    if (!mismatched.size && !elsewhere) break;
    if (elsewhere && !mismatched.size)
      // Unattributable change: first drop written geometry, then everything.
      for (const key of written)
        if (attempt > 0 || /\u0000(x|y|width|height)$/.test(key)) mismatched.add(key);
    if (!mismatched.size) for (const key of written) mismatched.add(key);
    for (const key of mismatched) exclude.set(key, 'changed-output');
    plan = undefined;
  }
  if (!plan) plan = planJsxWriteBack(snapshot, request.sceneId, request.nodeId, { filter: () => false });
  const props: PropReport[] = [];
  for (const [id, override] of Object.entries(owner.overrides))
    for (const prop of Object.keys(override as Record<string, unknown>)) {
      const key = `${id}\u0000${prop}`,
        entry = plan.report.find((r) => r.id === id);
      if (exclude.has(key)) {
        props.push({
          id,
          prop,
          status: 'changed-output',
          reason:
            'A source literal would not reproduce the override (layout-positioned box, parent-driven value or a prop the component recomputes); kept as override.',
        });
        continue;
      }
      if ((request.ids && !request.ids.includes(id)) || (request.props && !request.props.includes(prop))) {
        props.push({ id, prop, status: 'excluded' });
        continue;
      }
      if (entry?.written.includes(prop)) props.push({ id, prop, status: 'written' });
      else {
        const skipped = entry?.skipped.find((s) => s.prop === prop);
        if (skipped) props.push({ id, prop, status: skipped.reason, ...(skipped.detail ? { reason: skipped.detail } : {}) });
        else if (entry?.error)
          props.push({ id, prop, status: entry.code === 'JSX_WRITEBACK_AMBIGUOUS' ? 'ambiguous' : 'no-target', reason: entry.error });
        else props.push({ id, prop, status: 'excluded' });
      }
    }
  const written = props.filter((p) => p.status === 'written').length;
  return {
    plan,
    frames,
    props,
    summary: {
      file: owner.component,
      written,
      kept: props.length - written,
      computed: props.filter((p) => p.status === 'computed' || p.status === 'layout').length,
    },
  };
}
