import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { parseCube } from '../sdk/post.js';
import { effectGraphQuerySchema, queryEffectGraph } from '../service/effect-graph-query.js';
import {
  effectGraphInspectSchema,
  effectGraphPlanSchema,
  inspectEffectGraph,
  planEffectGraph,
} from '../service/effect-graphs.js';
import {
  effectGuide,
  effectGuideSchema,
  effectsInspectSchema,
  effectsPlanSchema,
  inspectEffects,
  planEffects,
} from '../service/effects2d.js';
import {
  motionPlanSchema,
  motionTemplates,
  motionTemplatesSchema,
  planMotion,
} from '../service/motion-plan.js';
import { applyOperations } from '../service/operations.js';
import {
  inspectParticles,
  particlesInspectSchema,
  particlesPlanSchema,
  planParticles,
} from '../service/particle-field.js';
import { planTransitions, transitionPlanSchema } from '../service/transitions.js';
import {
  planVisual,
  visualPlanSchema,
  visualTemplates,
  visualTemplatesSchema,
} from '../service/visual-library.js';
import { builtinCandidate } from './candidate.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const visualPlugin: BuiltinPluginModule = {
  id: 'vmotion.effects',
  name: '视觉特效与动作模板',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0' },
  methods: new Set([
    'effectsGuide',
    'effectsInspect',
    'effectGraphInspect',
    'effectGraphQuery',
    'visualTemplates',
    'motionTemplates',
    'effectsPlan',
    'effectGraphPlan',
    'visualPlan',
    'motionPlan',
    'particlesInspect',
    'particlesPlan',
    'transitionPlan',
    'importLut',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'effect_import_lut',
        description:
          'Parse a local 3D .cube LUT (size 2–33) and append it to a layer effect stack. LUT data is embedded in project JSON so renders remain pinned and portable.',
        method: 'importLut',
        schema: {
          sceneId: z.string(),
          nodeId: z.string(),
          path: z.string(),
          intensity: z.number().min(0).max(1).default(1),
          revision: z.string().optional(),
        },

        categories: ['effects', 'vector'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'effects_plan',
        description:
          'Plan an atomic multi-layer effect edit: append/update/copy/move/toggle/remove/clear and numeric keys, with stable effect IDs and automatic animation-index remapping. Fits new spatial effects to current content bounds by default. Generated layers persist overrides; source code stays editable. Returns compact stored planId; preflight images and apply unchanged for one undo.',
        method: 'effectsPlan',
        schema: effectsPlanSchema.shape,

        categories: ['effects', 'animation'],
        keywords: '平面 特效 计划 批量 修改 复制 排序 转场 扭曲',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'effect_graph_plan',
        description:
          'Plan graph resources and multi-scene scoped attachments/updates as one exact candidate. Stable-ID actions include named outputs; root/subgraph output choices, channel routing and sRGB/linear color matrices compose with existing branch/mix/mask/transform/noise/displacement. Hash-check resources; bind sibling inputs, materialize numeric parameter keys, preserve generated source. target.output=null restores the default; resetParams/resetKeys handles upgrades. Native preflight/apply shares one undo and reports coverage.',
        method: 'effectGraphPlan',
        schema: effectGraphPlanSchema.shape,

        categories: ['effects', 'composition'],
        keywords: '特效 节点 图 管线 分支 混合 遮罩 置换 子图 复用 计划',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'visual_plan',
        method: 'visualPlan',
        schema: visualPlanSchema.shape,
        description:
          'Apply a selected visual template to multi-scene/scoped layers in one stored graph candidate, with parameter animation and optional same-parent map input bindings. Existing edited shared resources are retained; new template graphs are materialized under components/effects. Use native preflight/pictures and render_profile bounded/full field evidence, then unchanged apply for one undo.',

        categories: ['effects'],
        keywords: '视觉 平面 制作 纹理 光效 置换 映射 参数 模板 批量',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'motion_plan',
        description:
          'Compose parameterized animation cues (builtin, inline or shared JSON) across multiple scenes/layer scopes in one exact candidate. Supports frame/second clocks, per-target offsets and cue bindings, relative static/evaluated poses, explicit existing-channel collision policies, and atomic template saving. Generated edits persist overrides, source code stays editable. Returns stored preflight/apply plan, channel/timing evidence and sampling coverage; one shared undo.',
        method: 'motionPlan',
        schema: motionPlanSchema.shape,

        categories: ['animation', 'composition'],
        keywords: '动画 动作 组合 编排 跨场景 批量 参数 模板 关键帧',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'particles_inspect',
        description:
          'Evaluate a seeded analytical particle field at an arbitrary time without creating project files. Returns bounded birth-ID records, age/position/velocity/color, conservative local bounds and explicit scan/live truncation. Supports burst/continuous, point/box/disk/line emission, gravity, drag, fade, size/tint/spin and circle/square/streak sprites.',
        method: 'particlesInspect',
        schema: particlesInspectSchema.shape,

        categories: ['effects', 'animation'],
        keywords: '粒子 发射器 物理 重力 阻力 爆发 轨迹 速度 检查',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'particles_plan',
        description:
          'Plan an editable parameterized TypeScript particle component in a scene/group/generated scope, optionally with whole-emitter effects. Code/time evaluation is pure; renderer temporal sampling re-evaluates births. Returns exact stored candidate for native preflight/apply and one undo; all controls remain available through component_parameters.',
        method: 'particlesPlan',
        schema: particlesPlanSchema.shape,

        categories: ['effects', 'animation'],
        keywords: '粒子 发射器 创建 计划 爆发 火花 烟花 光点 拖尾',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'transition_plan',
        method: 'transitionPlan',
        schema: transitionPlanSchema.shape,
        description:
          'Create reusable parameterized transition compositions between existing scenes as one exact batch candidate, optionally place clips at explicit timeline frames. Crossfade, slide/push, wipe, iris, zoom, dip and cut share source dimensions/content clocks and declare scene dependencies. Isolated additive compositing preserves transparent crossfade endpoints. Source scenes are preserved; native preflight/apply shares one undo.',

        categories: ['effects', 'composition'],
        keywords: '转场 镜头 动画 合成 叠化 推拉 擦除 遮罩 复用 模板 批量',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'effects_guide',
        description:
          'Read concise 2D effect types/fields, units, coordinate spaces and composition workflow. Query individual types with schema=true for exact interfaces.',
        method: 'effectsGuide',
        schema: effectGuideSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 平面 扭曲 转场 参数',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'effects_inspect',
        description:
          'Inspect explicit effect stack IDs/indices, values, enabled flags, numeric channels and current-frame evaluation for selected layers.',
        method: 'effectsInspect',
        schema: effectsInspectSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 堆栈 检查 数值 关键帧',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'effect_graph_query',
        description:
          'Page 24 reachable nodes, parameters, links, unused IDs, resources or named outputs of an attached/resource graph. Select one output and stable IDs; default values are bounded previews, detail opt-in returns selected complete values/schema. No full graph/source/schema dump; native inspect and exact graph plans remain available.',
        method: 'effectGraphQuery',
        schema: effectGraphQuerySchema.shape,
        categories: ['effects', 'composition'],
        keywords: '特效 图 查询 分页 通道 多输出 graph channels output',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'effect_graph_inspect',
        description:
          'Inspect a reusable effect graph resource or attached graph with parameters, inputs, topology, resource hashes and bounded surface evidence.',
        method: 'effectGraphInspect',
        schema: effectGraphInspectSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '特效 节点 图 拓扑 参数 输入',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'visual_templates',
        description:
          'Discover procedural texture/light/color/displacement graph presets with short summaries; full graph JSON is opt-in per selected preset.',
        method: 'visualTemplates',
        schema: visualTemplatesSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['effects'],
        keywords: '视觉 纹理 光效 辉光 置换 模板',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'motion_templates',
        description:
          'List builtin and project JSON motion templates with parameter descriptors, compatible channels and optional normalized key data.',
        method: 'motionTemplates',
        schema: motionTemplatesSchema.shape,
        plugin: { id: 'vmotion.effects', version: '1.0.0', origin: 'builtin' as const },
        categories: ['animation', 'effects'],
        keywords: '动作 动画 模板 入场 退场 复用',

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
    return invokeRpcHandler(visualRpcHandlers, host, method, params);
  },
};

export const visualRpcHandlers = {
  importLut: defineRpcHandler(
    z
      .object({
        sceneId: z.string(),
        nodeId: z.string(),
        path: z.string(),
        intensity: z.number().min(0).max(1).default(1),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'importLut';

      const scene = host.snapshot.scenes.find((s) => s.id === params.sceneId),
        node = scene?.nodes.find((n) => n.id === params.nodeId);
      if (!node) throw new VmotionError('NOT_FOUND', 'Target layer not found');
      const source = await readFile(path.resolve(params.path), 'utf8');
      if (source.length > 8 * 1024 * 1024)
        throw new VmotionError('LUT_SIZE', 'LUT file is too large');
      const effect = parseCube(source, params.intensity ?? 1);
      return host.transact(
        [
          {
            type: 'updateNode',
            sceneId: scene!.id,
            nodeId: node.id,
            patch: { effects: [...node.effects, effect] },
          },
        ],
        params.revision,
      );
    },
  ),
  effectsPlan: defineRpcHandler(
    z.object(effectsPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'effectsPlan';

      const snapshot = host.snapshot,
        planned = await planEffects(host.renderer, snapshot, params),
        p = planned.request,
        operations = await host.edit(snapshot, p.sceneId, p.frame, planned.edits),
        candidate = applyOperations(host.root, snapshot, operations),
        input = {
          revision: snapshot.revision,
          operations,
          samples: planned.samples,
          width: 320,
          determinism: true,
        };
      return builtinCandidate(host.root, input, candidate.revision, p.delivery, {
        layers: planned.layers,
      });
    },
  ),
  effectGraphPlan: defineRpcHandler(
    z.object(effectGraphPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'effectGraphPlan';

      const snapshot = structuredClone(host.snapshot),
        planned = await planEffectGraph(host.root, host.renderer, snapshot, params, host.edit),
        input = {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          width: 320,
          visual: true,
          determinism: true,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        {
          source: planned.source,
          layers: planned.layers,
          coverage: planned.coverage,
          summary: planned.summary,
        },
      );
    },
  ),
  visualPlan: defineRpcHandler(
    z.object(visualPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'visualPlan';

      const snapshot = structuredClone(host.snapshot),
        planned = await planVisual(host.root, host.renderer, snapshot, params, host.edit),
        input = {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          width: 320,
          visual: true,
          determinism: true,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        {
          source: planned.source,
          layers: planned.layers,
          coverage: planned.coverage,
          summary: planned.summary,
        },
      );
    },
  ),
  motionPlan: defineRpcHandler(
    z.object(motionPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'motionPlan';

      const snapshot = structuredClone(host.snapshot),
        planned = await planMotion(host.root, host.renderer, snapshot, params, host.edit),
        input = {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          visual: true,
          determinism: true,
          width: 320,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        {
          layers: planned.layers,
          sources: planned.sources,
          savedTemplates: planned.savedTemplates,
          coverage: planned.coverage,
        },
      );
    },
  ),
  particlesInspect: defineRpcHandler(
    z.object(particlesInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'particlesInspect';

      return inspectParticles(params);
    },
  ),
  particlesPlan: defineRpcHandler(
    z.object(particlesPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'particlesPlan';

      return planParticles(host.root, host.renderer, structuredClone(host.snapshot), params);
    },
  ),
  transitionPlan: defineRpcHandler(
    z.object(transitionPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'transitionPlan';

      return planTransitions(host.root, structuredClone(host.snapshot), params);
    },
  ),
  effectsGuide: defineRpcHandler(
    z.object(effectGuideSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'effectsGuide';

      return effectGuide(params);
    },
  ),
  effectsInspect: defineRpcHandler(
    z.object(effectsInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'effectsInspect';

      return inspectEffects(host.renderer, host.snapshot, params);
    },
  ),
  effectGraphQuery: defineRpcHandler(
    z.object(effectGraphQuerySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'effectGraphQuery';

      return queryEffectGraph(host.renderer, host.snapshot, params);
    },
  ),
  effectGraphInspect: defineRpcHandler(
    z
      .object(effectGraphInspectSchema.shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'effectGraphInspect';

      return inspectEffectGraph(host.renderer, host.snapshot, params);
    },
  ),
  visualTemplates: defineRpcHandler(
    z.object(visualTemplatesSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'visualTemplates';

      return visualTemplates(params);
    },
  ),
  motionTemplates: defineRpcHandler(
    z.object(motionTemplatesSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'motionTemplates';

      return motionTemplates(host.snapshot, params);
    },
  ),
};
