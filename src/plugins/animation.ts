import { z } from 'zod';
import { contextFramesSchema } from '../core/content-time.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { animationReference } from '../sdk/reference.js';
import {
  animationLayersInspectSchema,
  animationLayersPlanSchema,
  inspectAnimationLayers,
  planAnimationLayers,
} from '../service/animation-layers.js';
import {
  animationEdits,
  animationEditSchema,
  animationInspectSchema,
  inspectAnimation,
} from '../service/animation.js';
import {
  editComponentParameters,
  inspectComponentParameters,
  parameterEditSchema,
} from '../service/component-parameters.js';
import {
  editContentTime,
  inspectContentTime,
  timeEditSchema,
  timeInspectSchema,
} from '../service/content-time.js';
import {
  curvePathSchema,
  driversInspectSchema,
  driversPlanSchema,
  inspectCurve,
  inspectDrivers,
  planDrivers,
} from '../service/drivers.js';
import { parameterQuerySchema, queryParameters } from '../service/parameter-query.js';
import { builtinCandidate } from './candidate.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const animationPlugin: BuiltinPluginModule = {
  id: 'vmotion.animation',
  name: '属性、关键帧与组件控制',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0' },
  methods: new Set([
    'driversInspect',
    'driversPlan',
    'curvePath',
    'animationInspect',
    'animationEdit',
    'timeInspect',
    'timeEdit',
    'componentParameters',
    'componentParametersEdit',
    'component',
    'componentQuery',
    'guide',
    'animationLayersInspect',
    'animationLayersPlan',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'animation_layers_inspect',
        method: 'animationLayersInspect',
        schema: animationLayersInspectSchema.shape,
        description:
          'Page ordered add/multiply/replace animation layers, scoped clocks/weights/channels and sampled mixed values. Defaults to 8 layers/16 channels without key arrays; selected key pages explicit. Values precede drivers; reports coverage and stable IDs without source dumps.',
        categories: ['animation', 'composition'],
        keywords: '动画 叠层 混合 位移 缩放 权重 循环 layer blend mix',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'animation_layers_plan',
        method: 'animationLayersPlan',
        schema: animationLayersPlanSchema.shape,
        description:
          'Batch stable-ID animation-layer append/update/remove/move/toggle/duplicate/channel edits across scenes and generated scopes. Keeps original keys/source, remaps layer-control channel indices and returns one exact stored candidate for preflight/apply/undo. Ordered weighted add/multiply/replace, local clocks and bounded pose checks.',
        categories: ['animation', 'composition'],
        keywords: '动画 层 编排 叠加 候选 顺序 权重 keys motion layer',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'animation_guide',
        description:
          'Read composable animation/effect helpers, frame/second units, examples and current limits before authoring TypeScript animation.',
        method: 'guide',
        schema: {},

        categories: ['animation', 'math'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'component_query',
        method: 'componentQuery',
        schema: parameterQuerySchema.shape,
        description:
          'Read compact paged parameter values/default previews and numeric channels for one component or template instance. Select relative parameter paths, page arrays/channels without repeating full schemas, and request includeSchema/fullValues explicitly. Values cover theme and native keys at the supplied local frame; this is not final driver/pixel evidence.',
        categories: ['animation', 'composition'],
        keywords: '组件 参数 查询 路径 分页 模板 数值 animation parameter inspect',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drivers_inspect',
        description:
          'Inspect evaluated property expressions, responsive layout constraints and curved motion paths at local frames. Returns actual pose/value dependency evidence, stable layer references and shared driver descriptions without full project source. Native key values precede drivers; expression outputs override layout/path fields. Cycles/missing references/nonfinite outputs have precise diagnostics.',
        method: 'driversInspect',
        schema: driversInspectSchema.shape,

        categories: ['animation', 'composition'],
        keywords: '属性 表达式 依赖 布局 约束 路径 曲线 朝向 求值 检查',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drivers_plan',
        description:
          'Plan an atomic multi-scene batch of property expressions, responsive parent/scene/sibling layout constraints, SVG/shape-referenced arc-length motion and their numeric keys. Expression fields resolve lazy dependencies and deterministic clocks; generated edits persist overrides. Returns exact stored candidate for native preflight/apply and one undo, with sample coverage.',
        method: 'driversPlan',
        schema: driversPlanSchema.shape,

        categories: ['animation', 'composition'],
        keywords: '属性 表达式 联动 依赖 布局 锚点 宽高比 留边 路径 曲线 组合 计划',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'curve_path',
        description:
          'Measure and sample SVG line/quadratic/cubic/arc motion by length, returning local position, tangent, auto-facing angle and multi-contour jump evidence. Clamp/loop/pingpong handle progress without state. Pure geometry query; does not edit project files.',
        method: 'curvePath',
        schema: curvePathSchema.shape,

        categories: ['animation', 'vector'],
        keywords: '曲线 路径 运动 弧长 切线 朝向 SVG 贝塞尔',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'animation_inspect',
        description:
          'Read layer animation channels and sample evaluated values plus numerical velocity per second at chosen frames. Supports native and generated layers and structured component numeric paths.',
        method: 'animationInspect',
        schema: animationInspectSchema.shape,

        categories: ['effects', 'animation'],
        keywords: '动画 关键帧 通道 速度',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'animation_edit',
        description:
          'Atomically edit keyframes across multiple layers. Actions upsert/remove/ease/transform support selected channels, times or ranges; transform can copy, shift/scale time and values around pivots. Defaults reject time collisions. Component defaults are materialized; generated edits persist as owner overrides.',
        method: 'animationEdit',
        schema: animationEditSchema.shape,

        categories: ['effects', 'animation'],
        keywords: '动画 关键帧 复制 移动 曲线 缓动',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'time_inspect',
        description:
          'Inspect visual content clocks for a video/component/scene reference: normalized mapping, remap channels, parent-to-source sampled frames, repeat bounds and visibility. Layer transforms/parameters remain on the parent clock while visual content uses the mapped source clock. Nested edits use local frame plus contextFrames from composition_interactions.',
        method: 'timeInspect',
        schema: timeInspectSchema.shape,

        categories: ['animation', 'editing'],
        keywords: '时间 时钟 倒放 重映射',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'time_edit',
        description:
          'Revision-checked visual retiming with one undo step: rate/offset/anchor, negative-rate reverse, freeze, clamp/loop/pingpong/blank bounds, numeric remap keys with easing, or reset. Scene/video asset durations are inferred; components need explicit duration for bounded modes. Audio is not implicitly retimed by these visual-layer controls.',
        method: 'timeEdit',
        schema: timeEditSchema.shape,

        categories: ['animation', 'editing'],
        keywords: '时间 倒放 冻结 重映射 变速 循环',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'component_parameters',
        description:
          'Inspect parameter descriptors, defaults, JSON Schema, resolved/evaluated values and numeric animation channels for a native or generated programmable component.',
        method: 'componentParameters',
        schema: {
          sceneId: z.string(),
          nodeId: z.string(),
          path: z.array(z.string()).max(32).default([]),
          contextFrames: contextFramesSchema.default([]),
          frame: z.number().int().nonnegative().default(0),
        },

        categories: ['animation'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'component_parameters_edit',
        description:
          'Edit numeric/string/color/boolean/enum/vector/array/object parameters by relative parameter paths, reset defaults or create numeric leaf keyframes. Materializes defaults and preserves sibling values; creates one undo step and supports generated component overrides.',
        method: 'componentParametersEdit',
        schema: parameterEditSchema.shape,

        categories: ['animation'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'component_describe',
        description: 'Read the editable parameter schema of a TypeScript component.',
        method: 'component',
        schema: { source: z.string() },

        categories: ['animation'],
        keywords: '',
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
    return invokeRpcHandler(animationRpcHandlers, host, method, params);
  },
};

export const animationRpcHandlers = {
  animationLayersInspect: defineRpcHandler(
    z
      .object(animationLayersInspectSchema.shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'animationLayersInspect';
      const snapshot = host.snapshot;
      return inspectAnimationLayers(host.renderer, snapshot, params);
    },
  ),
  animationLayersPlan: defineRpcHandler(
    z
      .object(animationLayersPlanSchema.shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'animationLayersPlan';
      const snapshot = host.snapshot;
      const planned = await planAnimationLayers(
        host.root,
        host.renderer,
        structuredClone(snapshot),
        params,
        host.edit,
      );
      return builtinCandidate(
        host.root,
        {
          revision: snapshot.revision,
          operations: planned.operations,
          samples: planned.samples,
          width: 320,
          determinism: true,
          visual: true,
        },
        planned.candidate.revision,
        planned.request.delivery,
        { layers: planned.layers, coverage: planned.coverage },
      );
    },
  ),
  guide: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'guide';
      const snapshot = host.snapshot;
      return animationReference;
    },
  ),
  componentQuery: defineRpcHandler(
    z.object(parameterQuerySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'componentQuery';
      const snapshot = host.snapshot;
      return queryParameters(host.renderer, snapshot, params);
    },
  ),
  driversInspect: defineRpcHandler(
    z.object(driversInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'driversInspect';
      const snapshot = host.snapshot;
      return inspectDrivers(host.renderer, snapshot, params);
    },
  ),
  driversPlan: defineRpcHandler(
    z.object(driversPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'driversPlan';
      const snapshot = host.snapshot;
      const base = structuredClone(snapshot),
        planned = await planDrivers(host.root, host.renderer, base, params, host.edit),
        input = {
          revision: base.revision,
          operations: planned.operations,
          samples: planned.samples,
          width: 320,
          determinism: true,
          visual: true,
        };
      return builtinCandidate(
        host.root,
        input,
        planned.candidate.revision,
        planned.request.delivery,
        { layers: planned.layers, coverage: planned.coverage },
      );
    },
  ),
  curvePath: defineRpcHandler(
    z.object(curvePathSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'curvePath';
      const snapshot = host.snapshot;
      return inspectCurve(params);
    },
  ),
  animationInspect: defineRpcHandler(
    z.object(animationInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'animationInspect';
      const snapshot = host.snapshot;
      return inspectAnimation(host.renderer, snapshot, params);
    },
  ),
  animationEdit: defineRpcHandler(
    z.object(animationEditSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'animationEdit';
      const snapshot = host.snapshot;
      const edited = await animationEdits(host.renderer, snapshot, params),
        operations = await host.edit(
          snapshot,
          edited.request.sceneId,
          edited.request.frame,
          edited.edits,
        );
      return host.transact(operations, edited.request.revision ?? snapshot.revision);
    },
  ),
  timeInspect: defineRpcHandler(
    z.object(timeInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'timeInspect';
      const snapshot = host.snapshot;
      return inspectContentTime(host.renderer, snapshot, params);
    },
  ),
  timeEdit: defineRpcHandler(
    z.object(timeEditSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'timeEdit';
      const snapshot = host.snapshot;
      const edited = await editContentTime(host.renderer, snapshot, params),
        operations = await host.edit(snapshot, edited.request.sceneId, edited.request.frame, [
          {
            nodeId: edited.nodeId,
            path: edited.request.path,
            contextFrames: edited.request.contextFrames,
            patch: edited.patch,
          },
        ]),
        state = await host.transact(operations, edited.request.revision ?? snapshot.revision);
      return { ...state, timing: edited.sample };
    },
  ),
  componentParameters: defineRpcHandler(
    z
      .object({
        sceneId: z.string(),
        nodeId: z.string(),
        path: z.array(z.string()).max(32).default([]),
        contextFrames: contextFramesSchema.default([]),
        frame: z.number().int().nonnegative().default(0),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'componentParameters';
      const snapshot = host.snapshot;
      const inspected = await inspectComponentParameters(host.renderer, snapshot, params);
      return {
        nodeId: inspected.node.id,
        source: inspected.node.component,
        parameters: inspected.metadata.parameters,
        jsonSchema: inspected.metadata.jsonSchema,
        defaults: inspected.metadata.defaults,
        values: inspected.values,
        evaluated: inspected.evaluated,
        revision: inspected.revision,
        channels: inspected.channels,
        channelCount: inspected.total,
        truncated: inspected.truncated,
      };
    },
  ),
  componentParametersEdit: defineRpcHandler(
    z.object(parameterEditSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'componentParametersEdit';
      const snapshot = host.snapshot;
      const edited = await editComponentParameters(host.renderer, snapshot, params),
        operations = await host.edit(snapshot, edited.request.sceneId, edited.request.frame, [
          {
            path: edited.request.path,
            contextFrames: edited.request.contextFrames,
            nodeId: edited.nodeId,
            patch: edited.patch,
          },
        ]),
        state = await host.transact(operations, edited.request.revision ?? snapshot.revision);
      return { ...state, parameterValues: edited.values };
    },
  ),
  component: defineRpcHandler(
    z.object({ source: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'component';
      const snapshot = host.snapshot;
      return host.renderer.components.describe(snapshot, params.source);
    },
  ),
};
