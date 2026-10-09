// Render the glyph demo: a title and caption drawn entirely from composed components, the same text
// with font fallback mixed in, and an IDS breakdown sheet. Usage:
//   VMOTION_RUNTIME=<runtime with fonts> npx tsx scripts/render-glyphs-demo.ts <outDir>
import { mkdtemp, mkdir, rm, writeFile, copyFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';

const out = path.resolve(process.argv[2] ?? 'artifacts/glyphs-demo');
await mkdir(out, { recursive: true });
const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-glyph-demo-'));
await initProject(root, '字形演示', { template: 'blank', width: 1920, height: 1080, durationSeconds: 3 });
const app = await new Application(root).open(false);
try {
  const scene = app.service.snapshot.scenes[0].id;
  const title = '明月照江河，森林好想你。';
  await app.dispatch('transact', {
    revision: app.service.snapshot.revision,
    operations: [
      { type: 'updateScene', sceneId: scene, patch: { background: '#0f1420' } },
      { type: 'addNode', sceneId: scene, node: { id: 'label1', type: 'text', text: '全部由部件拼成（builtin:demo，无字体）', x: 120, y: 70, width: 1680, height: 50, fontSize: 32, fill: '#8892a6' } },
      { type: 'addNode', sceneId: scene, node: { id: 'composed', type: 'text', text: title, x: 120, y: 130, width: 1680, height: 170, fontSize: 132, fill: '#ffffff', align: 'center', glyphSet: 'builtin:demo', glyphFallback: 'tofu' } },
      { type: 'addNode', sceneId: scene, node: { id: 'composed2', type: 'text', text: '春江花月夜？不，是「明日休闲」', x: 120, y: 330, width: 1680, height: 120, fontSize: 84, fill: '#ffd166', align: 'center', glyphSet: 'builtin:demo', glyphFallback: 'font' } },
      { type: 'addNode', sceneId: scene, node: { id: 'label2', type: 'text', text: '缺字回退到字体：fallback = font（上）/ tofu（下）', x: 120, y: 480, width: 1680, height: 50, fontSize: 32, fill: '#8892a6' } },
      { type: 'addNode', sceneId: scene, node: { id: 'mixed', type: 'text', text: '江河湖海 Vmotion 2026 龘', x: 120, y: 540, width: 1680, height: 120, fontSize: 96, fill: '#7cd4ff', align: 'center', glyphSet: 'builtin:demo', glyphFallback: 'font' } },
      { type: 'addNode', sceneId: scene, node: { id: 'tofu', type: 'text', text: '江河湖海 龘 好', x: 120, y: 680, width: 1680, height: 120, fontSize: 96, fill: '#ff8fa3', align: 'center', glyphSet: 'builtin:demo', glyphFallback: 'tofu' } },
      { type: 'addNode', sceneId: scene, node: { id: 'font', type: 'text', text: '对照（字体）：明月照江河，森林好想你。', x: 120, y: 820, width: 1680, height: 80, fontSize: 56, fill: '#5f6b80', align: 'center' } },
    ],
  });
  const caption: any = await app.dispatch('captionsImport', {
    content: '1\n00:00:00,000 --> 00:00:03,000\n明月照江河，森林好想你。',
    glyphSet: 'builtin:demo',
    glyphFallback: 'font',
    fontSize: 56,
    bottom: 60,
  });
  const save = async (name: string, sceneId: string, frame = 30) => {
    const r: any = await app.frame({ sceneId, frame, width: 1920, height: 1080, format: 'rgba' });
    const canvas = createCanvas(1920, 1080);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), 1920, 1080), 0, 0);
    await writeFile(path.join(out, name), await canvas.encode('png'));
  };
  await save('glyphs-title.png', scene);
  // caption composited over the title scene through the active sequence
  const r: any = await app.frame({ frame: 30, width: 1920, height: 1080, format: 'rgba' });
  const canvas = createCanvas(1920, 1080);
  canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.buffer), 1920, 1080), 0, 0);
  await writeFile(path.join(out, 'glyphs-caption.png'), await canvas.encode('png'));
  const sheet: any = await app.dispatch('glyphsInspect', { set: 'builtin:demo', expression: '⿰氵⿱木口', preview: '湖江河海林森想国问这起床病区句明好你', previewSize: 112 });
  await copyFile(sheet.output, path.join(out, 'glyphs-ids-sheet.png'));
  const report: any = await app.dispatch('glyphsInspect', { project: true });
  console.log(JSON.stringify({ out, captionScene: caption.captions.sceneId, coverage: report.project.map((p: any) => ({ set: p.set, ratio: p.ratio, missing: p.missing.map((m: any) => m.char).join('') })) }, null, 2));
} finally {
  await app.close();
  await rm(root, { recursive: true, force: true });
}
