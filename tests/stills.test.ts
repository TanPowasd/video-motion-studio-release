import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadImage, createCanvas } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { validateSnapshot } from '../src/service/project.js';
import { readImageDpi } from '../src/service/stills.js';
import {
  alignDeltas,
  snapDelta,
  snapTargets,
  stillGuides,
  stillPresets,
  stillTemplateNodes,
  renderSizeIssue,
} from '../src/core/still.js';
import { projectCreationSchema } from '../src/core/project-creation.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import type { InteractionLayer } from '../src/core/interaction.js';

let root: string, imageRoot: string, app: Application, image: Application;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-still-'));
  imageRoot = await mkdtemp(path.join(os.tmpdir(), 'vmotion-still-project-'));
  await rm(imageRoot, { recursive: true, force: true });
  await initProject(root, 'Still lab', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  await initProject(imageRoot, '小红书封面', {
    kind: 'still',
    preset: 'xiaohongshu',
    stillTemplate: 'card',
    width: 1242,
    height: 1660,
  });
  app = await new Application(root).open(false);
  image = await new Application(imageRoot).open(false);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await image?.close();
  await rm(root, { recursive: true, force: true });
  await rm(imageRoot, { recursive: true, force: true });
}, 180_000);

async function commit(application: Application, plan: any) {
  const check = await application.dispatch('projectPreflight', plan.candidate);
  expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true);
  return application.dispatch('projectApply', plan.apply);
}
async function decode(file: string) {
  const img = await loadImage(await readFile(file)),
    canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.getContext('2d').getImageData(0, 0, img.width, img.height).data;
}
const layer = (id: string, x: number, y: number, w: number, h: number): InteractionLayer =>
  ({
    node: { id, x, y, width: w, height: h, animations: [] } as any,
    path: [],
    matrix: [1, 0, 0, 1, x, y],
    parentMatrix: [1, 0, 0, 1, 0, 0],
    bounds: { x: 0, y: 0, width: w, height: h },
    clips: [],
    container: false,
  }) as InteractionLayer;

it('describes presets, guides, budgets and alignment/snap geometry', () => {
  const a4 = stillPresets.find((p) => p.id === 'poster-a4')!;
  expect(a4.width - 2 * a4.bleed).toBe(2480);
  expect(a4.height - 2 * a4.bleed).toBe(3508);
  const g = stillGuides({ width: a4.width, height: a4.height, still: { dpi: 300, bleed: 36, safeArea: 59, transparent: false, variants: [] } }, { width: 1, height: 1 });
  expect(g.trim).toEqual({ x: 36, y: 36, width: 2480, height: 3508 });
  expect(g.safe.x).toBe(95);
  expect(renderSizeIssue(2552, 3580, false)).toMatch(/UHD/);
  expect(renderSizeIssue(2552, 3580, true)).toBeUndefined();
  expect(renderSizeIssue(2552 * 3, 3580 * 3, true)).toMatch(/8192|budget/);
  for (const t of ['blank', 'poster', 'cover', 'card'] as const)
    for (const p of stillPresets) {
      const content = stillTemplateNodes(t, p.width, p.height, p);
      expect(new Set(content.nodes.map((n) => n.id)).size).toBe(content.nodes.length);
    }
  const layers = [layer('a', 10, 10, 20, 20), layer('b', 50, 30, 10, 10), layer('c', 100, 0, 30, 5)];
  const left = alignDeltas(layers, ['a', 'b', 'c'], 'left', 'selection');
  expect([...left.values()].map((d) => d.x)).toEqual([0, -40, -90]);
  const centre = alignDeltas(layers, ['b'], 'hcenter', { x: 0, y: 0, width: 200, height: 100 });
  expect(centre.get('b')).toEqual({ x: 45, y: 0 });
  const spread = alignDeltas(layers, ['a', 'b', 'c'], 'distribute-h', 'selection');
  // span 10..130 = 120, widths 60 → gap 30: a@10, b@60, c@100
  expect(spread.get('b')!.x).toBe(10);
  expect(spread.get('c')!.x).toBe(0);
  const snap = snapDelta({ x: 0, y: 0, width: 20, height: 20 }, { x: 47, y: 3 }, snapTargets([{ x: 0, y: 0, width: 100, height: 100 }]), 4);
  expect(snap.delta).toEqual({ x: 50, y: 0 });
  expect(snap.guides).toEqual({ x: 50, y: 0 });
  expect(projectCreationSchema.safeParse({ name: 'x', width: 2480, height: 3508 }).success).toBe(false);
  expect(projectCreationSchema.safeParse({ name: 'x', kind: 'still', width: 2480, height: 3508 }).success).toBe(true);
});

