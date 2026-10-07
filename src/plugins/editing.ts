import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import { captionsImportSchema, importCaptions, inspectCaptions } from '../service/captions.js';
import { sequenceEditSchema, sequenceEdits } from '../service/editing.js';
import { auditSequence, sequenceAuditSchema } from '../service/sequence-audit.js';
import { planSequence, sequencePlanSchema } from '../service/sequence-plan.js';
import {
  inspectStoryboard,
  planStoryboard,
  storyboardInspectSchema,
  storyboardPlanSchema,
} from '../service/storyboards.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const editingPlugin: BuiltinPluginModule = {
  id: 'vmotion.editing',
  name: '剪辑、字幕与分镜',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0', 'vmotion.audio': '^1.0.0' },
  methods: new Set([
    'storyboardPlan',
    'storyboardInspect',
    'sequenceAudit',
    'sequencePlan',
    'sequenceEdit',
    'captionsImport',
    'captionsInspect',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'storyboard_plan',
        method: 'storyboardPlan',
        schema: storyboardPlanSchema.shape,
        description:
          'Assemble or edit a reusable chapter/shot/storyboard JSON resource with stable visual/narration clip IDs. Cumulative frame/second boundaries prevent per-shot rounding drift. Uses existing media/sequence planning, source fingerprints, locks and exact stored candidate/undo. Replaces only this storyboard generated clips and markers; existing content overlap is rejected. Optional shared operations can author source scenes/code atomically.',

        categories: ['editing'],
        keywords: '分镜 编排 章节 镜头 配音 时间轴 批量 长片 候选',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'storyboard_inspect',
        method: 'storyboardInspect',
        schema: storyboardInspectSchema.shape,
        description:
          'Read storyboard resource hash, chapters and paged stable shots plus their actual generated sequence placements. includeDocument opts into full authoring JSON; no full project source is returned by default.',

        categories: ['editing'],
        keywords: '分镜 章节 镜头 检查 稳定 ID 查询',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sequence_audit',
        method: 'sequenceAudit',
        schema: sequenceAuditSchema.omit({ inline: true }).shape,
        description:
          'Audit a complete sequence or exact candidate: structural clip/source ranges and overlap, source-scene object locators, stratified start/mid/end/boundary/marker output samples, actual composite pixel evidence and contact images. Coverage/omitted findings remain explicit; masks/effects are in final pixels, but artistic/per-object visibility and audio intelligibility are not inferred.',

        categories: ['editing', 'render'],
        keywords: '全片 序列 检查 质量 边界 画面 取样 覆盖 素材 越界',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sequence_plan',
        description:
          'Plan source-range assembly without saving: append, insert across tracks, or overwrite target tracks. Preserves split source/fade clocks, linked sound, markers and locked tracks. Returns exact candidate/apply payloads, fixed IDs, revisions, source fingerprints and suggested sample frames. Preflight candidate, then submit apply unchanged; do not regenerate the plan after reviewing it.',
        method: 'sequencePlan',
        schema: sequencePlanSchema.shape,

        categories: ['editing'],
        keywords: '剪辑 片段 来源 范围 计划 插入 覆盖 拼接 电影 二创',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sequence_edit',
        description:
          'Atomic movie/remix timeline edits: split at playhead, trim in/out with source handles, slip source frames, delete selected clips, ripple-delete time across tracks, link/unlink clips, track locks and markers. Split/trim preserve original fade envelopes and fractional source positions; linked audio/video right parts get their own group. Ripple respects locked tracks and moves markers. One revision-checked undo step; audio and visual renderers share preserved fades.',
        method: 'sequenceEdit',
        schema: sequenceEditSchema.shape,

        categories: ['editing', 'audio'],
        keywords: '剪辑 分割 裁切 滑移 移动 波纹 链接 节拍 标记',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'captions_import',
        description:
          'Import SRT/VTT text or a local file into an editable JSON cue document and a visual subtitle track. Rational FPS conversion, overlap/range checks, configurable font/color/bottom margin, and efficient current-cue evaluation. Generates normal scene/component layers so per-cue overrides and source edits remain available. Does not perform speech recognition or call AI.',
        method: 'captionsImport',
        schema: captionsImportSchema.innerType().shape,

        categories: ['editing'],
        keywords: '字幕 歌词 导入 时间',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'captions_inspect',
        description:
          'Read a paginated editable subtitle cue document with IDs, source-frame times, text, FPS and revision. Edit its JSON through project_apply or file operations with revision checks.',
        method: 'captionsInspect',
        schema: {
          dataFile: z.string(),
          offset: z.number().int().nonnegative().default(0),
          limit: z.number().int().min(1).max(500).default(100),
        },

        categories: ['editing'],
        keywords: '字幕 歌词 文本',
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
    return invokeRpcHandler(editingRpcHandlers, host, method, params);
  },
};

export const editingRpcHandlers = {
  storyboardPlan: defineRpcHandler(
    z.object(storyboardPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'storyboardPlan';
      const snapshot = host.snapshot;
      return planStoryboard(host.root, structuredClone(snapshot), params);
    },
  ),
  storyboardInspect: defineRpcHandler(
    z
      .object(storyboardInspectSchema.shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'storyboardInspect';
      const snapshot = host.snapshot;
      return inspectStoryboard(snapshot, params);
    },
  ),
  sequenceAudit: defineRpcHandler(
    z
      .object(sequenceAuditSchema.omit({ inline: true }).shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'sequenceAudit';
      const snapshot = host.snapshot;
      const candidate = await host.candidateSnapshot(params);
      return host.withMediaTask(() =>
        auditSequence(host.root, candidate, { ...params, revision: candidate.revision }),
      );
    },
  ),
  sequencePlan: defineRpcHandler(
    z.object(sequencePlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'sequencePlan';
      const snapshot = host.snapshot;
      return planSequence(host.root, structuredClone(snapshot), params);
    },
  ),
  sequenceEdit: defineRpcHandler(
    z.object(sequenceEditSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'sequenceEdit';
      const snapshot = host.snapshot;
      const edited = sequenceEdits(snapshot, params),
        state = await host.transact(
          [{ type: 'updateSequence', sequenceId: edited.sequence.id, patch: edited.sequence }],
          edited.request.revision ?? snapshot.revision,
        );
      return {
        ...state,
        edit: {
          selection: edited.selection,
          changes: edited.changes,
          duration: edited.sequence.duration,
        },
      };
    },
  ),
  captionsImport: defineRpcHandler(
    z
      .object(captionsImportSchema.innerType().shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'captionsImport';
      const snapshot = host.snapshot;
      const created = await importCaptions(snapshot, params),
        state = await host.transact(
          created.operations,
          created.request.revision ?? snapshot.revision,
        );
      return {
        ...state,
        captions: {
          dataFile: created.dataFile,
          componentFile: created.componentFile,
          sceneId: created.sceneId,
          trackId: created.trackId,
          clipId: created.clipId,
          count: created.document.cues.length,
        },
      };
    },
  ),
  captionsInspect: defineRpcHandler(
    z
      .object({
        dataFile: z.string(),
        offset: z.number().int().nonnegative().default(0),
        limit: z.number().int().min(1).max(500).default(100),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'captionsInspect';
      const snapshot = host.snapshot;
      return inspectCaptions(snapshot, params.dataFile, params.offset, params.limit);
    },
  ),
};
