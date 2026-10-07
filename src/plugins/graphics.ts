import { z } from 'zod';
import { repeatDescribeSchema } from '../core/repeater-schema.js';
import { pathGeometrySchema } from '../core/vector-schema.js';
import { pathGeometry } from '../core/vector.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { describeRepeater } from '../sdk/repeater.js';
import {
  graphicsInspectSchema,
  graphicsPlanSchema,
  inspectGraphics,
  planGraphics,
} from '../service/graphics.js';
import { applyOperations } from '../service/operations.js';
import { createRepeater, repeatCreateSchema } from '../service/repeater.js';
import { compositionStructure } from '../service/structure.js';
import { bakeVector, vectorBakeSchema } from '../service/vector.js';
import { builtinCandidate } from './candidate.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const graphicsPlugin: BuiltinPluginModule = {
  id: 'vmotion.vector',
  name: '文字、矢量与重复器',
  version: '1.0.0',
  dependencies: { 'vmotion.effects': '^1.0.0' },
  methods: new Set([
    'graphicsInspect',
    'graphicsPlan',
    'pathGeometry',
    'vectorBake',
    'repeatDescribe',
    'repeatCreate',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'graphics_inspect',
        description:
          'Inspect text/path typography or native shape operators at the final evaluated pose. Returns shared local bounds/world matrix, stable stack IDs/channels, text line/word/grapheme counts and paginated glyph poses (16 by default). SVG and full values are opt-in. Rendering and selection use the same layout/geometry.',
        method: 'graphicsInspect',
        schema: graphicsInspectSchema.shape,

        categories: ['animation', 'composition', 'vector'],
        keywords:
          '文字 排版 字素 单词 行 范围 路径文字 形状 算子 几何 查询 检查 typography glyph selector shape',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'graphics_plan',
        description:
          'Plan a batch of path text, range text animators and ordered shape operators across native/generated layers. Stable-ID append/update/copy/move/toggle/remove/keys preserve indexed channels and expression targets. Operators: trim/round/dash/outline/transform/boolean/closed offset. Text selectors: grapheme/word/line and percent/index ranges. Returns a short stored candidate for unchanged preflight/apply and one undo; preserves TypeScript. Expression index references require explicit rewrites before topology changes.',
        method: 'graphicsPlan',
        schema: graphicsPlanSchema.shape,

        categories: ['animation', 'composition', 'vector'],
        keywords:
          '文字 动画 字词行 范围选择器 路径文字 形状 算子 堆栈 圆角 偏移 虚线 轮廓 布尔 批量 计划 typography shape operator',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'path_geometry',
        description:
          'Compute native SVG path geometry without editing files: boolean union/difference/intersect/xor/reverseDifference, simplify, rounded corners, solid stroke outline, trim or bounds. Operands may have affine transforms and evenodd filling. Returns SVG, winding rule and local bounds; trim uses combined contour length, offset in turns and wraps when start > end. Apply returned SVG through a transaction or component source.',
        method: 'pathGeometry',
        schema: pathGeometrySchema.shape,

        categories: ['vector'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'vector_bake',
        description:
          'Create a new static editable vector path from sibling rect/ellipse/path layers at one frame. Supports boolean operations, simplify, rounded corners and solid stroke outline; preserves source layers/code, optionally hides operands, commits one revision-checked undo step, and handles generated component structure/overrides. This bakes geometry and local transforms, not pixel effects or source animations; the first operand supplies solid fill/opacity.',
        method: 'vectorBake',
        schema: vectorBakeSchema.shape,

        categories: ['vector'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'repeat_describe',
        description:
          'Calculate a repeater pattern before editing: normalized parameters, fractional copy opacity, exact affine transforms at up to 128 indices, stable copy IDs and a conservative union bound for an optional source rectangle. Does not generate project files. Use frame_capture/visual_audit for actual clipping, mask/effect visibility and visual quality.',
        method: 'repeatDescribe',
        schema: repeatDescribeSchema.shape,

        categories: ['animation', 'vector'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'repeat_create',
        description:
          'Create a fully editable TypeScript repeater component from selected sibling layers and their descendants. Linear/grid/radial patterns, fractional counts, rotation/scale/skew/pivot, opacity and stacking parameters are exposed to the inspector and component_parameters_edit keyframes. Source layers/code are preserved; optional hiding and creation use one revision-checked undo step. Generated source contains a copied base graph, not a live link to every original layer. Per-copy edits persist as normal component overrides.',
        method: 'repeatCreate',
        schema: repeatCreateSchema.shape,

        categories: ['animation', 'vector'],
        keywords: '',
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
    return invokeRpcHandler(graphicsRpcHandlers, host, method, params);
  },
};

export const graphicsRpcHandlers = {
  graphicsInspect: defineRpcHandler(
    z.object(graphicsInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'graphicsInspect';
      const snapshot = host.snapshot;
      return inspectGraphics(host.renderer, snapshot, params);
    },
  ),
  graphicsPlan: defineRpcHandler(
    z.object(graphicsPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'graphicsPlan';
      const snapshot = host.snapshot;
      const base = structuredClone(snapshot),
        planned = await planGraphics(host.renderer, base, params),
        p = planned.request,
        operations = await host.edit(base, p.sceneId, p.frame, planned.edits),
        candidate = applyOperations(host.root, base, operations),
        input = {
          revision: base.revision,
          operations,
          samples: planned.samples,
          width: 320,
          determinism: true,
          visual: true,
        };
      return builtinCandidate(host.root, input, candidate.revision, p.delivery, {
        layers: planned.layers,
        sampleCoverage: planned.coverage,
      });
    },
  ),
  pathGeometry: defineRpcHandler(
    z.object(pathGeometrySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'pathGeometry';
      const snapshot = host.snapshot;
      return pathGeometry(params);
    },
  ),
  vectorBake: defineRpcHandler(
    z.object(vectorBakeSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'vectorBake';
      const snapshot = host.snapshot;
      const baked = await bakeVector(host.renderer, snapshot, params),
        request = baked.request,
        edit = await compositionStructure(
          host.renderer,
          snapshot,
          request.sceneId,
          request.frame,
          request.path,
          { type: 'add', node: baked.node },
          request.contextFrames,
        );
      let candidate = applyOperations(host.root, snapshot, edit.operations);
      if (request.hideSources)
        candidate = applyOperations(
          host.root,
          candidate,
          await host.edit(
            candidate,
            request.sceneId,
            request.frame,
            request.nodeIds.map((nodeId) => ({
              path: request.path,
              contextFrames: request.contextFrames,
              nodeId,
              patch: { visible: false },
            })),
          ),
        );
      const scene = candidate.scenes.find((s) => s.id === request.sceneId)!;
      await host.transact(
        [{ type: 'updateScene', sceneId: request.sceneId, patch: { nodes: scene.nodes } }],
        request.revision ?? snapshot.revision,
      );
      return {
        ...host.select(edit.selection),
        geometry: baked.geometry,
        warnings: baked.warnings,
      };
    },
  ),
  repeatDescribe: defineRpcHandler(
    z.object(repeatDescribeSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'repeatDescribe';
      const snapshot = host.snapshot;
      return describeRepeater(params);
    },
  ),
  repeatCreate: defineRpcHandler(
    z.object(repeatCreateSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'repeatCreate';
      const snapshot = host.snapshot;
      const created = await createRepeater(host.root, host.renderer, snapshot, params),
        request = created.request;
      let candidate = applyOperations(host.root, snapshot, created.operations);
      if (request.hideSources)
        candidate = applyOperations(
          host.root,
          candidate,
          await host.edit(
            candidate,
            request.sceneId,
            request.frame,
            created.sourceIds.map((nodeId) => ({
              path: request.path,
              contextFrames: request.contextFrames,
              nodeId,
              patch: { visible: false },
            })),
          ),
        );
      const scene = candidate.scenes.find((s) => s.id === request.sceneId)!;
      await host.transact(
        [
          created.operations[0],
          { type: 'updateScene', sceneId: request.sceneId, patch: { nodes: scene.nodes } },
        ],
        request.revision ?? snapshot.revision,
      );
      return {
        ...host.select(created.selection),
        repeater: {
          sourceFile: created.sourceFile,
          parameters: created.parameters,
          sourceIds: created.sourceIds,
          sourceNodes: created.sourceNodes,
          generatedNodes: created.generatedNodes,
        },
      };
    },
  ),
};
