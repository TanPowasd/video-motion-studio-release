import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { z } from 'zod';
import { drawingDocumentSchema, drawingOperationSchema } from '../core/drawing-model.js';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import {
  drawingDraftSchema,
  drawingEdit,
  drawingFromAsset,
  drawingPreview,
  getDrawing,
  publishDrawing,
} from '../service/drawings.js';
import { drawingQuerySchema, queryDrawing } from '../service/library-query.js';
import { atomicWrite, safePath } from '../service/project.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';
export const drawingPlugin: BuiltinPluginModule = {
  id: 'vmotion.drawing',
  name: '绘画文档与发布',
  version: '1.0.0',
  methods: new Set([
    'drawingList',
    'drawingGet',
    'drawingCreate',
    'drawingEdit',
    'drawingPublish',
    'drawingOpenAsset',
    'drawingFrame',
    'drawingQuery',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'drawing_query',
        method: 'drawingQuery',
        schema: drawingQuerySchema.shape,
        description:
          'Inspect paged drawing layers/strokes by stable IDs without returning every brush point. Layer counts, stroke appearance and point totals are compact; includePoints requests an explicit bounded point page. Coordinates are layer-local with pressure. drawing_get keeps the full editable document; drawing_frame supplies native pixels.',
        categories: ['drawing'],
        keywords: '绘画 画稿 图层 笔迹 压感 分页 query stroke layer',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_list',
        description:
          'List independent drawing documents. Documents are separate from scene layers until published and placed.',
        method: 'drawingList',
        schema: {},

        categories: ['drawing'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_get',
        description:
          'Read editable layers, brush strokes and document size for an independent drawing document.',
        method: 'drawingGet',
        schema: { id: z.string() },

        categories: ['drawing'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_create',
        description:
          'Create a transparent layered drawing document without adding scene layers or publishing assets.',
        method: 'drawingCreate',
        schema: {
          id: z.string().optional(),
          name: z.string().optional(),
          width: z.number().int().min(16).max(8192).optional(),
          height: z.number().int().min(16).max(8192).optional(),
          revision: z.string().optional(),
        },

        categories: ['drawing'],
        keywords: '绘画 创建 画稿',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_edit',
        description:
          'Apply brush/eraser strokes, create/edit/delete/copy/order layers, or update document dimensions atomically. Uses the shared undo history and revision checks.',
        method: 'drawingEdit',
        schema: {
          id: z.string(),
          operations: z.array(drawingOperationSchema).min(1).max(1000),
          revision: z.string().optional(),
        },

        categories: ['drawing'],
        keywords: '绘画 笔迹 笔刷 图层',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_publish',
        description:
          'Publish the whole drawing or selected layers as an immutable visual asset. The source document remains editable.',
        method: 'drawingPublish',
        schema: {
          id: z.string(),
          layerIds: z.array(z.string()).optional(),
          name: z.string().optional(),
          revision: z.string().optional(),
        },

        categories: ['drawing'],
        keywords: '画稿 发布 素材',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_open_asset',
        description:
          'Create an editable drawing document from a published or legacy drawing asset.',
        method: 'drawingOpenAsset',
        schema: { assetId: z.string(), revision: z.string().optional() },

        categories: ['drawing'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'drawing_frame',
        description: 'Get the native rendered image of a drawing document for visual checks.',
        method: 'drawingFrame',
        schema: {
          id: z.string(),
          width: z.number().int().min(16).max(2048).optional(),
          height: z.number().int().min(16).max(2048).optional(),
          output: z.string().optional(),
          inline: z.boolean().default(true),
        },

        categories: ['drawing'],
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
    return invokeRpcHandler(drawingRpcHandlers, host, method, params);
  },
};

export const drawingRpcHandlers = {
  drawingQuery: defineRpcHandler(
    z.object(drawingQuerySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'drawingQuery';
      const snapshot = host.snapshot;
      return queryDrawing(snapshot, params);
    },
  ),
  drawingList: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'drawingList';
      const snapshot = host.snapshot;
      return snapshot.project.drawings;
    },
  ),
  drawingGet: defineRpcHandler(
    z.object({ id: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'drawingGet';
      const snapshot = host.snapshot;
      return { document: getDrawing(snapshot, params.id), revision: snapshot.revision };
    },
  ),
  drawingCreate: defineRpcHandler(
    z
      .object({
        id: z.string().optional(),
        name: z.string().optional(),
        width: z.number().int().min(16).max(8192).optional(),
        height: z.number().int().min(16).max(8192).optional(),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'drawingCreate';
      const snapshot = host.snapshot;
      const id = params.id ?? randomUUID(),
        document = drawingDocumentSchema.parse({
          id,
          name: params.name ?? '未命名画稿',
          width: params.width ?? snapshot.project.width,
          height: params.height ?? snapshot.project.height,
          layers: [{ id: randomUUID(), name: '图层 1', strokes: [] }],
        });
      if (snapshot.project.drawings.some((d) => d.id === id))
        throw new VmotionError('DUPLICATE_ID', '画稿 ID 已存在');
      return {
        ...(await host.transact(
          [{ type: 'writeDrawing', document }],
          params.revision ?? snapshot.revision,
        )),
        document,
      };
    },
  ),
  drawingEdit: defineRpcHandler(
    z
      .object({
        id: z.string(),
        operations: z.array(drawingOperationSchema).min(1).max(1000),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'drawingEdit';
      const snapshot = host.snapshot;
      return drawingEdit(host.drawingService, params.id, params.operations, params.revision);
    },
  ),
  drawingPublish: defineRpcHandler(
    z
      .object({
        id: z.string(),
        layerIds: z.array(z.string()).optional(),
        name: z.string().optional(),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'drawingPublish';
      const snapshot = host.snapshot;
      return publishDrawing(
        host.root,
        host.drawingService,
        params.id,
        params.layerIds,
        params.name,
        params.revision,
      );
    },
  ),
  drawingOpenAsset: defineRpcHandler(
    z
      .object({ assetId: z.string(), revision: z.string().optional() })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'drawingOpenAsset';
      const snapshot = host.snapshot;
      const doc = await drawingFromAsset(host.root, snapshot, params.assetId),
        document = { ...doc, id: randomUUID(), name: doc.name + ' · 编辑' };
      return {
        ...(await host.transact(
          [{ type: 'writeDrawing', document }],
          params.revision ?? snapshot.revision,
        )),
        document,
      };
    },
  ),
  drawingFrame: defineRpcHandler(
    z
      .object({
        id: z.string(),
        width: z.number().int().min(16).max(2048).optional(),
        height: z.number().int().min(16).max(2048).optional(),
        output: z.string().optional(),
        inline: z.boolean().default(true),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'drawingFrame';
      const snapshot = host.snapshot;
      const result = await drawingPreview(
          snapshot,
          params.id,
          params.width,
          params.height,
          params.draft === undefined ? undefined : drawingDraftSchema.parse(params.draft),
        ),
        output = path.resolve(
          params.output ?? safePath(host.root, `.vmotion/frames/drawing-${params.id}.png`),
        );
      await atomicWrite(output, result.buffer);
      return {
        output,
        revision: result.revision,
        mimeType: 'image/png',
        ...(params.inline ? { data: result.buffer.toString('base64') } : {}),
      };
    },
  ),
};
