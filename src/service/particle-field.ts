import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import { particleFieldSchema, particleState, particleField } from '../core/particle-field.js';
import {
  newNode,
  effectSchema,
  VmotionError,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import { nodeMatrix, transform } from '../core/interaction.js';
import type { Renderer } from '../core/renderer.js';
import { compositionStructure } from './structure.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
export const particlesInspectSchema = z
  .object({
    settings: particleFieldSchema.default({}),
    time: z.number().finite().min(0).max(1e9),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(0).max(200).default(20),
  })
  .strict();
export const particlesPlanSchema = z
  .object({
    revision: z.string(),
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
    nodeId: z.string().min(1).max(100).optional(),
    name: z.string().min(1).max(200).default('粒子场'),
    settings: z.record(z.unknown()).default({}),
    effects: z.array(effectSchema).max(16).default([]),
    width: z.number().int().min(16).max(3840).optional(),
    height: z.number().int().min(16).max(2160).optional(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export function inspectParticles(raw: unknown) {
  const request = particlesInspectSchema.parse(raw),
    state = particleState(request.settings, request.time),
    nodes = particleField('particle', { seconds: request.time }, state.config);
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const node of nodes) {
    const matrix = nodeMatrix(node);
    for (const point of [
      { x: 0, y: 0 },
      { x: node.width, y: 0 },
      { x: node.width, y: node.height },
      { x: 0, y: node.height },
    ]) {
      const p = transform(matrix, point);
      x = Math.min(x, p.x);
      y = Math.min(y, p.y);
      right = Math.max(right, p.x);
      bottom = Math.max(bottom, p.y);
    }
  }
  return {
    settings: state.config,
    time: state.time,
    live: state.records.length,
    candidates: state.candidates,
    examined: state.examined,
    truncated: state.truncated,
    bounds: state.records.length ? { x, y, width: right - x, height: bottom - y } : null,
    particles: state.records.slice(request.offset, request.offset + request.limit),
    limits: { maxAlive: 2000, scanCandidates: 16384 },
    units:
      'Seconds for birth/lifetime, local pixels for geometry, pixels/second for velocity. Bounds exclude effects and ancestor transforms. Seed and emission schedule define stable birth IDs.',
  };
}
export async function planParticles(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = particlesPlanSchema.parse(raw);
  if (request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before emitter planning');
  const scope = await renderer.inspectComposition(
      snapshot,
      request.sceneId,
      request.frame,
      request.path,
      request.contextFrames,
    ),
    id = request.nodeId ?? 'particles-' + randomUUID(),
    width = request.width ?? scope.width,
    height = request.height ?? scope.height,
    settings = particleFieldSchema.parse({
      ...request.settings,
      origin: request.settings.origin ?? { x: width / 2, y: height * 0.65 },
    }),
    file = `components/particles/${randomUUID()}.ts`,
    content =
      "import {defineComponent,particleField,particleFieldParameters} from '@vmotion/sdk';\nexport default defineComponent({name:'Particle field',parameters:particleFieldParameters,render(ctx,params){return particleField('particle',ctx,params);}});\n",
    operations: Operation[] = [
      { type: 'editFiles', edits: [{ type: 'replace', path: file, expectedHash: null, content }] },
    ];
  if (request.frame >= scope.scene.duration)
    throw new VmotionError('FRAME_RANGE', 'Emitter frame must lie within the local composition');
  let candidate = applyOperations(root, snapshot, operations);
  const node = newNode({
      id,
      type: 'component',
      name: request.name,
      component: file,
      width,
      height,
      params: settings,
      effects: request.effects,
    }),
    created = await compositionStructure(
      renderer,
      candidate,
      request.sceneId,
      request.frame,
      request.path,
      { type: 'add', node },
      request.contextFrames,
    );
  operations.push(...created.operations);
  candidate = applyOperations(root, candidate, created.operations);
  const fps = snapshot.project.fps.num / snapshot.project.fps.den,
    duration = scope.scene.duration,
    frames = [
      ...new Set([
        request.frame,
        Math.min(duration - 1, Math.round((settings.start + 0.25) * fps)),
        Math.min(duration - 1, Math.round((settings.start + settings.lifetime.max * 0.5) * fps)),
      ]),
    ],
    input = {
      revision: snapshot.revision,
      operations,
      samples: frames.map((frame) => ({
        sceneId: request.sceneId,
        path: request.path,
        contextFrames: request.contextFrames,
        frame,
      })),
      width: 320,
      determinism: true,
      visual: true,
    },
    stored = request.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    nodeId: created.selection[0],
    source: file,
    settings,
    preview: inspectParticles({ settings, time: frames[1] / fps, limit: 0 }),
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
  };
}
