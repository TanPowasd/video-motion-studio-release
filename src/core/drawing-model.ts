import { z } from 'zod';
const id = z.string().min(1).max(200),
  number = z.number().finite();
export const drawingStrokeSchema = z
  .object({
    id,
    tool: z.enum(['brush', 'eraser']).default('brush'),
    color: z.string().min(1).default('#c1b6ff'),
    width: number.min(0.5).max(1000).default(6),
    opacity: number.min(0).max(1).default(1),
    points: z
      .array(z.object({ x: number, y: number, pressure: number.min(0).max(1).default(1) }))
      .min(1)
      .max(100000),
  })
  .strict();
export const drawingLayerSchema = z
  .object({
    id,
    name: z.string().min(1).default('图层'),
    visible: z.boolean().default(true),
    locked: z.boolean().default(false),
    x: number.default(0),
    y: number.default(0),
    opacity: number.min(0).max(1).default(1),
    blend: z
      .enum(['source-over', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference'])
      .default('source-over'),
    strokes: z.array(drawingStrokeSchema).max(10000).default([]),
  })
  .strict();
export const drawingDocumentSchema = z
  .object({
    version: z.literal(1).default(1),
    id,
    name: z.string().min(1).default('未命名画稿'),
    width: z.number().int().min(16).max(8192),
    height: z.number().int().min(16).max(8192),
    layers: z.array(drawingLayerSchema).max(256).default([]),
  })
  .strict()
  .superRefine((doc, ctx) => {
    if (doc.width * doc.height > 16777216)
      ctx.addIssue({ code: 'custom', message: '画稿画布最多支持 1600 万像素' });
    if (new Set(doc.layers.map((l) => l.id)).size !== doc.layers.length)
      ctx.addIssue({ code: 'custom', message: '绘画图层 ID 必须唯一' });
    const strokes = doc.layers.flatMap((l) => l.strokes);
    if (new Set(strokes.map((s) => s.id)).size !== strokes.length)
      ctx.addIssue({ code: 'custom', message: '笔迹 ID 必须唯一' });
    if (strokes.reduce((total, s) => total + s.points.length, 0) > 1000000)
      ctx.addIssue({ code: 'custom', message: '单份画稿超过 100 万笔迹采样点，请拆分画稿' });
  });
export type DrawingDocument = z.infer<typeof drawingDocumentSchema>;
export type DrawingLayer = z.infer<typeof drawingLayerSchema>;
export type DrawingStroke = z.infer<typeof drawingStrokeSchema>;
export const drawingOperationSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('stroke'), layerId: id, stroke: drawingStrokeSchema }),
  z.object({
    type: z.literal('addLayer'),
    layer: drawingLayerSchema,
    index: z.number().int().nonnegative().optional(),
  }),
  z.object({
    type: z.literal('updateLayer'),
    layerId: id,
    patch: drawingLayerSchema.omit({ id: true, strokes: true }).partial(),
  }),
  z.object({ type: z.literal('removeLayer'), layerId: id }),
  z.object({ type: z.literal('duplicateLayer'), layerId: id }),
  z.object({ type: z.literal('orderLayers'), ids: z.array(id).max(256) }),
  z.object({
    type: z.literal('updateDocument'),
    patch: z
      .object({
        name: z.string().min(1),
        width: z.number().int().min(16).max(8192),
        height: z.number().int().min(16).max(8192),
      })
      .partial(),
  }),
]);
export type DrawingOperation = z.infer<typeof drawingOperationSchema>;
