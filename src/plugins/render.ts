import path from 'node:path';
import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { RenderJob, RenderOptions } from '../media/export.js';
import { compareRendering, renderCompareSchema } from '../service/render-compare.js';
import { profileRendering, renderProfileSchema } from '../service/render-profile.js';
import { exportStill, imageExportSchema } from '../service/stills.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

const renderStatus = z.enum(['queued', 'running', 'completed', 'cancelled', 'failed']);
export const renderQuerySchema = z
  .object({
    ids: z.array(z.string().min(1).max(200)).max(100).optional(),
    statuses: z.array(renderStatus).max(5).optional(),
    revision: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    order: z.enum(['newest', 'oldest']).default('newest'),
    detail: z.boolean().default(false),
  })
  .strict();

export function queryRenderJobs(jobs: ReadonlyMap<string, RenderJob>, raw: unknown) {
  const request = renderQuerySchema.parse(raw),
    all = [...jobs.values()];
  for (const id of request.ids ?? [])
    if (!jobs.has(id))
      throw new VmotionError('NOT_FOUND', 'Requested render job is missing', { id });
  const selected = all.filter(
    (job) =>
      (!request.ids || request.ids.includes(job.id)) &&
      (!request.statuses || request.statuses.includes(job.status)) &&
      (!request.revision || request.revision === job.revision),
  );
  if (request.order === 'newest') selected.reverse();
  const page = selected.slice(request.offset, request.offset + request.limit);
  return {
    total: selected.length,
    offset: request.offset,
    nextOffset:
      request.offset + page.length < selected.length ? request.offset + page.length : undefined,
    counts: Object.fromEntries(
      renderStatus.options.map((status) => [
        status,
        all.filter((job) => job.status === status).length,
      ]),
    ),
    items: page.map((job) =>
      request.detail
        ? { ...job }
        : {
            id: job.id,
            status: job.status,
            revision: job.revision,
            stage: job.stage,
            progress: job.progress,
            frame: job.frame,
            totalFrames: job.totalFrames,
            hasError: !!job.error,
          },
    ),
    detail: request.detail,
    order: request.order,
  };
}

