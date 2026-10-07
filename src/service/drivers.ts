import { z } from 'zod';
import { expressionsSchema, layoutSchema, motionPathSchema } from '../core/driver-schema.js';
import {
  animationSchema,
  nodeSchema,
  VmotionError,
  type Snapshot,
  type Node,
  type Operation,
} from '../core/model.js';
import { compileExpression, expressionReference } from '../core/expressions.js';
import { evaluateDrivers, validateDriverSyntax, type DriverReport } from '../core/drivers.js';
import { sampleCurvePath, prepareCurvePath } from '../core/curve-path.js';
import { contextFramesSchema } from '../core/content-time.js';
import { editKeyframes } from '../core/keyframes.js';
import { keyframeSchema } from '../core/model.js';
import { applyOperations } from './operations.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
const scope = {
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
  },
  target = { ...scope, nodeId: z.string().min(1) };
export const driversInspectSchema = z
  .object({
    ...scope,
    nodeIds: z.array(z.string()).max(1000).default([]),
    revision: z.string().optional(),
    frames: z.array(z.number().finite().nonnegative()).max(60).default([]),
  })
  .strict();
export const driversPlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    targets: z
      .array(
        z
          .object({
            ...target,
            expressions: z
              .record(animationSchema.shape.property, z.string().min(1).max(4000).nullable())
              .optional(),
            resetExpressions: z.boolean().default(false),
            removeChannels: z.array(animationSchema.shape.property).max(1000).default([]),
            layout: layoutSchema.nullable().optional(),
            motionPath: motionPathSchema.nullable().optional(),
            keys: z
              .array(
                z
                  .object({
                    property: animationSchema.shape.property,
                    keys: z.array(keyframeSchema).min(1).max(10000),
                  })
                  .strict(),
              )
              .max(256)
              .default([]),
          })
          .strict(),
      )
      .min(1)
      .max(100),
  })
  .strict();
export const curvePathSchema = z
  .object({
    path: z.string().min(1).max(1e6),
    progress: z.array(z.number().finite()).min(1).max(512).default([0, 0.25, 0.5, 0.75, 1]),
    repeat: z.enum(['clamp', 'loop', 'pingpong']).default('clamp'),
  })
  .strict();
