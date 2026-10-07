import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { transitionStyles } from '../sdk/transitions.js';
import {
  VmotionError,
  sceneSchema,
  clipSchema,
  newNode,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
import { validateSnapshot, safePath } from './project.js';
export const transitionPlanSchema = z
  .object({
    revision: z.string().optional(),
    items: z
      .array(
        z
          .object({
            fromSceneId: z.string(),
            toSceneId: z.string(),
            sceneId: z.string().optional(),
            name: z.string().default('转场合成'),
            style: z.enum(transitionStyles).default('crossfade'),
            direction: z.enum(['left', 'right', 'up', 'down']).default('left'),
            duration: z.number().int().min(2).max(3600).default(30),
            width: z.number().int().min(16).max(3840).optional(),
            height: z.number().int().min(16).max(2160).optional(),
            fromOffset: z.number().finite().default(0),
            toOffset: z.number().finite().default(0),
            placement: z
              .object({
                sequenceId: z.string().optional(),
                trackId: z.string(),
                at: z.number().int().nonnegative(),
                extendSequence: z.boolean().default(false),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
  })
  .strict();
export async function planTransitions(root: string, snapshot: Snapshot, raw: unknown) {
  const request = transitionPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before transition planning');
  let candidate = structuredClone(snapshot);
  const operations: Operation[] = [],
    scenes = [],
    samples = [];
  for (const item of request.items) {
    for (const source of [item.fromSceneId, item.toSceneId])
      if (!candidate.scenes.some((s) => s.id === source))
        throw new VmotionError('MISSING_SCENE', 'Transition source not found', { sceneId: source });
    const id = item.sceneId ?? randomUUID();
    if (candidate.scenes.some((s) => s.id === id))
      throw new VmotionError(
        'TRANSITION_SCENE',
        'Choose a new transition scene ID; source scenes are preserved',
      );
    const module = `components/transitions/${encodeURIComponent(id)}.ts`;
    safePath(root, module);
    if (candidate.files[module] !== undefined)
      throw new VmotionError('TRANSITION_SOURCE', 'Transition source already exists');
    const from = JSON.stringify(item.fromSceneId),
      to = JSON.stringify(item.toSceneId),
      source = `import {defineComponent,sceneTransition,clamp,easings} from '@vmotion/sdk';export default defineComponent({name:${JSON.stringify(item.name)},parameters:{style:{type:'enum',options:${JSON.stringify(transitionStyles)},default:${JSON.stringify(item.style)}},direction:{type:'enum',options:['left','right','up','down'],default:${JSON.stringify(item.direction)}},start:{type:'number',default:0,min:0},duration:{type:'number',default:${item.duration},min:2},fromOffset:{type:'number',default:${item.fromOffset}},toOffset:{type:'number',default:${item.toOffset}},fromRate:{type:'number',default:1,min:-8,max:8},toRate:{type:'number',default:1,min:-8,max:8},color:{type:'color',default:'#101525'}},render(ctx,p){const t=easings.inOutCubic(clamp((ctx.frame-p.start)/Math.max(1,p.duration-1)));return sceneTransition({id:'mix',fromSceneId:${from},toSceneId:${to},progress:t,width:ctx.width,height:ctx.height,style:p.style,direction:p.direction,color:p.color,fromOffset:p.fromOffset,toOffset:p.toOffset,fromRate:p.fromRate,toRate:p.toRate});}});`,
      scene = sceneSchema.parse({
        id,
        name: item.name,
        duration: item.duration,
        width: item.width ?? snapshot.project.width,
        height: item.height ?? snapshot.project.height,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'transition',
            type: 'component',
            component: module,
            width: item.width ?? snapshot.project.width,
            height: item.height ?? snapshot.project.height,
            sceneDependencies: [item.fromSceneId, item.toSceneId],
          }),
        ],
      }),
      step: Operation[] = [
        { type: 'writeSource', path: module, content: source },
        { type: 'addScene', scene },
      ];
    if (item.placement) {
      const p = item.placement,
        sequenceId = p.sequenceId ?? candidate.project.activeSequence,
        sequence = candidate.sequences.find((s) => s.id === sequenceId),
        track = sequence?.tracks.find((t) => t.id === p.trackId);
      if (!sequence || !track || track.type !== 'video')
        throw new VmotionError('TRANSITION_TRACK', 'Choose an existing video track');
      if (track.locked)
        throw new VmotionError('TRACK_LOCKED', 'Transition placement track is locked');
      const end = p.at + item.duration;
      if (end > sequence.duration) {
        if (!p.extendSequence)
          throw new VmotionError(
            'TRANSITION_RANGE',
            'Transition extends beyond the sequence; extend explicitly',
          );
        step.push({ type: 'updateSequence', sequenceId, patch: { duration: end } });
      }
      step.push({
        type: 'addClip',
        sequenceId,
        trackId: track.id,
        clip: clipSchema.parse({
          id: randomUUID(),
          sceneId: id,
          start: p.at,
          duration: item.duration,
          name: item.name,
        }),
      });
    }
    candidate = applyOperations(root, candidate, step);
    operations.push(...step);
    scenes.push({
      sceneId: id,
      source: module,
      fromSceneId: item.fromSceneId,
      toSceneId: item.toSceneId,
      style: item.style,
      duration: item.duration,
    });
    for (const frame of [0, Math.floor((item.duration - 1) / 2), item.duration - 1])
      samples.push({ sceneId: id, frame });
  }
  const diagnostics = await validateSnapshot(root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Transition candidate is invalid', diagnostics);
  const input = {
      revision: snapshot.revision,
      operations,
      samples: samples.slice(0, 12),
      width: 320,
      determinism: true,
      visual: true,
    },
    plan = await storeAgentPlan(root, input);
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    scenes,
    coverage: {
      proposed: samples.length,
      selected: Math.min(12, samples.length),
      incomplete: samples.length > 12,
    },
    plan,
    candidate: { planId: plan.planId },
    apply: { planId: plan.planId, expectedCandidateRevision: candidate.revision },
    limitations: [
      'New clips are placed at explicit frames; existing clips are not implicitly trimmed or rippled.',
      'Scene visuals and content clocks are composed; scene-internal sound is not automatically routed.',
    ],
  };
}
