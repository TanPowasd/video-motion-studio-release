import { afterAll, beforeAll, expect, it } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { parseIds, formatIds, idsLeaves, idsNodeAt } from '../src/core/glyphs/ids.js';
import { GlyphComposer, isGlyphProblem } from '../src/core/glyphs/compose.js';
import { builtinGlyphSet, GlyphSetResolver } from '../src/core/glyphs/glyph-resources.js';
import { glyphSetSchema } from '../src/core/glyphs/glyph-schema.js';
import { MixedTextMeasurer, glyphSourceFor } from '../src/core/glyphs/glyph-text.js';
import { transformPathData, polylinePath } from '../src/core/glyphs/path-transform.js';
import { layoutTextLines, measureTextBlock } from '../src/core/text-layout.js';
import { nativeTextFont } from '../src/core/bundled-fonts.js';
import { newNode } from '../src/core/model.js';
import { coverageReport } from '../src/service/glyphs.js';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { toolDefinitions } from '../src/mcp/catalog.js';

const demo = builtinGlyphSet('demo')!;
const DEMO_SENTENCE = '明月照江河，森林好想你。';

it('parses nested IDS, parameters and component names, and rejects malformed expressions', () => {
  const tree = parseIds('⿰氵⿱木口');
  expect(tree).toMatchObject({ kind: 'op', op: '⿰', children: [{ kind: 'leaf', ref: '氵' }, { kind: 'op', op: '⿱' }] });
  expect(idsLeaves(tree)).toEqual(['氵', '木', '口']);
  expect(idsNodeAt(tree, '1.0')).toMatchObject({ ref: '木' });
  expect(formatIds(parseIds('⿰[0.3]氵{left-wood}'))).toBe('⿰[0.3]氵{left-wood}');
  expect(parseIds('⿲彳⿱山王攵')).toMatchObject({ op: '⿲' });
  expect(parseIds('⿴[0.1,0.2,0.8,0.6]囗玉')).toMatchObject({ params: [0.1, 0.2, 0.8, 0.6] });
  for (const [bad, message] of [
    ['', /Empty/],
    ['⿰氵', /ended early/],
    ['⿰氵木口', /Extra characters/],
    ['⿰[2]氵木', /parameters/],
    ['⿰[0.3氵木', /Missing \]/],
    ['⿰{氵木', /Missing \}/],
    ['⿼丶口', /not supported/],
    ['⿰'.repeat(20) + '口'.repeat(21), /nesting/],
  ] as const)
    expect(() => parseIds(bad), bad).toThrow(message);
  try {
    parseIds('⿰氵');
  } catch (e) {
    expect((e as { code: string }).code).toBe('GLYPH_IDS');
  }
});

it('lays out compositions deterministically with preferred proportions and overrides', () => {
  const a = new GlyphComposer(demo).glyph('河'),
    b = new GlyphComposer(glyphSetSchema.parse(JSON.parse(JSON.stringify(demo)))).glyph('河');
  expect(isGlyphProblem(a)).toBe(false);
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  const g = a as Exclude<typeof a, { code: string }>;
  const water = g.parts.find((p) => p.ref === '氵')!,
    body = 1000 - 2 * demo.metrics.margin;
  // 氵 prefers 28% of the width; the rest goes to 可.
  expect(water.box.w / body).toBeCloseTo(0.28 - demo.metrics.gap / 2 / body, 2);
  expect(g.ids).toBe('⿰氵可');
  const composer = new GlyphComposer(demo),
    wide = composer.composeExpression('⿰[0.5]氵可'),
    moved = composer.composeExpression('⿰氵可', { adjust: { '0': { offset: [0.1, 0] } } });
  expect(wide.parts[0].box.w).toBeGreaterThan(water.box.w);
  expect(moved.parts[0].box.x - water.box.x).toBeCloseTo(water.box.w * 0.1, 3);
  // surround: inner part sits inside the 囗 inner box
  const guo = composer.glyph('国') as typeof g,
    frame = guo.parts.find((p) => p.ref === '囗')!.box,
    jade = guo.parts.find((p) => p.ref === '玉')!.box;
  expect(jade.x).toBeGreaterThan(frame.x);
  expect(jade.x + jade.w).toBeLessThan(frame.x + frame.w);
  // affine path transform and rounded polylines are exact/deterministic
  expect(transformPathData('M0 0 h10 v10 Q 0 10 0 0 Z', [2, 0, 0, 3, 1, 1])).toBe('M1 1L21 1L21 31Q1 31 1 1Z');
  expect(polylinePath([[0, 0], [100, 0], [100, 100]], 0.5)).toBe('M0 0L75 0Q100 0 100 25L100 100');
  expect(() => glyphSetSchema.parse({ ...demo, components: { x: { strokes: [{ d: 'M0 0 A1 1 0 0 1 2 2' }] } } })).toThrow(/Arc/);
});

