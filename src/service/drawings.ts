import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import {
  drawingDocumentSchema,
  drawingLayerSchema,
  drawingOperationSchema,
  type DrawingDocument,
  type DrawingOperation,
  type DrawingStroke,
} from '../core/drawing-model.js';
import { drawingFrame, normalizeDrawing } from '../core/drawing-renderer.js';
import { newNode, VmotionError, type Snapshot } from '../core/model.js';
import { atomicWrite, safePath } from './project.js';
import { fingerprint } from '../media/ffmpeg.js';
import type { ProjectService } from './service.js';
import {z} from 'zod';
import {drawingStrokeSchema} from '../core/drawing-model.js';

export const drawingDraftSchema = z.union([
  z.object({layerId:z.string(),stroke:drawingStrokeSchema}).strict(),
  z.object({operations:z.array(drawingOperationSchema).min(1).max(1000)}).strict(),
]);

export function getDrawing(snapshot: Snapshot, id: string) {
  const entry = snapshot.project.drawings.find((d) => d.id === id);
  if (!entry) throw new VmotionError('NOT_FOUND', '画稿不存在');
  return drawingDocumentSchema.parse(JSON.parse(snapshot.files[entry.path]));
}
export async function drawingFromAsset(root: string, snapshot: Snapshot, id: string) {
  const asset = snapshot.project.assets.find((a) => a.id === id);
  if (!asset || asset.type !== 'drawing') throw new VmotionError('ASSET_TYPE', '请选择绘画素材');
  const resource = JSON.parse(await readFile(path.resolve(root, asset.path), 'utf8')),
    source = snapshot.scenes
      .flatMap((s) => s.nodes)
      .find((n) => n.type === 'drawing' && n.assetId === id);
  return normalizeDrawing(
    resource,
    newNode({
      id: asset.id,
      name: asset.name,
      type: 'drawing',
      width: Number(asset.metadata.width ?? source?.width ?? snapshot.project.width),
      height: Number(asset.metadata.height ?? source?.height ?? snapshot.project.height),
      stroke: source?.stroke ?? '#c1b6ff',
      strokeWidth: source?.strokeWidth ?? 6,
    }),
  );
}
export function editDrawing(input: DrawingDocument, operations: DrawingOperation[]) {
  if (!operations.length || operations.length > 1000)
    throw new VmotionError('OPERATIONS', 'Expected 1–1000 drawing edits');
  const doc = structuredClone(input);
  const layer = (id: string) => {
    const value = doc.layers.find((l) => l.id === id);
    if (!value) throw new VmotionError('NOT_FOUND', '绘画图层不存在');
    return value;
  };
  for (const raw of operations) {
    const op = drawingOperationSchema.parse(raw);
    switch (op.type) {
      case 'stroke': {
        const target = layer(op.layerId);
        if (target.locked) throw new VmotionError('LAYER_LOCKED', '绘画图层已锁定');
        target.strokes.push(op.stroke);
        break;
      }
      case 'addLayer':
        doc.layers.splice(op.index ?? doc.layers.length, 0, op.layer);
        break;
      case 'updateLayer':
        Object.assign(layer(op.layerId), op.patch);
        break;
      case 'removeLayer':
        layer(op.layerId);
        doc.layers = doc.layers.filter((l) => l.id !== op.layerId);
        break;
      case 'duplicateLayer': {
        const source = layer(op.layerId),
          copy = structuredClone(source);
        copy.id = randomUUID();
        copy.name += ' 副本';
        copy.strokes.forEach((s) => (s.id = randomUUID()));
        doc.layers.splice(doc.layers.indexOf(source) + 1, 0, copy);
        break;
      }
      case 'orderLayers': {
        if (
          op.ids.length !== doc.layers.length ||
          new Set(op.ids).size !== op.ids.length ||
          op.ids.some((id) => !doc.layers.some((l) => l.id === id))
        )
          throw new VmotionError('LAYER_ORDER', '图层排序必须包含每个图层且仅出现一次');
        doc.layers = op.ids.map((id) => layer(id));
        break;
      }
      case 'updateDocument':
        Object.assign(doc, op.patch);
        break;
    }
  }
  return drawingDocumentSchema.parse(doc);
}
export async function drawingEdit(
  service: Pick<ProjectService, 'snapshot' | 'transact'>,
  id: string,
  operations: DrawingOperation[],
  revision?: string,
) {
  const snapshot = service.snapshot,
    document = editDrawing(getDrawing(snapshot, id), operations);
  const state = await service.transact(
    [{ type: 'writeDrawing', document }],
    revision ?? snapshot.revision,
  );
  return { ...state, document };
}
export async function publishDrawing(
  root: string,
  service: Pick<ProjectService, 'snapshot' | 'transact'>,
  id: string,
  layerIds?: string[],
  name?: string,
  revision?: string,
) {
  const snapshot = service.snapshot,
    doc = getDrawing(snapshot, id),
    selected = layerIds ? doc.layers.filter((l) => layerIds.includes(l.id)) : doc.layers;
  if (
    layerIds &&
    (new Set(layerIds).size !== layerIds.length || selected.length !== layerIds.length)
  )
    throw new VmotionError('NOT_FOUND', '选中的绘画图层不存在');
  if (!selected.length) throw new VmotionError('EMPTY_DRAWING', '先创建绘画图层，再发布画稿');
  const assetId = randomUUID(),
    file = `assets/drawing-${assetId}.json`,
    document = {
      ...doc,
      name: name ?? (layerIds && selected.length === 1 ? selected[0].name : doc.name),
      layers: selected,
    };
  await atomicWrite(safePath(root, file), JSON.stringify(document));
  const asset = {
    id: assetId,
    name: document.name,
    path: file,
    type: 'drawing' as const,
    managed: true,
    fingerprint: await fingerprint(safePath(root, file)),
    metadata: {
      width: doc.width,
      height: doc.height,
      sourceDocumentId: doc.id,
      layerIds: selected.map((l) => l.id),
      layerCount: selected.length,
    },
  };
  return {
    ...(await service.transact([{ type: 'addAsset', asset }], revision ?? snapshot.revision)),
    asset,
  };
}
export async function drawingPreview(
  snapshot: Snapshot,
  id: string,
  width = 960,
  height?: number,
  draft?: { layerId: string; stroke: DrawingStroke } | { operations: DrawingOperation[] },
) {
  let doc = getDrawing(snapshot, id);
  if (draft) {
    if ('operations' in draft) {
      const pending = draft.operations.filter(
        (op) =>
          op.type !== 'stroke' ||
          !doc.layers.some((l) => l.strokes.some((s) => s.id === op.stroke.id)),
      );
      if (pending.length) doc = editDrawing(doc, pending);
    } else if (!doc.layers.some((l) => l.strokes.some((s) => s.id === draft.stroke.id)))
      doc = editDrawing(doc, [{ type: 'stroke', ...draft }]);
  }
  height ??= Math.max(16, Math.round((width * doc.height) / doc.width));
  if (
    width < 16 ||
    height < 16 ||
    width > 2048 ||
    height > 2048 ||
    !Number.isInteger(width) ||
    !Number.isInteger(height)
  )
    throw new VmotionError('RESOLUTION', '画稿预览尺寸无效');
  return {
    buffer: await drawingFrame(doc, width, height).encode('png'),
    revision: snapshot.revision,
  };
}
