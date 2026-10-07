import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import { materialEdits, scene3dMaterialsSchema } from '../service/materials3d.js';
import {
  generateMesh,
  importMesh,
  inspectMeshResource,
  meshGenerateSchema,
  meshImportSchema,
  meshInspectSchema,
} from '../service/meshes.js';
import { applyOperations } from '../service/operations.js';
import { inspectRasterScene, scene3dRenderSchema } from '../service/scene3d.js';
import { builtinCandidate } from './candidate.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const scene3dPlugin: BuiltinPluginModule = {
  id: 'vmotion.3d',
  name: '三维网格、材质与取证',
  version: '1.0.0',
  dependencies: { 'vmotion.math': '^1.0.0' },
  methods: new Set([
    'scene3dMaterials',
    'meshGenerate',
    'meshImport',
    'meshInspect',
    'scene3dRender',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'scene3d_materials',
        description:
          'Inspect current per-instance materials/light controls without vertex arrays, or plan stable-instance-ID material/lighting edits for a scene3d layer in any scope. Supports metallic/roughness/emissive/unlit/smooth/flat/double-sided materials, directional/point lights and exposure/tone mapping. Existing numeric keys update at the requested frame; reset removes material keys. Returns exact stored planId for preflight/apply and one undo; replacing animated lights requires explicit key reset.',
        method: 'scene3dMaterials',
        schema: scene3dMaterialsSchema.shape,

        categories: ['3d'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'mesh_generate',
        description:
          'Plan a reusable JSON mesh resource (box/sphere/cylinder/cone/torus/plane), optionally placing a meshSource scene3d layer in a native/group/component scope with automatic camera fit. Returns summary/topology and compact candidate/apply plan IDs by default; preflight and apply unchanged for one undo. No project edits during planning. delivery=inline returns exact operations.',
        method: 'meshGenerate',
        schema: meshGenerateSchema.shape,

        categories: ['3d'],
        keywords: '三维 网格 生成 球体 圆柱 圆锥 圆环 模型 形体',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'mesh_import',
        description:
          'Plan local OBJ geometry import with line diagnostics, negative indices, concave polygon triangulation, object/group filters and explicit material colors. Preserves UV/normal corner references as resource metadata; renderer remains flat/opaque. Captures source SHA-256, saves versioned project JSON via candidate/apply, optionally places a meshSource layer. Returns compact plan IDs; no model/API calls or automatic MTL/texture loading.',
        method: 'meshImport',
        schema: meshImportSchema.innerType().shape,

        categories: ['3d'],
        keywords: '三维 模型 导入 OBJ 网格 分组 凹多边形',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'mesh_inspect',
        description:
          'Inspect a pinned project mesh resource or inline mesh: bounds, area, signed volume, boundary/nonmanifold/inconsistent edges and degenerate faces. Paginate face geometry, normals, centers and source groups without dumping every vertex. Mesh identity edges are used; unwelded coincident vertices are reported as boundaries.',
        method: 'meshInspect',
        schema: meshInspectSchema.shape,

        categories: ['3d'],
        keywords: '三维 网格 检查 边界 体积 面 拓扑',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'scene3d_render',
        description:
          'Render a supplied scene or a current scene3d layer with native per-sample depth testing. Return color, normalized eye-depth and face-ID PNG evidence, visible-pixel counts, stable face/object IDs and requested pixel picks. Supports nested composition paths, frame/contextFrames and revision. Opaque flat-shaded meshes with 1/4 antialias samples; outer layer effects/masks are excluded from this local inspection.',
        method: 'scene3dRender',
        schema: scene3dRenderSchema.omit({ inline: true }).shape,

        categories: ['3d'],
        keywords: '三维 深度 遮挡 像素 网格 抗锯齿 对象图 深度图',
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
    return invokeRpcHandler(scene3dRpcHandlers, host, method, params);
  },
};

export const scene3dRpcHandlers = {
  scene3dMaterials: defineRpcHandler(
    z.object(scene3dMaterialsSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'scene3dMaterials';
      const snapshot = host.snapshot;
      const edited = await materialEdits(host.renderer, snapshot, params),
        p = edited.request;
      if (!edited.patch) return edited.report;
      const operations = await host.edit(snapshot, p.sceneId, p.frame, [
          { nodeId: p.nodeId, path: p.path, contextFrames: p.contextFrames, patch: edited.patch },
        ]),
        candidate = applyOperations(host.root, snapshot, operations),
        input = {
          revision: snapshot.revision,
          operations,
          samples: [
            { sceneId: p.sceneId, path: p.path, contextFrames: p.contextFrames, frame: p.frame },
          ],
          width: 320,
          determinism: true,
        };
      return builtinCandidate(host.root, input, candidate.revision, p.delivery, {
        ...edited.report,
        planned: edited.planned,
      });
    },
  ),
  meshGenerate: defineRpcHandler(
    z.object(meshGenerateSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'meshGenerate';
      const snapshot = host.snapshot;
      return generateMesh(host.renderer, host.root, structuredClone(snapshot), params);
    },
  ),
  meshImport: defineRpcHandler(
    z
      .object(meshImportSchema.innerType().shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'meshImport';
      const snapshot = host.snapshot;
      return importMesh(host.renderer, host.root, structuredClone(snapshot), params);
    },
  ),
  meshInspect: defineRpcHandler(
    z.object(meshInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'meshInspect';
      const snapshot = host.snapshot;
      return inspectMeshResource(snapshot, params);
    },
  ),
  scene3dRender: defineRpcHandler(
    z
      .object(scene3dRenderSchema.omit({ inline: true }).shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'scene3dRender';
      const snapshot = host.snapshot;
      return inspectRasterScene(host.root, host.renderer, structuredClone(snapshot), params);
    },
  ),
};
