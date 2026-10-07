import { z } from 'zod';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import {
  builtinMotions,
  motionTemplateSchema,
  applyMotionCues,
  applyMotionLayers,
  mergeMotionParameters,
  type MotionTemplate,
} from '../core/motion-template.js';
import {
  parameterJsonSchema,
  resolveParameters,
  type ParameterDefinitions,
} from '../core/parameters.js';
import { contextFramesSchema } from '../core/content-time.js';
import { evaluateNode } from '../core/time.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { Renderer } from '../core/renderer.js';
import { animationNode } from './animation.js';
import { applyOperations } from './operations.js';
import { hash } from './project.js';
const file = z
    .string()
    .regex(/^components\/motions\/(?:[\p{L}\p{N}_-]+\/)*[\p{L}\p{N}_-]+\.json$/u),
  finite = z.number().finite(),
  builtin = z.enum(['fadeSlide', 'fadeOut', 'pop', 'pulse', 'wipeText']),
  reference = z.union([
    z.object({ builtin }).strict(),
    z.object({ file }).strict(),
    motionTemplateSchema,
  ]);
export const motionTemplatesSchema = z
  .object({
    source: z.union([z.object({ builtin }).strict(), z.object({ file }).strict()]).optional(),
    includeTemplate: z.boolean().default(false),
  })
  .strict();