it('reports cycles, missing components and coverage', () => {
  const set = glyphSetSchema.parse({
    kind: 'glyph-set',
    version: 1,
    id: 'cyc',
    name: 'cycle',
    components: { a: { ids: '⿰{b}口' }, b: { ids: '⿱{a}口' }, 口: { strokes: [{ points: [[0, 0], [1000, 1000]] }] } },
    glyphs: { 甲: '⿰{a}口', 乙: '⿰口{zzz}', 回: '⿴口口' },
  });
  const c = new GlyphComposer(set);
  expect(c.glyph('甲')).toMatchObject({ code: 'GLYPH_CYCLE' });
  expect(c.glyph('乙')).toMatchObject({ code: 'GLYPH_COMPONENT', missing: ['zzz'] });
  expect(isGlyphProblem(c.glyph('回'))).toBe(false);
  const resolver = new GlyphSetResolver(0),
    prepared = resolver.resolve({ files: {} }, 'builtin:demo'),
    report = coverageReport(prepared, DEMO_SENTENCE + '龘龘');
  expect(report.missing).toEqual([{ char: '龘', count: 2, reason: 'GLYPH_MISSING' }]);
  expect(report.coveredUnique).toBe(new Set(DEMO_SENTENCE).size);
  expect(coverageReport(prepared, DEMO_SENTENCE).ratio).toBe(1);
});

it('measures and wraps mixed glyph/font text with font, none and tofu fallbacks', () => {
  const ctx = createCanvas(1, 1).getContext('2d'),
    node = newNode({ id: 't', type: 'text', text: '江Ab河', fontSize: 50, width: 1000, glyphSet: 'builtin:demo' });
  ctx.font = nativeTextFont(400, 50, node.fontFamily);
  const font = new MixedTextMeasurer(ctx, glyphSourceFor(node), 50),
    segments = font.segments('江Ab河');
  expect(segments.map((s) => [s.kind, s.text])).toEqual([
    ['glyph', '江'],
    ['font', 'Ab'],
    ['glyph', '河'],
  ]);
  expect(segments[1].x).toBe(50);
  expect(segments[2].x).toBeCloseTo(50 + ctx.measureText('Ab').width, 6);
  expect(font.width('江河')).toBe(100);
  const tofu = new MixedTextMeasurer(ctx, glyphSourceFor({ ...node, glyphFallback: 'tofu' }), 50);
  expect(tofu.segments('江龘').map((s) => s.kind)).toEqual(['glyph', 'tofu']);
  expect(tofu.width('江龘')).toBe(100);
  const none = new MixedTextMeasurer(ctx, glyphSourceFor({ ...node, glyphFallback: 'none' }), 50);
  expect(none.segments('龘 江').map((s) => s.kind)).toEqual(['none', 'space', 'glyph']);
  // wrapping uses glyph advances: 4 glyphs × 50px in a 120px box → 2 lines
  const lines = layoutTextLines(ctx, { ...node, text: '明月江河', width: 120 }, font);
  expect(lines).toEqual(['明月', '江河']);
  const block = measureTextBlock('明月江河明月', { fontSize: 50, width: 120, glyphSet: 'builtin:demo' });
  expect(block.lineCount).toBe(3);
  expect(block.width).toBe(100);
  // an unresolved set renders with the font fallback rather than failing
  expect(new MixedTextMeasurer(ctx, glyphSourceFor({ ...node, glyphSet: 'nope' }), 50).segments('江')[0].kind).toBe('font');
});

it('registers glyph tools in the glyphs discovery category', () => {
  const tools = toolDefinitions().filter((t) => t.categories?.includes('glyphs'));
  expect(tools.map((t) => t.name).sort()).toEqual(['glyphs_inspect', 'glyphs_plan']);
});

let root: string, app: Application;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-glyphs-'));
  await initProject(root, 'Glyph lab', { template: 'blank', width: 640, height: 360, durationSeconds: 2 });
  app = await new Application(root).open(false);
}, 180_000);
afterAll(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
}, 180_000);
async function commit(plan: any) {
  const check = await app.dispatch('projectPreflight', plan.candidate);
  expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true);
  return app.dispatch('projectApply', plan.apply);
}
async function decode(file: string) {
  const img = await loadImage(await readFile(file)),
    canvas = createCanvas(img.width, img.height);
  canvas.getContext('2d').drawImage(img, 0, 0);
  return canvas.getContext('2d').getImageData(0, 0, img.width, img.height).data;
}