it('registers still tools in the image discovery category', () => {
  const tools = toolDefinitions().filter((t) => t.categories?.includes('image'));
  expect(tools.map((t) => t.name).sort()).toEqual(['image_export', 'still_inspect', 'still_plan']);
});

it('creates a still image project with a 1-frame artboard and no diagnostics', async () => {
  const snapshot = image.service.snapshot;
  expect(snapshot.project.kind).toBe('still');
  expect(snapshot.scenes[0]).toMatchObject({ id: 'image', duration: 1, width: 1242, height: 1660 });
  expect(snapshot.scenes[0].still?.preset).toBe('xiaohongshu');
  expect(snapshot.sequences[0].duration).toBe(1);
  expect(await validateSnapshot(imageRoot, snapshot)).toEqual([]);
  const info: any = await image.dispatch('stillInspect', { presets: true });
  expect(info.projectKind).toBe('still');
  expect(info.stills[0]).toMatchObject({ sceneId: 'image', width: 1242, height: 1660 });
  expect(info.presets.length).toBe(8);
});

it('plans, preflights, applies and undoes a print-size still in a video project', async () => {
  const before = app.service.snapshot.revision;
  const plan: any = await app.dispatch('stillPlan', {
    revision: before,
    actions: [
      { action: 'create', sceneId: 'poster', name: '活动海报', preset: 'poster-a4', template: 'poster' },
    ],
  });
  expect(plan.summary[0]).toMatchObject({ sceneId: 'poster', width: 2552, height: 3580 });
  expect(app.service.snapshot.revision).toBe(before);
  await commit(app, plan);
  const scene = app.service.snapshot.scenes.find((s) => s.id === 'poster')!;
  expect(scene).toMatchObject({ duration: 1, width: 2552, height: 3580 });
  expect(scene.still).toMatchObject({ dpi: 300, bleed: 36, preset: 'poster-a4' });
  await app.dispatch('undo');
  expect(app.service.snapshot.scenes.some((s) => s.id === 'poster')).toBe(false);
  await app.dispatch('redo');
  expect(app.service.snapshot.scenes.some((s) => s.id === 'poster')).toBe(true);
});

it('marks, unmarks and validates still sizes and durations', async () => {
  const sceneId = app.service.snapshot.scenes[0].id;
  const mark: any = await app.dispatch('stillPlan', {
    actions: [{ action: 'update', sceneId, preset: 'square' }],
  });
  expect(mark.warnings[0]).toMatch(/1-frame still/);
  await commit(app, mark);
  expect(app.service.snapshot.scenes[0]).toMatchObject({ duration: 1, width: 1080, height: 1080 });
  const unmark: any = await app.dispatch('stillPlan', {
    actions: [{ action: 'unmark', sceneId, duration: 60 }],
  });
  await commit(app, unmark);
  expect(app.service.snapshot.scenes[0].still).toBeUndefined();
  expect(app.service.snapshot.scenes[0].duration).toBe(60);
  await expect(
    app.dispatch('stillPlan', { actions: [{ action: 'unmark', sceneId: 'poster', duration: 30 }] }),
  ).rejects.toThrow(/Resize the artboard/);
  const bad = structuredClone(app.service.snapshot);
  bad.scenes[0].width = 5000;
  const poster = bad.scenes.find((s) => s.id === 'poster')!;
  poster.duration = 2;
  const codes = (await validateSnapshot(root, bad)).map((d) => d.code);
  expect(codes).toContain('SCENE_SIZE');
  expect(codes).toContain('STILL_DURATION');
});

it('aligns layers to the safe area and selection with one undo', async () => {
  const create: any = await app.dispatch('stillPlan', {
    actions: [
      { action: 'create', sceneId: 'align', name: '对齐', width: 400, height: 300, safeArea: 20, template: 'blank' },
    ],
  });
  await commit(app, create);
  await app.dispatch('transact', {
    operations: [
      { type: 'addNode', sceneId: 'align', node: { id: 'r1', type: 'rect', x: 100, y: 50, width: 40, height: 40 } },
      { type: 'addNode', sceneId: 'align', node: { id: 'r2', type: 'rect', x: 200, y: 120, width: 60, height: 20 } },
    ],
  });
  const plan: any = await app.dispatch('stillPlan', {
    actions: [
      { action: 'align', sceneId: 'align', nodeIds: ['r1'], mode: 'left' },
      { action: 'align', sceneId: 'align', nodeIds: ['r1', 'r2'], mode: 'bottom' },
      { action: 'align', sceneId: 'align', nodeIds: ['r2'], mode: 'hcenter', relativeTo: 'canvas' },
    ],
  });
  await commit(app, plan);
  const nodes = app.service.snapshot.scenes.find((s) => s.id === 'align')!.nodes;
  const r1 = nodes.find((n) => n.id === 'r1')!,
    r2 = nodes.find((n) => n.id === 'r2')!;
  expect(r1.x).toBe(20);
  expect(r1.y + r1.height).toBe(140);
  expect(r2.y + r2.height).toBe(140);
  expect(r2.x).toBe(170);
  await app.dispatch('undo');
  expect(app.service.snapshot.scenes.find((s) => s.id === 'align')!.nodes.find((n) => n.id === 'r1')!.x).toBe(100);
  await app.dispatch('redo');
});

