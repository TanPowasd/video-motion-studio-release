import { z } from 'zod';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { hash } from './project.js';
export const renderProfileSchema = z
  .object({
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    sceneId: z.string().optional(),
    sequenceId: z.string().optional(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: z.array(z.number().finite().nonnegative()).max(32).default([]),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(8).default([0]),
    width: z.number().int().min(160).max(3840).default(1280),
    height: z.number().int().min(90).max(2160).optional(),
    repeat: z.number().int().min(1).max(4).default(2),
    encode: z.boolean().default(false),
    detail: z.boolean().default(false),
    surfacePoolMb: z.number().int().min(0).max(256).default(96),
    fieldScan: z.enum(['bounded', 'full']).default('bounded'),
    mediaQuality: z.enum(['original', 'auto']).default('original'),
    graphicsCache: z.boolean().default(true),
    mediaFraming: z.enum(['direct', 'concat']).default('direct'),
    resourceCache: z.boolean().default(true),
    graphCache: z.boolean().default(true),
    nativeCache: z.boolean().default(true),
    gpu: z.enum(['cpu', 'auto', 'gpu']).default('cpu'),
    graphOptimize: z.boolean().default(true),
    graphRegions: z.boolean().default(true),
    graphTileRows: z.number().int().min(0).max(512).default(128),
    graphDetail: z.boolean().default(false),
    graphNodeLimit: z.number().int().min(1).max(32).default(8),
  })
  .strict();
export async function profileRendering(
  root: string,
  snapshot: Snapshot,
  raw: unknown,
  capture?: (index: number, rgba: Uint8ClampedArray, width: number, height: number) => void,
) {
  const request = renderProfileSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before render profile');
  if (request.sceneId && request.sequenceId)
    throw new VmotionError('RENDER_PROFILE_SCOPE', 'Choose a scene or a sequence');
  const copy = structuredClone(snapshot);
  if (request.sequenceId) {
    if (!copy.sequences.some((s) => s.id === request.sequenceId))
      throw new VmotionError('MISSING_SEQUENCE', 'Profile sequence not found');
    copy.project.activeSequence = request.sequenceId;
  }
  if (request.path.length && !request.sceneId)
    throw new VmotionError('RENDER_PROFILE_SCOPE', 'A focused path requires sceneId');
  const renderer = new Renderer(root, {
      surfacePoolBytes: request.surfacePoolMb * 1024 * 1024,
      fullFieldScan: request.fieldScan === 'full',
      graphicsCache: request.graphicsCache,
      mediaFraming: request.mediaFraming,
      resourceCache: request.resourceCache,
      graphCache: request.graphCache,
      nativeCache: request.nativeCache,
      gpu: request.gpu,
      graphOptimize: request.graphOptimize,
      graphRegions: request.graphRegions,
      graphTileRows: request.graphTileRows,
      graphTrace: request.graphDetail,
    }),
    samples: Array<{
      frame: number;
      round: number;
      renderMs: number;
      encodeMs?: number;
      pixelHash: string;
      performance: ReturnType<Renderer['performanceInfo']>;
    }> = [],
    expected = new Map<number, string>(),
    mismatches: number[] = [];
  try {
    let width = request.width,
      height = request.height;
    if (!height) {
      const scope = request.sceneId
        ? await renderer.inspectComposition(
            copy,
            request.sceneId,
            request.frames[0],
            request.path,
            request.contextFrames,
          )
        : undefined;
      height = Math.round(
        width * (scope ? scope.height / scope.width : copy.project.height / copy.project.width),
      );
    }
    if (height < 16 || height > 2160)
      throw new VmotionError(
        'RESOLUTION',
        'Profile aspect ratio exceeds supported height; choose explicit dimensions',
      );
    if (capture && width * height * request.frames.length * request.repeat > 32 * 1024 * 1024)
      throw new VmotionError(
        'RENDER_COMPARE_BUDGET',
        'Tolerance comparison retains at most 32M baseline pixels; reduce frames/rounds or explicit dimensions',
      );
    for (let round = 0; round < request.repeat; round++)
      for (const frame of request.frames) {
        const start = performance.now(),
          canvas = await renderer.render(copy, frame, {
            width,
            height,
            sceneId: request.sceneId,
            path: request.path,
            contextFrames: request.contextFrames,
            mediaQuality: request.mediaQuality,
          }),
          renderMs = performance.now() - start;
        try {
          const rgba = canvas.getContext('2d').getImageData(0, 0, width, height).data,
            pixelHash = hash(Buffer.from(rgba.buffer, rgba.byteOffset, rgba.byteLength));
          capture?.(samples.length, rgba, width, height);
          if (expected.has(frame) && expected.get(frame) !== pixelHash) mismatches.push(frame);
          else expected.set(frame, pixelHash);
          let encodeMs: number | undefined;
          if (request.encode) {
            const start = performance.now();
            await canvas.encode('png');
            encodeMs = performance.now() - start;
          }
          samples.push({
            frame,
            round,
            renderMs,
            encodeMs,
            pixelHash,
            performance: renderer.performanceInfo(),
          });
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      }
    const times = samples.map((s) => s.renderMs).sort((a, b) => a - b),
      warm = samples.filter((s) => s.round > 0),
      mean = (values: number[]) =>
        values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;
    return {
      revision: snapshot.revision,
      scope: {
        sceneId: request.sceneId,
        sequenceId: copy.project.activeSequence,
        path: request.path,
      },
      width,
      height,
      repeat: request.repeat,
      frameCount: samples.length,
      summary: {
        firstRenderMs: samples[0].renderMs,
        meanRenderMs: mean(times),
        p50Ms: times[Math.floor((times.length - 1) * 0.5)],
        p95Ms: times[Math.ceil(times.length * 0.95) - 1],
        warmMeanMs: mean(warm.map((s) => s.renderMs)),
        meanEncodeMs: request.encode ? mean(samples.map((s) => s.encodeMs!)) : undefined,
      },
      cache: renderer.performanceInfo(),
      ...(request.graphDetail
        ? { graphNodes: renderer.graphExecution.detail(request.graphNodeLimit) }
        : {}),
      media: renderer.mediaInfo(),
      determinism: { compared: request.repeat > 1, mismatchFrames: [...new Set(mismatches)] },
      ...(request.detail
        ? { samples }
        : { frames: request.frames.map((frame) => ({ frame, pixelHash: expected.get(frame) })) }),
      limits: {
        graphicsLayoutAccountedBudgetBytes: renderer.typography.cache.budgetBytes,
        graphicsPathAccountedBudgetBytes: renderer.geometry.budgetBytes,
        surfaceRetainedBudgetBytes: renderer.surfaces.budgetBytes,
        graphDefinitionsAccountedBudgetBytes:
          renderer.effectGraphs.report().definitions.budgetBytes,
        graphCompiledAccountedBudgetBytes: renderer.effectGraphs.report().compiled.budgetBytes,
        graphLiveSurfaceScratchBudgetBytes: 256 * 1024 * 1024,
        componentModules: 12,
        componentHeapMb: 128,
      },
      interpretation:
        'Actual local wall-clock evidence. Render time excludes PNG encoding/hash/IPC; repeat rounds retain component/image/surface caches. Scene complexity and device determine achievable preview rate.',
    };
  } finally {
    await renderer.close();
  }
}