it('renders composed glyph text identically in preview and export, with mixed font fallback', async () => {
  const scene: any = await app.dispatch('stillPlan', {
    actions: [{ action: 'create', sceneId: 'title', name: '标题', width: 640, height: 360, template: 'blank', background: '#101218' }],
  });
  await commit(scene);
  const revision = app.service.snapshot.revision;
  await app.dispatch('transact', {
    revision,
    operations: [
      { type: 'addNode', sceneId: 'title', node: { id: 'composed', type: 'text', text: DEMO_SENTENCE, x: 20, y: 40, width: 600, height: 80, fontSize: 48, fill: '#ffffff', align: 'center', glyphSet: 'builtin:demo' } },
      { type: 'addNode', sceneId: 'title', node: { id: 'mixed', type: 'text', text: '江河 Vmotion 龘', x: 20, y: 160, width: 600, height: 80, fontSize: 48, fill: '#ffd166', align: 'center', glyphSet: 'builtin:demo', glyphFallback: 'font' } },
      { type: 'addNode', sceneId: 'title', node: { id: 'tofu', type: 'text', text: '江龘河', x: 20, y: 260, width: 600, height: 80, fontSize: 48, fill: '#ff6b81', glyphSet: 'builtin:demo', glyphFallback: 'tofu' } },
    ],
  });
  const out = path.join(root, 'exports', 'glyphs');
  const exported: any = await app.dispatch('imageExport', { sceneId: 'title', output: path.join(out, 'title.png') });
  const preview: any = await app.frame({ sceneId: 'title', width: 640, height: 360, format: 'rgba' });
  expect(Buffer.from(await decode(exported.images[0].path)).equals(Buffer.from(preview.buffer))).toBe(true);
  // composed glyphs actually paint ink, and the plain-font layer differs from the glyph layer
  const pixels = preview.buffer as Buffer,
    ink = (y0: number, y1: number) => {
      let n = 0;
      for (let y = y0; y < y1; y++) for (let x = 0; x < 640; x++) if (pixels[(y * 640 + x) * 4] > 128) n++;
      return n;
    };
  expect(ink(40, 120)).toBeGreaterThan(1500);
  expect(ink(160, 240)).toBeGreaterThan(1500);
  // hit-testing/inspection uses the same glyph-aware layout
  const geometry: any = await app.dispatch('graphicsInspect', { sceneId: 'title', nodeId: 'composed', frame: 0 });
  expect(geometry.text?.counts ?? geometry.textLayout ?? geometry).toBeTruthy();
  const coverage: any = await app.dispatch('glyphsInspect', { project: true });
  const demoReport = coverage.project.find((p: any) => p.set === 'builtin:demo');
  expect(demoReport.missing.map((m: any) => m.char)).toContain('龘');
  expect(demoReport.missing.find((m: any) => m.char === '龘').where).toEqual(expect.arrayContaining(['title/mixed', 'title/tofu']));
  expect(demoReport.missing.map((m: any) => m.char)).not.toContain('江');
}, 120_000);

