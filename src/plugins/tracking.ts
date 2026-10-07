import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { trackingAnalyzeSchema } from '../service/tracking-jobs.js';
import {
  inspectTracking,
  planTracking,
  trackingEvidence,
  trackingEvidenceSchema,
  trackingInspectSchema,
  trackingPlanSchema,
} from '../service/tracking.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';
export const trackingPlugin: BuiltinPluginModule = {
  id: 'vmotion.tracking',
  name: '运动跟踪与稳定',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0' },
  methods: new Set(['trackingAnalyze', 'trackingInspect', 'trackingPlan', 'trackingEvidence']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'tracking_analyze',
        description:
          'Run deterministic sparse point tracking on a video asset with original pixels, source-frame range, manual seeds/reseeds or automatic corners. Independent worker uses pyramidal Lucas–Kanade with photometric/forward-backward checks. Start returns a background job; poll status or cancel. Completed SHA analysisId is immutable; default replies omit trajectories. Lost points stay lost until explicit reseed. Does not modify project/history.',
        method: 'trackingAnalyze',
        schema: trackingAnalyzeSchema.shape,

        categories: ['animation', 'composition', 'media', 'editing'],
        keywords: '跟踪 运动 视频 分析 点 特征 worker 任务 取消 tracking motion feature',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'tracking_inspect',
        description:
          'Read a tracking analysisId or editable project tracking JSON. Paginated point/gap summaries and chosen source-frame positions; full matching evidence is opt-in. Report confidence as a heuristic. Read before binding or repairing samples.',
        method: 'trackingInspect',
        schema: trackingInspectSchema.shape,

        categories: ['animation', 'composition', 'media', 'editing'],
        keywords: '跟踪 轨迹 失跟 置信度 分页 点 查询',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'tracking_plan',
        description:
          'Plan editable tracking resource/manual sample edits and batch point/translation/similarity/affine attachment, video stabilization or four-point corner pin. Uses actual source video fit/clock and target parent/TRS. Generates ordinary matrix/effect keys, preserves TypeScript, protects existing channels, rejects loss by default; explicit hold reports held samples. Fingerprint-pinned short planId for unchanged preflight/apply and one undo. Smoothing/zoom are explicit; transparent borders remain possible.',
        method: 'trackingPlan',
        schema: trackingPlanSchema.shape,

        categories: ['animation', 'composition', 'media', 'editing'],
        keywords: '跟踪 贴附 稳定 防抖 四角 透视 角点 合成 绑定 矩阵 批量 计划',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'tracking_evidence',
        description:
          'Capture annotated original video frames with tracked/manual point crosses and confidence/loss counts, using recorded source FPS and pinned source fingerprint. Native PNG evidence contains no duplicated media Base64 in metadata.',
        method: 'trackingEvidence',
        schema: trackingEvidenceSchema.omit({ inline: true }).shape,

        categories: ['animation', 'composition', 'media', 'editing'],
        keywords: '跟踪 视频 证据 截图 标注 置信度 失跟',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(trackingRpcHandlers, host, method, params);
  },
};

export const trackingRpcHandlers = {
  trackingAnalyze: defineRpcHandler(
    z.object(trackingAnalyzeSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'trackingAnalyze';

      const p = trackingAnalyzeSchema.parse(params);
      if (p.action === 'status') return host.tracking.status(p.id);
      if (p.action === 'cancel') {
        if (!p.id) throw new VmotionError('TRACKING_JOB', 'Cancel requires a job ID');
        return host.tracking.cancel(p.id);
      }
      if (!p.request)
        throw new VmotionError('TRACKING_REQUEST', 'Start requires an analysis request');
      const job = host.tracking.start(host.snapshot, p.request);
      return p.wait ? host.tracking.wait(job.id) : job;
    },
  ),
  trackingInspect: defineRpcHandler(
    z.object(trackingInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'trackingInspect';

      return inspectTracking(host.root, host.snapshot, params);
    },
  ),
  trackingPlan: defineRpcHandler(
    z.object(trackingPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'trackingPlan';

      return planTracking(
        host.root,
        host.renderer,
        structuredClone(host.snapshot),
        params,
        host.edit,
      );
    },
  ),
  trackingEvidence: defineRpcHandler(
    z
      .object(trackingEvidenceSchema.omit({ inline: true }).shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'trackingEvidence';

      return host.withMediaTask(() =>
        trackingEvidence(host.root, structuredClone(host.snapshot), params),
      );
    },
  ),
};
