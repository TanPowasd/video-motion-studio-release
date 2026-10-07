import { z } from 'zod';
import { VmotionError, type Snapshot, assetSchema } from '../core/model.js';
import { getDrawing } from './drawings.js';
const id = z.string().min(1).max(200),
  revision = z.string().optional(),
  offset = z.number().int().nonnegative().default(0),
  limit = z.number().int().min(1).max(100).default(24);
export const assetQuerySchema = z
  .object({
    revision,
    ids: z.array(id).max(200).optional(),
    types: z.array(assetSchema.shape.type).max(5).optional(),
    query: z.string().max(200).default(''),
    managed: z.boolean().optional(),
    offset,
    limit,
    detail: z.boolean().default(false),
  })
  .strict();
export function queryAssets(snapshot: Snapshot, raw: unknown) {
  const p = assetQuerySchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before asset query');
  const assets = snapshot.project.assets,
    index = new Set(assets.map((a) => a.id));
  for (const id of p.ids ?? [])
    if (!index.has(id))
      throw new VmotionError('MISSING_ASSET', 'Requested asset is missing', { assetId: id });
  const words = p.query.trim().toLowerCase().split(/\s+/).filter(Boolean),
    selected = assets.filter(
      (a) =>
        (!p.ids || p.ids.includes(a.id)) &&
        (!p.types || p.types.includes(a.type)) &&
        (p.managed === undefined || a.managed === p.managed) &&
        words.every((w) => (a.name + ' ' + a.id).toLowerCase().includes(w)),
    ),
    page = selected.slice(p.offset, p.offset + p.limit);
  return {
    revision: snapshot.revision,
    total: selected.length,
    offset: p.offset,
    nextOffset: p.offset + page.length < selected.length ? p.offset + page.length : undefined,
    counts: Object.fromEntries(
      assetSchema.shape.type.options.map((type) => [
        type,
        assets.filter((a) => a.type === type).length,
      ]),
    ),
    items: page.map((a) =>
      p.detail
        ? { ...a }
        : {
            id: a.id,
            name: a.name,
            type: a.type,
            managed: a.managed,
            editable: !!a.soundSource || a.type === 'drawing',
            width: a.metadata.width,
            height: a.metadata.height,
            duration: a.metadata.duration,
            hasAudio: a.metadata.hasAudio,
          },
    ),
    projection: { partial: !p.detail, sourcePaths: p.detail },
    availability: 'registered-metadata; use media_status/probe for current files',
  };
}
export const drawingQuerySchema = z
  .object({
    id,
    revision,
    layerIds: z.array(id).max(256).optional(),
    strokeIds: z.array(id).max(200).optional(),
    layerOffset: offset,
    layerLimit: limit,
    strokeOffset: offset,
    strokeLimit: z.number().int().min(1).max(200).default(16),
    includePoints: z.boolean().default(false),
    pointOffset: offset,
    pointLimit: z.number().int().min(1).max(200).default(32),
  })
  .strict();
export function queryDrawing(snapshot: Snapshot, raw: unknown) {
  const p = drawingQuerySchema.parse(raw);
  if (p.revision && p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before drawing query');
  const doc = getDrawing(snapshot, p.id),
    layerIndex = new Set(doc.layers.map((l) => l.id));
  for (const id of p.layerIds ?? [])
    if (!layerIndex.has(id))
      throw new VmotionError('NOT_FOUND', 'Requested drawing layer is missing', { layerId: id });
  const layers = doc.layers.filter((l) => !p.layerIds || p.layerIds.includes(l.id)),
    strokeIndex = new Set(layers.flatMap((l) => l.strokes.map((s) => s.id)));
  for (const id of p.strokeIds ?? [])
    if (!strokeIndex.has(id))
      throw new VmotionError(
        'NOT_FOUND',
        'Requested drawing stroke is missing from selected layers',
        { strokeId: id },
      );
  const strokes = layers.flatMap((l) =>
      l.strokes
        .filter((s) => !p.strokeIds || p.strokeIds.includes(s.id))
        .map((s) => ({ layer: l, stroke: s })),
    ),
    page = strokes.slice(p.strokeOffset, p.strokeOffset + p.strokeLimit),
    layerPage = layers.slice(p.layerOffset, p.layerOffset + p.layerLimit);
  return {
    revision: snapshot.revision,
    id: doc.id,
    name: doc.name,
    width: doc.width,
    height: doc.height,
    layers: {
      total: layers.length,
      offset: p.layerOffset,
      nextOffset:
        p.layerOffset + layerPage.length < layers.length
          ? p.layerOffset + layerPage.length
          : undefined,
      items: layerPage.map(({ strokes, ...layer }) => ({
        ...layer,
        strokeCount: strokes.length,
        pointCount: strokes.reduce((n, s) => n + s.points.length, 0),
      })),
    },
    strokes: {
      total: strokes.length,
      offset: p.strokeOffset,
      nextOffset:
        p.strokeOffset + page.length < strokes.length ? p.strokeOffset + page.length : undefined,
      items: page.map(({ layer, stroke: { points, ...stroke } }) => ({
        ...stroke,
        layerId: layer.id,
        pointCount: points.length,
        ...(p.includePoints
          ? {
              points: {
                total: points.length,
                offset: p.pointOffset,
                items: points.slice(p.pointOffset, p.pointOffset + p.pointLimit),
                nextOffset:
                  p.pointOffset + p.pointLimit < points.length
                    ? p.pointOffset + p.pointLimit
                    : undefined,
              },
            }
          : {}),
      })),
    },
    projection: { partial: true, pointsIncluded: p.includePoints },
    pointUnits: 'drawing-layer local pixels with pressure 0..1',
  };
}