export const renderPlugin: BuiltinPluginModule = {
  id: 'vmotion.render',
  name: '渲染、性能与导出',
  version: '1.0.0',
  dependencies: { 'vmotion.effects': '^1.0.0', 'vmotion.audio': '^1.0.0' },
  methods: new Set([
    'renderProfile',
    'renderCompare',
    'render',
    'jobs',
    'job',
    'cancel',
    'renderQuery',
    'imageExport',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'render_compare',
        method: 'renderCompare',
        schema: renderCompareSchema.shape,
        description:
          'Compare pinned CPU/GPU graph runtime and sampled frames: default exact hashes, explicit pixelTolerance for premultiplied SDR differences, local timings including native transfers, fused/readback/scalar work, adapter/fallback/correction evidence and bounded node locators. baseline/optimized.gpu selects cpu/auto/gpu; tolerance comparison retains at most 32M baseline pixels. Checks media before/after. detail opts into pairs; no saved edits.',
        categories: ['render', 'effects'],
        keywords:
          '优化 对照 性能 像素 等价 区域 分块 旁路 显卡 硬件 GPU D3D Direct3D compare profile optimize ROI keyer',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'render_query',
        method: 'renderQuery',
        schema: renderQuerySchema.shape,
        description:
          'Read paged compact render progress by task IDs, statuses and project revision, with queue counts and explicit nextOffset. Defaults to 20 summaries without output paths or full error text; detail=true or render_status reads full evidence. Legacy render_list is unchanged.',
        categories: ['render'],
        keywords: '渲染 任务 查询 分页 队列 进度 取消 checkpoint export job progress',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'render_profile',
        method: 'renderProfile',
        schema: renderProfileSchema.shape,
        description:
          'Measure pinned scene/sequence/focused frames or exact candidates with gpu=cpu/auto/gpu. Reports actual hardware point-kernel fusion, transfers/readback, CPU rounding correction/fallbacks, warm/cold wall time, bounded surfaces and repeated pixel hashes. Timing includes GPU transport. Default CPU compact evidence; detail opts into rounds. Full-scene GPU remains unsupported; no quality reduction or frame-result cache.',
        keywords: '显卡 GPU Direct3D D3D 硬件 渲染 性能 profile render point effects',

        categories: ['effects', 'composition', 'render'],
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'image_export',
        description:
          'Export a still artboard (and optional size variants) as PNG/JPEG/WebP through the same native renderer as preview. scale 1–4 re-renders vectors/text at full resolution; transparent omits the background (PNG/WebP); trim removes bleed; PNG/JPEG carry DPI metadata (dpi×scale). revision/planId pin the exact project or candidate. Over-budget sizes fail with RESOLUTION, never silently downscaled.',
        method: 'imageExport',
        schema: imageExportSchema.shape,
        categories: ['render', 'image'],
        keywords: '导出图片 海报 封面 缩略图 PNG JPEG WebP 透明 倍率 出血 DPI export image still poster thumbnail',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'render_start',
        description:
          'Start a cancellable pinned render with checkpoint resume and explicit gpu=cpu/auto/gpu point effects. GPU runtime/adapter identity is fixed for resume, execution loss fails the task and preserves checkpoints. Supply the accepted revision to reject intervening edits. render_status includes final GPU evidence; other graphics/video encoding keep existing CPU/FFmpeg paths.',
        method: 'render',
        schema: {
          output: z.string(),
          format: z.enum(['mp4', 'png', 'wav']).default('mp4'),
          start: z.number().int().nonnegative().optional(),
          end: z.number().int().positive().optional(),
          width: z.number().int().optional(),
          height: z.number().int().optional(),
          encoder: z.string().optional(),
          resume: z.boolean().optional(),
          gpu: z.enum(['cpu', 'auto', 'gpu']).optional(),
          revision: z.string().optional(),
        },

        categories: ['render'],
        keywords: '导出 渲染 视频 编码',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'render_list',
        description: 'List render jobs and progress.',
        method: 'jobs',
        schema: {},

        categories: ['render'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'render_status',
        description: 'Read one render job.',
        method: 'job',
        schema: { id: z.string() },

        categories: ['render'],
        keywords: '进度 渲染 状态',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'render_cancel',
        description: 'Cancel a queued or running render; completed checkpoints are preserved.',
        method: 'cancel',
        schema: { id: z.string() },

        categories: ['render'],
        keywords: '取消 渲染',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(renderRpcHandlers, host, method, params);
  },
};

export const renderRpcHandlers = {
  imageExport: defineRpcHandler(
    z.object(imageExportSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const { inline: _inline, ...request } = params as Record<string, unknown>;
      if (!request.preview && !request.planId) {
        const { pendingFiles, diagnostics } = host.exportState();
        if (pendingFiles || diagnostics.some((d) => d.severity === 'error'))
          throw new VmotionError(
            'VALIDATION_FAILED',
            'Fix project diagnostics before exporting; the last valid preview is preserved',
            diagnostics,
          );
      }
      const snapshot = await host.candidateSnapshot({
        planId: request.planId as string | undefined,
        revision: request.revision as string | undefined,
      });
      return host.withMediaTask(() => exportStill(host, snapshot, request));
    },
  ),
  renderCompare: defineRpcHandler(
    z.object(renderCompareSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'renderCompare';

      const snapshot = await host.candidateSnapshot(params);
      return host.withMediaTask(() =>
        compareRendering(host.root, snapshot, { ...params, revision: snapshot.revision }),
      );
    },
  ),
  renderQuery: defineRpcHandler(
    z.object(renderQuerySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'renderQuery';

      return queryRenderJobs(host.renders.jobs, params);
    },
  ),
  renderProfile: defineRpcHandler(
    z.object(renderProfileSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'renderProfile';

      const snapshot = await host.candidateSnapshot(params);
      return host.withMediaTask(() =>
        profileRendering(host.root, snapshot, { ...params, revision: snapshot.revision }),
      );
    },
  ),
  render: defineRpcHandler(
    z
      .object({
        output: z.string().optional(),
        format: z.enum(['mp4', 'png', 'wav']).default('mp4'),
        start: z.number().int().nonnegative().optional(),
        end: z.number().int().positive().optional(),
        width: z.number().int().optional(),
        height: z.number().int().optional(),
        encoder: z.string().optional(),
        resume: z.boolean().optional(),
        gpu: z.enum(['cpu', 'auto', 'gpu']).optional(),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'render';

      const { pendingFiles, diagnostics } = host.exportState();
      if (pendingFiles || diagnostics.some((d) => d.severity === 'error'))
        throw new VmotionError(
          'VALIDATION_FAILED',
          'Fix project diagnostics before exporting; the last valid preview is preserved',
          diagnostics,
        );
      return host.renders.start(host.snapshot, {
        output: path.resolve(
          params.output ?? path.join(host.root, 'exports', host.snapshot.project.name + '.mp4'),
        ),
        format: params.format ?? 'mp4',
        start: params.start,
        end: params.end,
        width: params.width,
        height: params.height,
        encoder: params.encoder,
        resume: params.resume,
        revision: params.revision,
        gpu: params.gpu,
      } as RenderOptions);
    },
  ),
  jobs: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'jobs';

      return Array.from(host.renders.jobs.values());
    },
  ),
  job: defineRpcHandler(
    z.object({ id: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'job';

      const job = host.renders.jobs.get(params.id);
      if (!job) throw new VmotionError('NOT_FOUND', 'Job not found');
      return job;
    },
  ),
  cancel: defineRpcHandler(
    z.object({ id: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'cancel';

      return host.renders.cancel(params.id);
    },
  ),
};