export function inspectCurve(raw: unknown) {
  const request = curvePathSchema.parse(raw),
    prepared = prepareCurvePath(request.path);
  return {
    length: prepared.length,
    segments: prepared.curves.length,
    samples: request.progress.map((progress) =>
      sampleCurvePath(prepared, progress, request.repeat),
    ),
    units:
      'Local pixels and normalized arc-length progress; multi-contour paths jump between contours.',
  };
}
export async function inspectDrivers(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const request = driversInspectSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before driver inspection');
  const frames = request.frames.length ? request.frames : [request.frame],
    samples = [];
  for (const frame of frames) {
    const scoped = await renderer.inspectComposition(
        snapshot,
        request.sceneId,
        frame,
        request.path,
        request.contextFrames,
      ),
      animated = await renderer.native.evaluate(scoped.scene.nodes, frame),
      report: DriverReport = scoped.driverContext.group
        ? {
            nodes: await renderer.driven(scoped.scene.nodes, frame, snapshot, scoped.driverContext),
            values: [],
            dependencies: [],
          }
        : evaluateDrivers(
            scoped.scene.nodes,
            {
              frame,
              fps: snapshot.project.fps.num / snapshot.project.fps.den,
              width: scoped.width,
              height: scoped.height,
              duration: scoped.scene.duration,
            },
            animated,
          );
    if (request.nodeIds.some((id) => !scoped.scene.nodes.some((node) => node.id === id)))
      throw new VmotionError('DRIVER_REFERENCE', 'Requested driver layer was not found');
    samples.push({
      frame,
      dependencyScope: scoped.driverContext.group
        ? 'Parent graph evaluated before group isolation; numeric pose is final, dependency edges are reported at the outer scope.'
        : 'Full current graph property dependencies.',
      layers: report.nodes
        .filter((node) => !request.nodeIds.length || request.nodeIds.includes(node.id))
        .map((node) => ({
          nodeId: node.id,
          name: node.name,
          parentId: node.parentId,
          pose: {
            x: node.x,
            y: node.y,
            width: node.width,
            height: node.height,
            rotation: node.rotation,
            opacity: node.opacity,
          },
          expressions: Object.entries(node.expressions ?? {}).map(([property, source]) => ({
            property,
            source,
            references: compileExpression(source).references,
          })),
          layout: node.layout,
          motionPath: node.motionPath,
          values: report.values.filter((value) => value.nodeId === node.id),
          dependencies: report.dependencies.filter((value) => value.nodeId === node.id),
        })),
    });
  }
  return {
    revision: snapshot.revision,
    sceneId: request.sceneId,
    path: request.path,
    samples,
    language: expressionReference,
    order:
      'Native keys → property dependencies → layout/path/expression (expression overrides driven targets). All values are evaluated at the selected local clock.',
  };
}
export async function planDrivers(
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
  const request = driversPlanSchema.parse(raw);
  if (request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before driver planning');
  let candidate = structuredClone(snapshot);
  const seen = new Set<string>(),
    layers = [],
    samples = [];
  for (const target of request.targets) {
    const key = JSON.stringify([target.sceneId, target.path, target.nodeId]);
    if (seen.has(key)) throw new VmotionError('DRIVER_TARGET', 'Use one batch edit per layer');
    seen.add(key);
    const scoped = await renderer.inspectComposition(
        candidate,
        target.sceneId,
        target.frame,
        target.path,
        target.contextFrames,
      ),
      node = scoped.scene.nodes.find((node) => node.id === target.nodeId);
    if (!node) throw new VmotionError('DRIVER_REFERENCE', 'Target layer was not found');
    const expressions = { ...(target.resetExpressions ? {} : node.expressions) };
    for (const [property, source] of Object.entries(target.expressions ?? {})) {
      if (source === null) delete expressions[property];
      else expressions[property] = source;
    }
    let updated = nodeSchema.parse({
      ...node,
      animations: node.animations.filter(
        (channel) => !target.removeChannels.includes(channel.property),
      ),
      expressions,
      ...(target.layout === undefined ? {} : { layout: target.layout }),
      ...(target.motionPath === undefined ? {} : { motionPath: target.motionPath }),
    });
    if (target.keys.length)
      updated = editKeyframes(
        updated,
        target.keys.map((channel) => ({
          type: 'upsert',
          property: channel.property,
          keys: channel.keys,
        })),
      );
    validateDriverSyntax(updated);
    const patch: Partial<Node> = {
      expressions,
      ...(target.layout === undefined ? {} : { layout: updated.layout }),
      ...(target.motionPath === undefined ? {} : { motionPath: updated.motionPath }),
      ...(target.keys.length || target.removeChannels.length
        ? { animations: updated.animations }
        : {}),
    };
    candidate = applyOperations(
      root,
      candidate,
      await edit(candidate, target.sceneId, target.frame, [
        {
          path: target.path,
          contextFrames: target.contextFrames,
          nodeId: target.nodeId,
          frame: target.frame,
          patch,
        },
      ]),
    );
    layers.push({
      sceneId: target.sceneId,
      nodeId: target.nodeId,
      path: target.path,
      expressions,
      layout: updated.layout,
      motionPath: updated.motionPath,
    });
    const times = [
      ...new Set([
        0,
        target.frame,
        Math.max(0, scoped.scene.duration - 1),
        ...target.keys.flatMap((channel) => channel.keys.map((key) => key.frame)),
      ]),
    ];
    for (const frame of times) {
      if (frame >= scoped.scene.duration)
        throw new VmotionError('FRAME_RANGE', 'Driver check/key lies outside local composition');
      samples.push({
        sceneId: target.sceneId,
        path: target.path,
        contextFrames: target.contextFrames,
        frame,
      });
    }
  }
  const sceneIds = [...new Set(request.targets.map((target) => target.sceneId))],
    operations: Operation[] = sceneIds.map((sceneId) => ({
      type: 'updateScene',
      sceneId,
      patch: { nodes: candidate.scenes.find((scene) => scene.id === sceneId)!.nodes },
    })),
    unique = [...new Map(samples.map((sample) => [JSON.stringify(sample), sample])).values()];
  for (const sample of unique) {
    const scope = await renderer.inspectComposition(
      candidate,
      sample.sceneId,
      sample.frame,
      sample.path,
      sample.contextFrames,
    );
    await renderer.driven(scope.scene.nodes, sample.frame, candidate, scope.driverContext);
  }
  return {
    request,
    candidate,
    operations,
    layers,
    samples: unique.slice(0, 12),
    coverage: {
      proposed: unique.length,
      selected: Math.min(12, unique.length),
      incomplete: unique.length > 12,
    },
  };
}
