import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-drawing-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
const stroke = (id: string, color: string, tool = 'brush', x = 80) => ({
  id,
  color,
  tool,
  width: 24,
  points: [
    { x, y: 20, pressure: 1 },
    { x, y: 80, pressure: 1 },
  ],
});
it('keeps drawing documents out of scenes until publish/place, supports selected layers and round-trips after restart', async () => {
  const originalNodes = app.service.snapshot.scenes[0].nodes.length;
  const created = await app.dispatch('drawingCreate', { name: '画稿', width: 160, height: 90 }),
    id = created.document.id,
    first = created.document.layers[0].id;
  await app.dispatch('drawingEdit', {
    id,
    operations: [
      { type: 'stroke', layerId: first, stroke: stroke('red', '#ff0000') },
      {
        type: 'addLayer',
        layer: { id: 'blue', name: '蓝色', strokes: [stroke('blue-line', '#0000ff', 'brush', 40)] },
      },
    ],
  });
  expect(app.service.snapshot.project.assets).toHaveLength(0);
  await expect(
    app.drawingFrame({
      id,
      width: 160,
      height: 90,
      draft: { operations: [{ type: 'stroke', layerId: first, stroke: stroke('red', '#ff0000') }] },
    }),
  ).resolves.toMatchObject({ revision: app.service.snapshot.revision });
  expect(app.service.snapshot.scenes[0].nodes).toHaveLength(originalNodes);
  const published = await app.dispatch('drawingPublish', { id, layerIds: ['blue'] });
  expect(
    JSON.parse(await readFile(path.join(root, published.asset.path), 'utf8')).layers,
  ).toHaveLength(1);
  expect(app.service.snapshot.scenes[0].nodes).toHaveLength(originalNodes);
  const placed = await app.dispatch('assetPlace', {
    assetId: published.asset.id,
    sceneId: 'intro',
    x: 0,
    y: 0,
    width: 160,
    height: 90,
  });
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === placed.nodeId)!.type).toBe(
    'drawing',
  );
  const track = await app.dispatch('assetPlace', {
    assetId: published.asset.id,
    sequenceId: 'main',
    frame: 10,
    duration: 30,
  });
  expect(
    app.service.snapshot.sequences[0].tracks
      .find((t) => t.id === track.trackId)!
      .clips.find((c) => c.id === track.clipId)!.assetId,
  ).toBe(published.asset.id);
  expect((await app.frame({ frame: 10, width: 160, height: 90 })).stale).toBe(false);
  await app.close();
  app = await new Application(root).open(false);
  expect((await app.dispatch('drawingGet', { id })).document.layers).toHaveLength(2);
  expect((await loadProject(root)).project.drawings).toHaveLength(1);
  await app.service.undo();
  expect(
    app.service.snapshot.sequences[0].tracks
      .flatMap((t) => t.clips)
      .some((c) => c.id === track.clipId),
  ).toBe(false);
});
it('eraser affects only the active layer and native drawing preview matches the published scene', async () => {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 160, height: 90 } },
    { type: 'updateScene', sceneId: 'intro', patch: { background: 'transparent', nodes: [] } },
  ]);
  const created = await app.dispatch('drawingCreate', { width: 160, height: 90 }),
    id = created.document.id,
    red = created.document.layers[0].id;
  await app.dispatch('drawingEdit', {
    id,
    operations: [
      { type: 'stroke', layerId: red, stroke: stroke('red', '#ff0000') },
      {
        type: 'addLayer',
        layer: {
          id: 'blue',
          name: '蓝色',
          strokes: [
            stroke('blue', '#0000ff'),
            { ...stroke('erase', '#ffffff', 'eraser'), width: 30 },
          ],
        },
      },
    ],
  });
  const preview = await app.drawingFrame({ id, width: 160, height: 90 }),
    image = await loadImage(preview.buffer),
    canvas = createCanvas(160, 90),
    ctx = canvas.getContext('2d');
  ctx.drawImage(image, 0, 0);
  expect(Array.from(ctx.getImageData(80, 50, 1, 1).data)).toEqual([255, 0, 0, 255]);
  const published = await app.dispatch('drawingPublish', { id });
  await app.dispatch('assetPlace', {
    assetId: published.asset.id,
    sceneId: 'intro',
    x: 0,
    y: 0,
    width: 160,
    height: 90,
  });
  expect(
    (await app.frame({ sceneId: 'intro', frame: 0, width: 160, height: 90 })).buffer.equals(
      preview.buffer,
    ),
  ).toBe(true);
  const thumbnail = await app.assetThumbnail(published.asset.id, 160, 100);
  expect(thumbnail.length).toBeGreaterThan(100);
});
it('rolls back invalid drawing edits, checks revisions and keeps published assets immutable', async () => {
  const created = await app.dispatch('drawingCreate', { width: 160, height: 90 }),
    id = created.document.id,
    layer = created.document.layers[0].id,
    revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('drawingEdit', {
      id,
      operations: [
        { type: 'stroke', layerId: layer, stroke: stroke('line', '#ff0000') },
        { type: 'stroke', layerId: 'missing', stroke: stroke('fail', '#00ff00') },
      ],
    }),
  ).rejects.toThrow('图层不存在');
  expect(app.service.snapshot.revision).toBe(revision);
  await app.dispatch('drawingEdit', {
    id,
    operations: [{ type: 'stroke', layerId: layer, stroke: stroke('line', '#ff0000') }],
  });
  const published = await app.dispatch('drawingPublish', { id }),
    before = await readFile(path.join(root, published.asset.path), 'utf8');
  await expect(
    app.dispatch('drawingEdit', {
      id,
      revision,
      operations: [{ type: 'updateDocument', patch: { name: 'stale' } }],
    }),
  ).rejects.toThrow('changed');
  await app.dispatch('drawingEdit', {
    id,
    operations: [{ type: 'updateLayer', layerId: layer, patch: { x: 30 } }],
  });
  expect(await readFile(path.join(root, published.asset.path), 'utf8')).toBe(before);
});
