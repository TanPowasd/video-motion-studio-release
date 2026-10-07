import { z } from 'zod';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { trackingDocumentSchema, type TrackingDocument } from '../core/tracking-schema.js';
import {
  prepareTracking,
  sampleTrackedPoint,
  trackingGaps,
  fitTrackingMotion,
  trackingMotion,
  blendTrackingMotion,
  smoothTrackingMotion,
} from '../core/tracking.js';
import {
  newNode,
  nodeSchema,
  effectSchema,
  VmotionError,
  type Snapshot,
  type Operation,
  type Keyframe,
} from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import {
  inverse,
  multiply,
  transform,
  nodeMatrix,
  identity,
  type Matrix,
  type CompositionDraft,
} from '../core/interaction.js';
import { pinGrid } from '../core/warp-grid.js';
import { compileExpression } from '../core/expressions.js';
import { fingerprint, mediaContentHash } from '../media/ffmpeg.js';
import type { Renderer } from '../core/renderer.js';
import { Renderer as MediaRenderer } from '../core/renderer.js';
import { readTrackingAnalysis } from './tracking-jobs.js';
import { checkAssets } from './media-evidence.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
import { hash, safePath, atomicWrite } from './project.js';
async function trackingSourceCheck(root: string, snapshot: Snapshot, d: TrackingDocument) {
  const asset = snapshot.project.assets.find((a) => a.id === d.source.assetId);
  if (!asset || asset.type !== 'video')
    throw new VmotionError(
      'TRACKING_SOURCE',
      'Tracking source asset is not a video in this project',
    );
  try {
    const file = path.resolve(root, asset.path),
      stamp = await fingerprint(file);
    if (
      stamp !== d.source.fingerprint &&
      (!d.source.contentHash || (await mediaContentHash(file)) !== d.source.contentHash)
    )
      throw new VmotionError(
        'ASSET_CHANGED',
        'Tracking source content changed; reanalyze before binding',
        { assetId: asset.id },
      );
    return { assetId: asset.id, fingerprint: stamp };
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError('ASSET_CHANGED', 'Tracking source is unavailable', {
      assetId: asset.id,
    });
  }
}
function readsMatrix(source: string) {
  const visit = (value: unknown): boolean =>
    !!value &&
    typeof value === 'object' &&
    (('type' in value && value.type === 'get' && 'key' in value && value.key === 'matrix') ||
      Object.values(value).some(visit));
  return visit(compileExpression(source).ast);
}
const reference = {
    analysisId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    file: z.string().optional(),
  },
  frame = z.number().int().nonnegative(),
  finite = z.number().finite();
export const trackingInspectSchema = z
  .object({
    ...reference,
    revision: z.string().optional(),
    pointIds: z.array(z.string()).max(32).default([]),
    offset: frame.default(0),
    limit: z.number().int().min(1).max(32).default(8),
    frames: z.array(finite.nonnegative()).max(16).default([]),
    detail: z.boolean().default(false),
  })
  .strict();