it('exports PNG pixels identical to the preview renderer, with scale, transparency and DPI', async () => {
  const out = path.join(root, 'exports', 'test');
  const one: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    output: path.join(out, 'one.png'),
  });
  expect(one.images[0]).toMatchObject({ width: 400, height: 300, format: 'png', dpi: 72 });
  const preview: any = await app.frame({ sceneId: 'align', width: 400, height: 300, format: 'rgba' });
  const exported = await decode(one.images[0].path);
  expect(Buffer.from(exported).equals(Buffer.from(preview.buffer))).toBe(true);
  expect(readImageDpi(await readFile(one.images[0].path))).toBe(72);

  const two: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    scale: 2,
    transparent: true,
    output: path.join(out, 'two.png'),
  });
  expect(two.images[0]).toMatchObject({ width: 800, height: 600, dpi: 144, transparent: true });
  const pixels = await decode(two.images[0].path);
  expect(pixels[3]).toBe(0); // background corner is transparent
  const rect = (2 * 120 * 800 + 2 * 40) * 4; // inside r1 (20..60, 100..140) after scaling
  expect(pixels[rect + 3]).toBe(255);

  const jpeg: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    format: 'jpeg',
    quality: 60,
    transparent: true,
    output: path.join(out, 'q.jpg'),
  });
  const jpegBytes = await readFile(jpeg.images[0].path);
  expect(jpegBytes[0]).toBe(0xff);
  expect(readImageDpi(jpegBytes)).toBe(72);
  expect(jpeg.warnings.join(' ')).toMatch(/no alpha/);
  const webp: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    format: 'webp',
    transparent: true,
    output: path.join(out, 'w.webp'),
  });
  const webpBytes = await readFile(webp.images[0].path);
  expect(webpBytes.toString('latin1', 0, 4)).toBe('RIFF');
  expect(webpBytes.toString('latin1', 8, 12)).toBe('WEBP');
});

it('exports trimmed print posters, size variants and rejects over-budget scales', async () => {
  const out = path.join(root, 'exports', 'poster');
  const trimmed: any = await app.dispatch('imageExport', { sceneId: 'poster', trim: true, output: out });
  expect(trimmed.images[0]).toMatchObject({ width: 2480, height: 3508, dpi: 300 });
  const variants: any = await app.dispatch('stillPlan', {
    actions: [
      {
        action: 'variants',
        sceneId: 'align',
        variants: [
          { id: 'square', name: '方图', width: 300, height: 300, fit: 'contain' },
          { id: 'wide', name: '宽图', width: 600, height: 200, fit: 'cover' },
          { id: 'reflow', name: '重排', width: 200, height: 200, fit: 'reflow' },
        ],
      },
    ],
  });
  await commit(app, variants);
  const all: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    variants: 'all',
    output: path.join(out, 'variants'),
  });
  expect(all.images.map((i: any) => [i.variant, i.width, i.height])).toEqual([
    ['main', 400, 300],
    ['square', 300, 300],
    ['wide', 600, 200],
    ['reflow', 200, 200],
  ]);
  expect((await readdir(path.join(out, 'variants'))).length).toBe(4);
  const preview: any = await app.dispatch('imageExport', {
    sceneId: 'align',
    variants: ['square'],
    main: false,
    preview: { maxSide: 64 },
  });
  expect(preview.images[0].dataUrl).toMatch(/^data:image\/png;base64,/);
  await expect(
    app.dispatch('imageExport', { sceneId: 'poster', scale: 3, output: out }),
  ).rejects.toThrow(/8192|budget/);
  await expect(
    app.dispatch('imageExport', { sceneId: 'align', revision: 'stale', output: out }),
  ).rejects.toThrow(/changed/);
});