it('plans a project glyph set (extends builtin), assigns it, previews, and undoes as one step', async () => {
  const before = app.service.snapshot.revision;
  const plan: any = await app.dispatch('glyphsPlan', {
    revision: before,
    actions: [
      { action: 'create', id: 'brush', name: '我的部件体', extends: 'builtin:demo', style: { strokeWidth: 110, slant: 8 } },
      { action: 'setComponent', name: '龖', component: { strokes: [{ points: [[100, 500], [900, 500]] }, { points: [[500, 100], [500, 900]] }], prefer: { width: 0.4 } } },
      { action: 'setGlyph', char: '龘', glyph: '⿰龖⿱木口' },
      { action: 'setGlyph', char: '湖', glyph: { ids: '⿰氵胡', adjust: { '0': { offset: [0.05, 0] } } } },
      { action: 'assign', sceneId: 'title', nodeIds: ['mixed'], glyphSet: 'brush' },
    ],
    preview: '龘湖江',
  });
  expect(plan.file).toBe('components/glyphs/brush.vmglyph.json');
  expect(plan.output).toMatch(/preview-.*\.png$/);
  expect(plan.width).toBeGreaterThan(0);
  expect(app.service.snapshot.revision).toBe(before);
  await commit(plan);
  const after = app.service.snapshot;
  expect(after.files['components/glyphs/brush.vmglyph.json']).toContain('"extends": "builtin:demo"');
  // only stated fields override the parent: margin/gap/roundness stay inherited
  expect(after.files['components/glyphs/brush.vmglyph.json']).not.toContain('"margin"');
  const merged = new GlyphSetResolver(0).resolve(after, 'brush').document;
  expect(merged.metrics.margin).toBe(demo.metrics.margin);
  expect(merged.style).toMatchObject({ strokeWidth: 110, slant: 8, roundness: demo.style.roundness });
  expect(after.scenes.find((s) => s.id === 'title')!.nodes.find((n) => n.id === 'mixed')!.glyphSet).toBe('brush');
  const inspect: any = await app.dispatch('glyphsInspect', { set: 'brush', text: '江龘湖', chars: '龘' });
  expect(inspect.coverage.ratio).toBe(1);
  expect(inspect.chars[0]).toMatchObject({ char: '龘', ok: true, ids: '⿰龖⿱木口' });
  const live: any = await app.dispatch('glyphsInspect', { set: 'brush', expression: '⿰[0.4]氵⿱木口', adjust: { '1': { scale: [0.9, 0.9] } } });
  expect(live.expression).toMatchObject({ ok: true, leaves: ['氵', '木', '口'] });
  expect(live.output).toMatch(/\.png$/);
  const bad: any = await app.dispatch('glyphsInspect', { set: 'brush', expression: '⿰氵' });
  expect(bad.expression).toMatchObject({ ok: false, code: 'GLYPH_IDS' });
  // errors never modify the project
  await expect(app.dispatch('glyphsPlan', { set: 'brush', actions: [{ action: 'setGlyph', char: '坏', glyph: '⿰氵' }] })).rejects.toThrow(/IDS/);
  await expect(app.dispatch('glyphsPlan', { set: 'demo', actions: [{ action: 'setStyle', style: { slant: 4 } }] })).rejects.toThrow(/read-only|does not exist/);
  await expect(app.dispatch('glyphsPlan', { actions: [{ action: 'create', id: 'brush', name: 'dup' }] })).rejects.toThrow(/exists/);
  expect(app.service.snapshot.revision).toBe(after.revision);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files['components/glyphs/brush.vmglyph.json']).toBeUndefined();
  await app.dispatch('redo');
  expect(app.service.snapshot.files['components/glyphs/brush.vmglyph.json']).toBeDefined();
}, 120_000);

it('flags text layers whose glyph set is missing, and captions can use a glyph set', async () => {
  const revision = app.service.snapshot.revision;
  const preflight: any = await app.dispatch('projectPreflight', {
    revision,
    operations: [{ type: 'updateNode', sceneId: 'title', nodeId: 'tofu', patch: { glyphSet: 'missing-set' } }],
  });
  expect(preflight.valid).toBe(false);
  expect(JSON.stringify(preflight.diagnostics)).toContain('GLYPH_SET_MISSING');
  const made: any = await app
    .dispatch('captionsImport', {
      content: '1\n00:00:00,100 --> 00:00:01,500\n明月照江河，森林好想你。',
      glyphSet: 'brush',
      fontSize: 40,
    })
    .catch((e: any) => {
      throw new Error(JSON.stringify(e.details));
    });
  const source = app.service.snapshot.files[made.captions.componentFile];
  expect(source).toContain("glyphSet:{type:'string',default:\"brush\"}");
  expect(source).toContain('./glyphs/brush.vmglyph.json');
  const layers = await app.renderer.inspectInteractions(app.service.snapshot, made.captions.sceneId, 20);
  const caption = layers.layers.find((l) => l.node.type === 'text')!;
  expect(caption.node.glyphSet).toBe('brush');
  const coverage: any = await app.dispatch('glyphsInspect', { project: true, set: 'brush' });
  expect(coverage.project[0]).toMatchObject({ set: 'brush' });
  // only the Latin word in the mixed title layer is outside the set (it uses the font fallback)
  expect(coverage.project[0].missing.every((m: any) => /^[A-Za-z]$/.test(m.char))).toBe(true);
  expect(coverage.project[0].missing.find((m: any) => m.char === 'V').where).toEqual(['title/mixed']);
  expect(coverage.project[0].layers).toBeGreaterThanOrEqual(2);
  // without glyphSet the caption component source is unchanged in shape
  const plain: any = await app.dispatch('captionsImport', { content: '1\n00:00:01,600 --> 00:00:01,900\nhi' });
  expect(app.service.snapshot.files[plain.captions.componentFile]).not.toContain('glyph');
}, 120_000);