export const trackingEvidenceSchema = z
  .object({
    ...reference,
    pointIds: z.array(z.string()).max(32).default([]),
    frames: z.array(frame).min(1).max(8),
    width: z.number().int().min(160).max(640).default(480),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export const trackingPlanSchema = z
  .object({
    ...reference,
    revision: z.string(),
    saveAs: z.string().optional(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    edits: z
      .array(
        z
          .object({ pointId: z.string(), frame, x: finite.nullable(), y: finite.nullable() })
          .strict(),
      )
      .max(1000)
      .default([]),
    bindings: z
      .array(
        z
          .object({
            sceneId: z.string(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: contextFramesSchema.default([]),
            sourceNodeId: z.string(),
            targetNodeId: z.string(),
            mode: z.enum(['point', 'transform', 'stabilize', 'cornerPin']),
            pointIds: z.array(z.string()).min(1).max(32),
            model: z.enum(['translation', 'similarity', 'affine']).default('similarity'),
            startFrame: frame.default(0),
            endFrame: frame,
            anchorFrame: frame.optional(),
            loss: z.enum(['error', 'hold']).default('error'),
            minConfidence: finite.min(0).max(1).default(0.15),
            fitThreshold: finite.positive().max(100).default(2),
            smoothingRadius: z.number().int().min(0).max(120).default(0),
            strength: finite.min(0).max(1).default(1),
            zoom: finite.min(1).max(4).default(1),
            replaceChannels: z.boolean().default(false),
            effectId: z.string().min(1).max(200).default('tracked-pin'),
          })
          .strict(),
      )
      .max(16)
      .default([]),
  })
  .strict();
function trackingFile(file: string) {
  if (!/^components\/tracking\/[\w.-]+\.json$/.test(file))
    throw new VmotionError('TRACKING_SOURCE', 'Use a tracked components/tracking/*.json resource');
  return file;
}
export async function resolveTracking(
  root: string,
  snapshot: Snapshot,
  request: { analysisId?: string; file?: string },
) {
  if (!!request.analysisId === !!request.file)
    throw new VmotionError('TRACKING_SOURCE', 'Choose exactly one analysisId or project file');
  let document: TrackingDocument;
  if (request.analysisId) document = await readTrackingAnalysis(root, request.analysisId);
  else {
    const file = trackingFile(request.file!);
    if (snapshot.files[file] === undefined)
      throw new VmotionError(
        'TRACKING_SOURCE',
        'Tracking resource is missing from this project revision',
        { file },
      );
    try {
      document = trackingDocumentSchema.parse(JSON.parse(snapshot.files[file]));
    } catch (e) {
      throw new VmotionError(
        'TRACKING_DOCUMENT',
        `Invalid tracking document: ${(e as Error).message}`,
        { file },
      );
    }
  }
  return { document, documentHash: hash(JSON.stringify(document)) };
}
export async function inspectTracking(root: string, snapshot: Snapshot, raw: unknown) {
  const p = trackingInspectSchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before tracking inspection');
  const { document: d, documentHash } = await resolveTracking(root, snapshot, p),
    prepared = prepareTracking(d),
    points = d.points.filter((v) => !p.pointIds.length || p.pointIds.includes(v.id));
  if (p.pointIds.some((id) => !prepared.points.has(id)))
    throw new VmotionError('TRACKING_POINT', 'Requested point not found');
  return {
    revision: snapshot.revision,
    document: {
      id: d.id,
      name: d.name,
      hash: documentHash,
      file: p.file,
      analysisId: p.analysisId,
    },
    source: d.source,
    range: d.range,
    analysis: { ...d.analysis, settings: p.detail ? d.analysis.settings : undefined },
    points: {
      total: points.length,
      offset: p.offset,
      limit: p.limit,
      items: points.slice(p.offset, p.offset + p.limit).map((point) => ({
        id: point.id,
        name: point.name,
        valid: point.samples.filter((s) => s.status !== 'lost').length,
        lost: point.samples.filter((s) => s.status === 'lost').length,
        gaps: trackingGaps(point.samples),
        seeds: p.detail ? point.seeds : point.seeds.length,
        ...(p.frames.length
          ? {
              samples: p.frames.map((frame) => {
                try {
                  const s = sampleTrackedPoint(prepared, point.id, frame);
                  return p.detail
                    ? s
                    : {
                        frame,
                        x: Number(s.x!.toFixed(4)),
                        y: Number(s.y!.toFixed(4)),
                        confidence: Number(s.confidence.toFixed(4)),
                        status: s.status,
                      };
                } catch (e) {
                  if (e instanceof VmotionError && e.code === 'TRACKING_LOST')
                    return { frame, status: 'lost', ...(e.details as object) };
                  throw e;
                }
              }),
            }
          : {}),
      })),
      nextOffset: p.offset + p.limit < points.length ? p.offset + p.limit : null,
    },
    units:
      'Source pixels in the displayed video orientation; source frames use the recorded rational project FPS. Confidence is a matching heuristic, not a probability.',
  };
}
function videoFit(
  source: TrackingDocument['source'],
  n: { width: number; height: number },
  project: Snapshot['project'],
): Matrix {
  // Same original decode box used by Renderer. Include letterbox before stretching the box.
  const dw = Math.max(16, Math.min(project.width, Math.round(n.width))),
    dh = Math.max(16, Math.min(project.height, Math.round(n.height))),
    s = Math.min(dw / source.width, dh / source.height),
    iw = Math.round(source.width * s),
    ih = Math.round(source.height * s),
    sx = n.width / dw,
    sy = n.height / dh;
  return [
    (iw / source.width) * sx,
    0,
    0,
    (ih / source.height) * sy,
    Math.floor((dw - iw) / 2) * sx,
    Math.floor((dh - ih) / 2) * sy,
  ];
}
export async function planTracking(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    s: Snapshot,
    scene: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>,
) {
  const p = trackingPlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before tracking plan');
  const { document: original } = await resolveTracking(root, snapshot, p),
    d = structuredClone(original),
    check = await trackingSourceCheck(root, snapshot, d);
  d.source.fingerprint = check.fingerprint;
  await checkAssets(root, snapshot, [check]);
  if (
    d.source.fps.num !== snapshot.project.fps.num ||
    d.source.fps.den !== snapshot.project.fps.den
  )
    throw new VmotionError(
      'TRACKING_TIMEBASE',
      'Tracking FPS differs from this project; reanalyze or convert the resource explicitly',
    );
  for (const e of p.edits) {
    const point = d.points.find((v) => v.id === e.pointId);
    if (!point) throw new VmotionError('TRACKING_POINT', 'Manual edit point not found');
    if (e.frame < d.range.start || e.frame >= d.range.end || (e.x === null) !== (e.y === null))
      throw new VmotionError(
        'TRACKING_EDIT',
        'Use an in-range frame and either two finite positions or two nulls',
      );
    point.seeds = point.seeds.filter((s) => s.frame !== e.frame);
    if (e.x !== null && e.y !== null) {
      point.seeds.push({ frame: e.frame, x: e.x, y: e.y });
      point.samples[e.frame - d.range.start] = {
        frame: e.frame,
        x: e.x,
        y: e.y,
        status: 'manual',
        confidence: 1,
      };
    } else
      point.samples[e.frame - d.range.start] = {
        frame: e.frame,
        x: null,
        y: null,
        status: 'lost',
        confidence: 0,
        reason: 'stopped',
      };
  }
  const prepared = prepareTracking(d),
    file = trackingFile(
      p.saveAs ?? p.file ?? `components/tracking/motion-${p.analysisId!.slice(0, 12)}.json`,
    );
  if (snapshot.files[file] !== undefined && file !== p.file)
    throw new VmotionError(
      'TRACKING_RESOURCE_EXISTS',
      'SaveAs would replace an existing resource; inspect/edit that file explicitly',
    );
  let candidate = applyOperations(root, snapshot, [
    { type: 'writeSource', path: file, content: JSON.stringify(d, null, 2) + '\n' },
  ]);
  const reports = [],
    samples: Array<{ sceneId: string; path: string[]; contextFrames: number[]; frame: number }> =
      [],
    seen = new Set<string>();
  for (const b of p.bindings) {
    const locator = JSON.stringify([b.sceneId, b.path, b.targetNodeId]);
    if (seen.has(locator)) throw new VmotionError('TRACKING_TARGET', 'Use one binding per layer');
    seen.add(locator);
    if (b.endFrame <= b.startFrame || b.endFrame - b.startFrame > 3600)
      throw new VmotionError('TRACKING_RANGE', 'Binding uses 1–3600 local output frames');
    if (b.mode !== 'stabilize' && (b.smoothingRadius || b.zoom !== 1))
      throw new VmotionError('TRACKING_MODE', 'Smoothing and zoom apply to stabilization only');
    const anchor = b.anchorFrame ?? b.startFrame;
    if (anchor < b.startFrame || anchor >= b.endFrame)
      throw new VmotionError('TRACKING_RANGE', 'Anchor must be inside the local binding range');
    if (
      (b.mode === 'point' && b.pointIds.length !== 1) ||
      (b.mode === 'cornerPin' && b.pointIds.length !== 4)
    )
      throw new VmotionError(
        'TRACKING_POINT',
        'Point attachment uses one point; corner pin uses four ordered TL/TR/BR/BL points',
      );
    if (new Set(b.pointIds).size !== b.pointIds.length)
      throw new VmotionError('TRACKING_POINT', 'Binding points must be distinct');
    const scope = await renderer.inspectComposition(
      candidate,
      b.sceneId,
      anchor,
      b.path,
      b.contextFrames,
    );
    if (scope.scene.nodes.some((n) => Object.values(n.expressions ?? {}).some(readsMatrix)))
      throw new VmotionError(
        'TRACKING_DRIVER',
        'Rewrite explicit matrix-dependent expressions before baking motion in this composition',
      );
    if (b.endFrame > scope.scene.duration)
      throw new VmotionError('TRACKING_RANGE', 'Binding extends beyond local composition duration');
    const graphAt = async (frame: number) => {
      const graph = await renderer.inspectInteractions(candidate, b.sceneId, frame, b.path, {
          contextFrames: b.contextFrames,
          includeInactive: true,
          includeEmpty: true,
          includeEvaluated: true,
        }),
        src = graph.layers.find(
          (l) => l.node.id === b.sourceNodeId && JSON.stringify(l.path) === JSON.stringify(b.path),
        ),
        target = graph.layers.find(
          (l) => l.node.id === b.targetNodeId && JSON.stringify(l.path) === JSON.stringify(b.path),
        );
      if (!src || !target)
        throw new VmotionError(
          'TRACKING_TARGET',
          'Source/target must exist in the same opened composition',
        );
      if (src.node.type !== 'video' || src.node.assetId !== d.source.assetId)
        throw new VmotionError(
          'TRACKING_SOURCE',
          'Source layer must be the video asset recorded in this tracking document',
        );
      if (src.uncertainty?.includes('effect'))
        throw new VmotionError(
          'TRACKING_SOURCE_EFFECT',
          'Bind against unwarped video; precompose/render transformed pixel effects before analyzing',
        );
      return { src, target };
    };
    const referenceGraph = await graphAt(anchor),
      base = referenceGraph.target.node;
    if (
      base.layout ||
      base.motionPath ||
      Object.keys(base.expressions ?? {}).some((prop) => /^matrix\./.test(prop)) ||
      Object.values(base.expressions ?? {}).some(readsMatrix)
    )
      throw new VmotionError(
        'TRACKING_DRIVER',
        'Matrix binding requires explicit removal of conflicting layout/path/matrix expressions',
      );
    if (b.mode === 'stabilize' && b.targetNodeId !== b.sourceNodeId)
      throw new VmotionError(
        'TRACKING_TARGET',
        'Stabilization must target the analyzed video layer',
      );
    const channelPrefix =
        b.mode === 'cornerPin' ? `effects.${base.effects.length}.corners.` : 'matrix.',
      controlled = base.animations.filter((a) => a.property.startsWith('matrix.'));
    if (b.mode !== 'cornerPin' && controlled.length && !b.replaceChannels)
      throw new VmotionError(
        'TRACKING_CHANNEL_EXISTS',
        'Set replaceChannels=true to bake/combine existing matrix motion; other channels remain editable',
      );
    if (b.mode === 'cornerPin' && base.effects.some((e) => e.id === b.effectId))
      throw new VmotionError(
        'TRACKING_EFFECT_EXISTS',
        'Choose a new stable effect ID or edit the existing tracked pin explicitly',
      );
    const sourcePoint = (frame: number, id: string, loss = b.loss) =>
        sampleTrackedPoint(prepared, id, Math.floor(frame), loss),
      referenceSourceFrame = referenceGraph.src.contentFrame ?? anchor,
      referenceFit = videoFit(d.source, referenceGraph.src.evaluatedNode!, snapshot.project),
      referenceWorld = multiply(referenceGraph.src.matrix, referenceFit),
      referencePoints = b.pointIds.map((id) => {
        const v = sourcePoint(referenceSourceFrame, id);
        return { id, point: transform(referenceWorld, { x: v.x!, y: v.y! }) };
      });
    const poses: Array<{
        frame: number;
        matrix?: Matrix;
        corners?: Array<{ x: number; y: number }>;
        motion?: Matrix;
        fit?: Matrix;
        baseMatrix: Matrix;
      }> = [],
      rejected = new Set<string>();
    let held = 0,
      maxResidual = 0;
    for (let frame = b.startFrame; frame < b.endFrame; frame++) {
      const { src, target } = frame === anchor ? referenceGraph : await graphAt(frame),
        n = target.evaluatedNode!,
        sourceFrame = src.contentFrame ?? frame,
        fit = videoFit(d.source, src.evaluatedNode!, snapshot.project),
        world = multiply(src.matrix, fit),
        points = b.pointIds.map((id) => {
          const v = sourcePoint(sourceFrame, id);
          if (!v.held && v.confidence < b.minConfidence)
            throw new VmotionError(
              'TRACKING_CONFIDENCE',
              'Point confidence is below the binding threshold',
              { pointId: id, frame, confidence: v.confidence },
            );
          if (v.held) held++;
          return {
            id,
            point: transform(world, { x: v.x!, y: v.y! }),
            source: { x: v.x!, y: v.y! },
            confidence: v.confidence,
          };
        });
      if (b.mode === 'cornerPin') {
        if (n.width <= 0 || n.height <= 0)
          throw new VmotionError(
            'TRACKING_TARGET',
            'Corner pin target needs positive width/height',
          );
        if (n.width !== base.width || n.height !== base.height)
          throw new VmotionError(
            'TRACKING_TARGET',
            'Corner pin region needs stable target dimensions; animate transform/scale instead',
          );
        const inv = inverse(target.matrix);
        if (!inv) throw new VmotionError('TRACKING_TRANSFORM', 'Target transform is singular');
        const originalCorners = [
            { x: 0, y: 0 },
            { x: 1, y: 0 },
            { x: 1, y: 1 },
            { x: 0, y: 1 },
          ],
          corners = points.map((v, i) => {
            const q = transform(inv, v.point),
              o = originalCorners[i];
            return {
              x: o.x + (q.x / n.width - o.x) * b.strength,
              y: o.y + (q.y / n.height - o.y) * b.strength,
            };
          });
        pinGrid(corners);
        poses.push({ frame, corners, baseMatrix: n.matrix });
      } else if (b.mode === 'stabilize') {
        const motion = trackingMotion(
          prepared,
          Math.floor(referenceSourceFrame),
          Math.floor(sourceFrame),
          b.pointIds,
          b.model,
          b.loss,
          b.fitThreshold,
        );
        motion.rejected.forEach((id) => rejected.add(id));
        maxResidual = Math.max(maxResidual, motion.rms);
        poses.push({ frame, motion: motion.matrix, fit, baseMatrix: n.matrix });
      } else {
        const fitted = fitTrackingMotion(
          points.map((v, i) => ({
            id: v.id,
            from: referencePoints[i].point,
            to: v.point,
            weight: v.confidence,
          })),
          b.mode === 'point' ? 'translation' : b.model,
          b.fitThreshold,
        );
        fitted.rejected.forEach((id) => rejected.add(id));
        maxResidual = Math.max(maxResidual, fitted.rms);
        const delta = blendTrackingMotion(
            fitted.matrix,
            b.strength,
            b.mode === 'point' ? 'translation' : b.model,
          ),
          before = multiply(target.parentMatrix, nodeMatrix({ ...n, matrix: [...identity] })),
          inv = inverse(before);
        if (!inv) throw new VmotionError('TRACKING_TRANSFORM', 'Parent/TRS transform is singular');
        poses.push({
          frame,
          matrix: multiply(inv, multiply(delta, target.matrix)),
          baseMatrix: n.matrix,
        });
      }
    }
    const smoothed =
      b.mode === 'stabilize'
        ? smoothTrackingMotion(
            poses.map((p) => p.motion!),
            b.smoothingRadius,
            b.model,
          )
        : [];
    if (b.mode === 'stabilize')
      for (const [i, pose] of poses.entries()) {
        const current = pose.motion!,
          inv = inverse(current);
        if (!inv) throw new VmotionError('TRACKING_DEGENERATE', 'Source motion is singular');
        const raw = multiply(smoothed[i], inv),
          correction = blendTrackingMotion(raw, b.strength, b.model),
          zoom: Matrix = [
            b.zoom,
            0,
            0,
            b.zoom,
            (d.source.width * (1 - b.zoom)) / 2,
            (d.source.height * (1 - b.zoom)) / 2,
          ],
          fitInv = inverse(pose.fit!);
        if (!fitInv)
          throw new VmotionError('TRACKING_TRANSFORM', 'Video source placement is singular');
        pose.matrix = multiply(
          pose.baseMatrix,
          multiply(pose.fit!, multiply(zoom, multiply(correction, fitInv))),
        );
      }
    const channels = new Map<string, Keyframe[]>();
    for (const pose of poses) {
      const values = pose.corners
        ? pose.corners.flatMap(
            (v, i) =>
              [
                [`${channelPrefix}${i}.x`, v.x],
                [`${channelPrefix}${i}.y`, v.y],
              ] as const,
          )
        : pose.matrix!.map((v, i) => [`matrix.${i}`, v] as const);
      for (const [prop, value] of values) {
        if (!channels.has(prop)) channels.set(prop, []);
        channels.get(prop)!.push({ frame: pose.frame, value, easing: 'linear' });
      }
    }
    const updated = nodeSchema.parse({
      ...base,
      animations: [
        ...base.animations.filter((a) => !channels.has(a.property)),
        ...Array.from(channels, ([property, keys]) => ({ property, keys })),
      ],
      ...(b.mode === 'cornerPin'
        ? {
            effects: [
              ...base.effects,
              effectSchema.parse({
                id: b.effectId,
                type: 'cornerPin',
                region: { x: 0, y: 0, width: base.width, height: base.height },
                corners: poses[0].corners,
              }),
            ],
          }
        : {}),
    });
    candidate = applyOperations(
      root,
      candidate,
      await edit(candidate, b.sceneId, anchor, [
        {
          path: b.path,
          contextFrames: b.contextFrames,
          nodeId: b.targetNodeId,
          patch: {
            animations: updated.animations,
            ...(b.mode === 'cornerPin' ? { effects: updated.effects } : {}),
          },
        },
      ]),
    );
    reports.push({
      sceneId: b.sceneId,
      path: b.path,
      nodeId: b.targetNodeId,
      mode: b.mode,
      frames: poses.length,
      channels: [...channels.keys()],
      heldSamples: held,
      rejectedPoints: [...rejected],
      maxFitResidual: maxResidual,
      ...(b.mode === 'stabilize'
        ? {
            edgePolicy: 'Transparent borders remain possible; zoom is explicit, not automatic',
            zoom: b.zoom,
            smoothingRadius: b.smoothingRadius,
          }
        : {}),
    });
    for (const frame of new Set([
      b.startFrame,
      Math.floor((b.startFrame + b.endFrame - 1) / 2),
      b.endFrame - 1,
      anchor,
    ]))
      samples.push({ sceneId: b.sceneId, path: b.path, contextFrames: b.contextFrames, frame });
  }
  const changedScenes = [...new Set(p.bindings.map((b) => b.sceneId))],
    operations: Operation[] = [
      { type: 'writeSource', path: file, content: candidate.files[file] },
      ...changedScenes.map((sceneId) => ({
        type: 'updateScene' as const,
        sceneId,
        patch: { nodes: candidate.scenes.find((s) => s.id === sceneId)!.nodes },
      })),
    ],
    unique = [...new Map(samples.map((s) => [JSON.stringify(s), s])).values()],
    input = {
      revision: snapshot.revision,
      operations,
      assetChecks: [check],
      samples: unique.slice(0, 12),
      width: 480,
      visual: true,
      determinism: true,
    },
    stored =
      p.delivery === 'stored'
        ? (await checkAssets(root, candidate, [check]), await storeAgentPlan(root, input))
        : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    resource: { file, id: d.id, points: d.points.length, manualEdits: p.edits.length },
    bindings: reports,
    sampleCoverage: {
      total: unique.length,
      included: Math.min(12, unique.length),
      incomplete: unique.length > 12,
    },
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
    ...(p.edits.length
      ? {
          notice:
            'Manual edits change explicit samples/seeds only. Reanalyze with those seeds to propagate a correction to subsequent frames.',
        }
      : {}),
  };
}
export async function trackingEvidence(root: string, snapshot: Snapshot, raw: unknown) {
  const p = trackingEvidenceSchema.parse(raw),
    { document: d, documentHash } = await resolveTracking(root, snapshot, p),
    prepared = prepareTracking(d),
    checks = [await trackingSourceCheck(root, snapshot, d)];
  await checkAssets(root, snapshot, checks);
  if (
    d.source.fps.num !== snapshot.project.fps.num ||
    d.source.fps.den !== snapshot.project.fps.den
  )
    throw new VmotionError(
      'TRACKING_TIMEBASE',
      'Evidence uses the recorded FPS; regenerate after changing project FPS',
    );
  const points = d.points.filter((v) => !p.pointIds.length || p.pointIds.includes(v.id));
  if (p.pointIds.some((id) => !prepared.points.has(id)))
    throw new VmotionError('TRACKING_POINT', 'Evidence point not found');
  const height = Math.max(32, Math.round((p.width * d.source.height) / d.source.width));
  if (height > 640)
    throw new VmotionError(
      'TRACKING_EVIDENCE',
      'Choose a narrower evidence width for portrait sources',
    );
  const copy = structuredClone(snapshot);
  copy.project.width = p.width;
  copy.project.height = height;
  copy.scenes = [
    {
      id: 'tracking-evidence',
      name: 'Tracking evidence',
      duration: d.range.end,
      background: '#101826',
      nodes: [
        newNode({
          id: 'footage',
          type: 'video',
          assetId: d.source.assetId,
          width: p.width,
          height,
        }),
      ],
    },
  ];
  copy.project.assets = copy.project.assets.map((a) =>
    a.id === d.source.assetId
      ? { ...a, metadata: { ...a.metadata, width: d.source.width, height: d.source.height } }
      : a,
  );
  const columns = Math.min(4, p.frames.length),
    sheet = createCanvas(columns * p.width, Math.ceil(p.frames.length / columns) * (height + 28)),
    ctx = sheet.getContext('2d'),
    renderer = new MediaRenderer(root),
    samples = [];
  try {
    for (const [i, frame] of p.frames.entries()) {
      if (frame < d.range.start || frame >= d.range.end)
        throw new VmotionError('TRACKING_RANGE', 'Evidence frame is outside recorded coverage');
      const canvas = await renderer.render(copy, frame, {
          sceneId: 'tracking-evidence',
          width: p.width,
          height,
        }),
        x = (i % columns) * p.width,
        y = Math.floor(i / columns) * (height + 28);
      ctx.fillStyle = '#101826';
      ctx.fillRect(x, y, p.width, 28);
      ctx.fillStyle = '#dce9f8';
      ctx.font = '13px "Microsoft YaHei"';
      ctx.fillText(`${frame}f · source / tracking`, x + 8, y + 19);
      ctx.drawImage(canvas, x, y + 28);
      canvas.width = 1;
      let visible = 0,
        lost = 0;
      for (const point of points) {
        const s = point.samples[frame - d.range.start];
        if (s.status === 'lost') {
          lost++;
          continue;
        }
        visible++;
        const px = x + (s.x! * p.width) / d.source.width,
          py = y + 28 + (s.y! * height) / d.source.height;
        ctx.strokeStyle = s.status === 'manual' ? '#ffc46e' : '#64ebc7';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.arc(px, py, 6, 0, Math.PI * 2);
        ctx.moveTo(px - 10, py);
        ctx.lineTo(px + 10, py);
        ctx.moveTo(px, py - 10);
        ctx.lineTo(px, py + 10);
        ctx.stroke();
        ctx.font = '10px Consolas';
        ctx.fillStyle = ctx.strokeStyle;
        ctx.fillText(`${point.id} ${(s.confidence * 100).toFixed(0)}%`, px + 8, py - 7);
      }
      samples.push({ frame, visible, lost });
    }
    await checkAssets(root, snapshot, checks);
    const buffer = await sheet.encode('png'),
      output = path.resolve(
        p.output ??
          safePath(
            root,
            `.vmotion/tracking-evidence/${hash(JSON.stringify([documentHash, p.frames, p.width])).slice(0, 24)}.png`,
          ),
      );
    await atomicWrite(output, buffer);
    return {
      revision: snapshot.revision,
      documentHash,
      sourceCheck: checks[0],
      samples,
      output,
      width: sheet.width,
      height: sheet.height,
      mimeType: 'image/png',
      ...(p.inline ? { data: buffer.toString('base64') } : {}),
    };
  } finally {
    sheet.width = 1;
    await renderer.close();
  }
}