export const motionPlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    units: z.enum(['frames', 'seconds']).default('frames'),
    collision: z.enum(['error', 'replaceChannels', 'merge']).default('error'),
    basis: z.enum(['static', 'evaluated']).default('static'),
    output: z.enum(['keys', 'layers']).default('keys'),
    saveTemplates: z
      .array(
        z
          .object({
            file,
            template: motionTemplateSchema,
            expectedHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .nullable()
              .default(null),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    cues: z
      .array(
        z
          .object({
            id: z.string().min(1).max(100),
            template: reference,
            parameters: z.record(z.unknown()).default({}),
            start: finite.nonnegative(),
            duration: finite.positive(),
            blend: z.enum(['add', 'multiply', 'replace']).optional(),
            weight: finite.min(0).max(1).optional(),
            window: z.boolean().optional(),
            valueBasis: z.enum(['source', 'neutral']).optional(),
            before: z.enum(['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong']).optional(),
            after: z.enum(['constant', 'linear', 'cycle', 'cycleOffset', 'pingpong']).optional(),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    targets: z
      .array(
        z
          .object({
            sceneId: z.string(),
            nodeId: z.string(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: contextFramesSchema.default([]),
            referenceFrame: finite.nonnegative().default(0),
            offset: finite.nonnegative().default(0),
            bindings: z.record(z.record(z.unknown())).default({}),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
function resolveTemplate(
  snapshot: Snapshot,
  ref: z.output<typeof reference>,
): { template: MotionTemplate; source: string; hash?: string } {
  if ('builtin' in ref)
    return { template: builtinMotions[ref.builtin], source: `builtin:${ref.builtin}` };
  if ('file' in ref) {
    const content = snapshot.files[ref.file];
    if (content === undefined)
      throw new VmotionError('MOTION_TEMPLATE_MISSING', 'Motion template resource not found', {
        file: ref.file,
      });
    return {
      template: motionTemplateSchema.parse(JSON.parse(content)),
      source: ref.file,
      hash: hash(content),
    };
  }
  return { template: motionTemplateSchema.parse(ref), source: 'inline' };
}
export function motionTemplates(snapshot: Snapshot, raw: unknown = {}) {
  const request = motionTemplatesSchema.parse(raw),
    entries = request.source
      ? [resolveTemplate(snapshot, request.source)]
      : [
          ...Object.entries(builtinMotions).map(([name, template]) => ({
            template,
            source: `builtin:${name}`,
          })),
          ...Object.keys(snapshot.files)
            .filter((path) => file.safeParse(path).success)
            .sort()
            .map((path) => resolveTemplate(snapshot, { file: path })),
        ];
  return {
    revision: snapshot.revision,
    templates: entries.map((entry) => ({
      name: entry.template.name,
      source: entry.source,
      hash: 'hash' in entry ? entry.hash : undefined,
      parameters: entry.template.parameters,
      parameterSchema: parameterJsonSchema({
        type: 'object',
        properties: entry.template.parameters as ParameterDefinitions,
      }),
      channels: entry.template.channels.map((channel) => ({
        property: channel.property,
        keys: channel.keys.length,
      })),
      types: entry.template.types,
      ...(request.includeTemplate ? { template: entry.template } : {}),
    })),
    workflow:
      'Use motion_plan with cue IDs, parameter bindings and targets across scenes. Templates compile to editable native keys. Preflight the unchanged stored candidate and apply for one undo. JSON updates do not silently rewrite previously applied keys.',
  };
}
export async function planMotion(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>,
) {
  const request = motionPlanSchema.parse(raw);
  if (
    request.output === 'keys' &&
    request.cues.some((c) =>
      ['blend', 'weight', 'window', 'valueBasis', 'before', 'after'].some(
        (field) => (c as any)[field] !== undefined,
      ),
    )
  )
    throw new VmotionError('MOTION_OPTIONS', 'Layer cue options require output=layers');
  if (request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before motion planning', {
      expected: request.revision,
      actual: snapshot.revision,
    });
  const names = request.cues.map((cue) => cue.id);
  if (new Set(names).size !== names.length)
    throw new VmotionError('MOTION_CUE', 'Cue IDs must be unique');
  if (
    new Set(request.saveTemplates.map((entry) => entry.file)).size !== request.saveTemplates.length
  )
    throw new VmotionError('MOTION_TEMPLATE', 'Save each template once');
  let candidate = structuredClone(snapshot);
  const files = request.saveTemplates.map((entry) => ({
    type: 'replace' as const,
    path: entry.file,
    expectedHash: entry.expectedHash,
    content: JSON.stringify(entry.template, null, 2) + '\n',
  }));
  if (files.length)
    candidate = applyOperations(root, candidate, [{ type: 'editFiles', edits: files }]);
  const sources = request.cues.map((cue) => resolveTemplate(candidate, cue.template)),
    seen = new Set<string>(),
    layers = [],
    samples = [];
  for (const target of request.targets) {
    const key = JSON.stringify([target.sceneId, target.path, target.nodeId]);
    if (seen.has(key)) throw new VmotionError('MOTION_TARGET', 'A motion target must appear once');
    seen.add(key);
    if (Object.keys(target.bindings).some((name) => !names.includes(name)))
      throw new VmotionError('MOTION_BINDING', 'Unknown cue ID in target bindings', {
        nodeId: target.nodeId,
      });
    const scope = await renderer.inspectComposition(
        candidate,
        target.sceneId,
        target.referenceFrame,
        target.path,
        target.contextFrames,
      ),
      node = await animationNode(
        renderer,
        candidate,
        target.sceneId,
        target.path,
        target.nodeId,
        target.referenceFrame,
        target.contextFrames,
      ),
      compiled = (request.output === 'layers' ? applyMotionLayers : applyMotionCues)(
        node,
        request.cues.map((cue, index) => ({
          id: cue.id,
          template: sources[index].template,
          parameters: mergeMotionParameters(cue.parameters, target.bindings[cue.id] ?? {}),
          start: cue.start + target.offset,
          duration: cue.duration,
          blend: cue.blend,
          weight: cue.weight,
          window: cue.window,
          valueBasis: cue.valueBasis,
          before: cue.before,
          after: cue.after,
        })),
        {
          fps: snapshot.project.fps.num / snapshot.project.fps.den,
          units: request.units,
          collision: request.collision,
          referenceFrame: target.referenceFrame,
          basis: request.basis,
        },
      );
    if (
      target.referenceFrame >= scope.scene.duration ||
      compiled.cues.some((cue) => cue.end >= scope.scene.duration)
    )
      throw new VmotionError(
        'MOTION_RANGE',
        'Motion keys must fit inside the local composition duration',
        { nodeId: target.nodeId, duration: scope.scene.duration, cues: compiled.cues },
      );
    if (node.type === 'component' && node.component) {
      const metadata = await renderer.components.describe(candidate, node.component);
      if (compiled.channels.some((property) => property.startsWith('params.')))
        for (const frame of compiled.poseChecks.frames)
          resolveParameters(metadata.parameters, evaluateNode(compiled.node, frame).params);
    }
    candidate = applyOperations(
      root,
      candidate,
      await edit(candidate, target.sceneId, target.referenceFrame, [
        {
          nodeId: target.nodeId,
          path: target.path,
          contextFrames: target.contextFrames,
          frame: target.referenceFrame,
          patch: {
            animations: compiled.node.animations,
            ...(request.output === 'layers'
              ? { animationLayers: compiled.node.animationLayers }
              : {}),
            ...(node.type === 'component' ? { params: compiled.node.params } : {}),
          },
        },
      ]),
    );
    layers.push({
      sceneId: target.sceneId,
      nodeId: target.nodeId,
      path: target.path,
      contextFrames: target.contextFrames,
      referenceFrame: target.referenceFrame,
      cues: compiled.cues,
      channels: compiled.channels,
      poseChecks: compiled.poseChecks,
      output: request.output,
    });
    for (const cue of compiled.cues)
      for (const frame of [cue.start, Math.floor((cue.start + cue.end) / 2), cue.end])
        samples.push({
          sceneId: target.sceneId,
          path: target.path,
          contextFrames: target.contextFrames,
          frame,
        });
  }
  const unique = [...new Map(samples.map((sample) => [JSON.stringify(sample), sample])).values()],
    sceneIds = [...new Set(request.targets.map((target) => target.sceneId))],
    operations: Operation[] = [
      ...(files.length ? [{ type: 'editFiles' as const, edits: files }] : []),
      ...sceneIds.map((sceneId) => ({
        type: 'updateScene' as const,
        sceneId,
        patch: { nodes: candidate.scenes.find((scene) => scene.id === sceneId)!.nodes },
      })),
    ];
  const scopeSamples = new Map<string, (typeof unique)[number]>();
  for (const sample of unique) {
    const key = JSON.stringify([sample.sceneId, sample.path, sample.contextFrames]);
    if (!scopeSamples.has(key)) scopeSamples.set(key, sample);
  }
  const selected = [...scopeSamples.values(), ...unique]
    .filter(
      (sample, index, array) =>
        array.findIndex((other) => JSON.stringify(other) === JSON.stringify(sample)) === index,
    )
    .slice(0, 12);
  return {
    request,
    candidate,
    operations,
    layers,
    sources: sources.map(({ source, hash }) => ({ source, hash })),
    samples: selected,
    coverage: {
      proposed: unique.length,
      selected: selected.length,
      omitted: unique.length - selected.length,
      incomplete: unique.length > selected.length,
    },
    savedTemplates: request.saveTemplates.map((entry) => ({
      file: entry.file,
      hash: hash(JSON.stringify(entry.template, null, 2) + '\n'),
    })),
  };
}
