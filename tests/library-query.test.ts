import { it, expect } from 'vitest';
import { queryAssets, queryDrawing } from '../src/service/library-query.js';
import { projectSchema, assetSchema, type Snapshot } from '../src/core/model.js';
import { drawingDocumentSchema } from '../src/core/drawing-model.js';

function snapshot(): Snapshot {
  const project = projectSchema.parse({
    formatVersion: 1,
    id: 'library',
    name: 'Library',
    width: 640,
    height: 360,
    fps: { num: 30, den: 1 },
    activeSequence: 'main',
    scenes: [],
    sequences: [],
    assets: Array.from({ length: 100 }, (_, i) =>
      assetSchema.parse({
        id: 'asset-' + i,
        name: (i % 2 ? '视频' : '画稿') + ' 素材 ' + i,
        type: i % 2 ? 'video' : 'drawing',
        path: '/assets/' + i,
        managed: i % 3 === 0,
        metadata: { width: 640, height: 360, duration: 2, description: 'x'.repeat(2000) },
      }),
    ),
  });
  const doc = drawingDocumentSchema.parse({
    id: 'draw',
    name: 'Layered artwork',
    width: 640,
    height: 360,
    layers: Array.from({ length: 3 }, (_, l) => ({
      id: 'layer-' + l,
      name: '图层' + l,
      x: l * 10,
      y: l * 5,
      locked: l === 2,
      strokes: Array.from({ length: 80 }, (_, s) => ({
        id: `stroke-${l}-${s}`,
        color: '#67abcd',
        width: 6,
        points: Array.from({ length: 100 }, (_, p) => ({ x: p, y: s, pressure: p / 100 })),
      })),
    })),
  });
  project.drawings = [{ id: doc.id, name: doc.name, path: 'drawings/draw.json' }];
  return {
    project,
    scenes: [],
    sequences: [],
    files: { 'drawings/draw.json': JSON.stringify(doc) },
    revision: 'unchanged',
  };
}
it('pages compact registered assets and filters without dumping metadata or pretending to probe files', () => {
  const base = snapshot(),
    before = JSON.stringify(base),
    page = queryAssets(base, {}),
    full = queryAssets(base, { limit: 100, detail: true });
  expect(page.items).toHaveLength(24);
  expect(page.nextOffset).toBe(24);
  expect(page.total).toBe(100);
  expect(page.counts.video).toBe(50);
  expect((page.items[0] as any).path).toBeUndefined();
  expect((page.items[0] as any).metadata).toBeUndefined();
  expect(queryAssets(base, { ids: ['asset-2'], detail: true }).items[0]).toEqual(
    base.project.assets[2],
  );
  expect(
    queryAssets(base, { types: ['drawing'], managed: true, query: '画稿 素材' }).items.every(
      (a) => a.type === 'drawing' && a.managed,
    ),
  ).toBe(true);
  expect(queryAssets(base, { offset: 24 }).items.map((a) => a.id)).toEqual(
    base.project.assets.slice(24, 48).map((a) => a.id),
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) * 0.03,
  );
  expect(() => queryAssets(base, { ids: ['missing'] })).toThrow(/missing/);
  expect(() => queryAssets(base, { revision: 'stale' })).toThrow(/changed/);
  expect(JSON.stringify(base)).toBe(before);
});
it('returns layer and stroke evidence with separate point paging preserving local pressure samples', () => {
  const base = snapshot(),
    doc = JSON.parse(base.files['drawings/draw.json']),
    before = JSON.stringify(base),
    page = queryDrawing(base, { id: 'draw' });
  expect(page.layers.total).toBe(3);
  expect(page.strokes.total).toBe(240);
  expect(page.strokes.items).toHaveLength(16);
  expect(page.strokes.nextOffset).toBe(16);
  expect((page.strokes.items[0] as any).points).toBeUndefined();
  expect(page.layers.items[2]).toMatchObject({ locked: true, strokeCount: 80, pointCount: 8000 });
  const selected = queryDrawing(base, {
    id: 'draw',
    layerIds: ['layer-1'],
    strokeIds: ['stroke-1-5'],
    includePoints: true,
    pointOffset: 40,
    pointLimit: 8,
  });
  expect(selected.strokes.items[0]).toMatchObject({
    layerId: 'layer-1',
    pointCount: 100,
    points: { offset: 40, nextOffset: 48, items: doc.layers[1].strokes[5].points.slice(40, 48) },
  });
  expect(queryDrawing(base, { id: 'draw', layerOffset: 1, layerLimit: 1 }).layers.nextOffset).toBe(
    2,
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    Buffer.byteLength(base.files['drawings/draw.json']) * 0.02,
  );
  expect(() => queryDrawing(base, { id: 'draw', layerIds: ['missing'] })).toThrow(
    /layer is missing/,
  );
  expect(() =>
    queryDrawing(base, { id: 'draw', layerIds: ['layer-1'], strokeIds: ['stroke-0-1'] }),
  ).toThrow(/selected layers/);
  expect(() => queryDrawing(base, { id: 'draw', revision: 'stale' })).toThrow(/changed/);
  expect(JSON.stringify(base)).toBe(before);
});
