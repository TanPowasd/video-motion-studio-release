import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import {
  drawingDocumentSchema,
  type DrawingDocument,
  type DrawingStroke,
} from './drawing-model.js';
import type { Node } from './model.js';

export function normalizeDrawing(
  resource: unknown,
  fallback: Pick<Node, 'id' | 'name' | 'width' | 'height' | 'stroke' | 'fill' | 'strokeWidth'>,
): DrawingDocument {
  if (resource && typeof resource === 'object' && 'layers' in resource)
    return drawingDocumentSchema.parse(resource);
  const points = (resource as { points?: unknown[] })?.points ?? [];
  return drawingDocumentSchema.parse({
    id: fallback.id,
    name: fallback.name,
    width: Math.max(16, Math.round(fallback.width)),
    height: Math.max(16, Math.round(fallback.height)),
    layers: [
      {
        id: 'legacy',
        name: '笔迹',
        strokes: points.length
          ? [
              {
                id: 'legacy-stroke',
                points,
                color: fallback.stroke || fallback.fill,
                width: Math.max(0.5, fallback.strokeWidth),
              },
            ]
          : [],
      },
    ],
  });
}
export function paintStroke(ctx: SKRSContext2D, stroke: DrawingStroke) {
  ctx.save();
  try {
    ctx.globalAlpha *= stroke.opacity;
    ctx.globalCompositeOperation = stroke.tool === 'eraser' ? 'destination-out' : 'source-over';
    ctx.fillStyle = stroke.color;
    const points = stroke.points;
    const radius = (pressure: number) => Math.max(0.25, (stroke.width * pressure) / 2);
    ctx.beginPath();
    for (const p of points) {
      const r = radius(p.pressure);
      ctx.moveTo(p.x + r, p.y);
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.closePath();
    }
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i],
        length = Math.hypot(b.x - a.x, b.y - a.y);
      if (!length) continue;
      const nx = (b.y - a.y) / length,
        ny = -(b.x - a.x) / length,
        ra = radius(a.pressure),
        rb = radius(b.pressure);
      ctx.moveTo(a.x + nx * ra, a.y + ny * ra);
      ctx.lineTo(b.x + nx * rb, b.y + ny * rb);
      ctx.lineTo(b.x - nx * rb, b.y - ny * rb);
      ctx.lineTo(a.x - nx * ra, a.y - ny * ra);
      ctx.closePath();
    }
    ctx.fill();
  } finally {
    ctx.restore();
  }
}
export function paintDrawing(ctx: SKRSContext2D, doc: DrawingDocument) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, doc.width, doc.height);
  ctx.clip();
  try {
    // Isolate each layer, so an eraser removes only paint from that layer.
    for (const layer of doc.layers) {
      if (!layer.visible || !layer.opacity || !layer.strokes.length) continue;
      const surface = createCanvas(ctx.canvas.width, ctx.canvas.height),
        target = surface.getContext('2d');
      try {
        target.setTransform(ctx.getTransform());
        target.translate(layer.x, layer.y);
        for (const stroke of layer.strokes) paintStroke(target, stroke);
        ctx.save();
        try {
          ctx.resetTransform();
          ctx.globalAlpha *= layer.opacity;
          ctx.globalCompositeOperation = layer.blend;
          ctx.drawImage(surface, 0, 0);
        } finally {
          ctx.restore();
        }
      } finally {
        surface.width = 1;
        surface.height = 1;
      }
    }
  } finally {
    ctx.restore();
  }
}
export function drawingInkBounds(doc: DrawingDocument) {
  let left = Infinity,
    top = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const layer of doc.layers) {
    if (!layer.visible || !layer.opacity) continue;
    for (const s of layer.strokes) {
      if (s.tool === 'eraser' || !s.opacity) continue;
      for (const p of s.points) {
        const r = Math.max(0.25, (s.width * p.pressure) / 2),
          x = p.x + layer.x,
          y = p.y + layer.y;
        left = Math.min(left, x - r);
        top = Math.min(top, y - r);
        right = Math.max(right, x + r);
        bottom = Math.max(bottom, y + r);
      }
    }
  }
  return Number.isFinite(left)
    ? { x: left, y: top, width: Math.max(1, right - left), height: Math.max(1, bottom - top) }
    : { x: 0, y: 0, width: doc.width, height: doc.height };
}
export function drawingFrame(
  doc: DrawingDocument,
  width: number,
  height: number,
  thumbnail = false,
) {
  const canvas = createCanvas(width, height),
    ctx = canvas.getContext('2d'),
    bounds = thumbnail
      ? drawingInkBounds(doc)
      : { x: 0, y: 0, width: doc.width, height: doc.height },
    padding = thumbnail ? Math.max(2, Math.min(width, height) * 0.1) : 0,
    scale = Math.min((width - 2 * padding) / bounds.width, (height - 2 * padding) / bounds.height);
  ctx.translate((width - bounds.width * scale) / 2, (height - bounds.height * scale) / 2);
  ctx.scale(scale, scale);
  ctx.translate(-bounds.x, -bounds.y);
  paintDrawing(ctx, doc);
  return canvas;
}
