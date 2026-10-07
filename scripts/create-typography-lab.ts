import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/typography-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits, or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '文字与形状动画', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 180,
          background: '#0b1220',
          nodes: [
            newNode({
              id: 'title',
              type: 'text',
              text: '让文字与形状，保持可编程。',
              x: 58,
              y: 42,
              width: 1164,
              height: 68,
              fontSize: 42,
              fontWeight: 700,
              fill: '#eef6ff',
            }),
            newNode({
              id: 'subtitle',
              type: 'text',
              text: '路径文字 · 字 / 词 / 行选择器 · 七种有序算子 · 原生几何缓存',
              x: 60,
              y: 117,
              width: 1160,
              height: 36,
              fontSize: 22,
              fill: '#9ab5cf',
            }),
            newNode({
              id: 'curve',
              type: 'path',
              x: 60,
              y: 176,
              path: 'M0 98C250 -30 680 230 1080 62',
              fill: 'transparent',
              stroke: '#294966',
              strokeWidth: 2,
            }),
            newNode({
              id: 'path-label',
              type: 'text',
              x: 60,
              y: 176,
              text: 'PATH TYPOGRAPHY  跟随曲线，让语言成为画面的一部分',
              fontSize: 32,
              fontWeight: 600,
              fill: '#7edbfb',
              pathText: { path: 'M0 98C250 -30 680 230 1080 62', align: 'center' },
              animations: [
                {
                  property: 'pathText.normalOffset',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 90, value: -12, easing: 'easeInOut' },
                    { frame: 179, value: 0 },
                  ],
                },
                {
                  property: 'pathText.tracking',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 90, value: 1.2, easing: 'easeInOut' },
                    { frame: 179, value: 0 },
                  ],
                },
              ],
            }),
            newNode({
              id: 'range-caption',
              type: 'text',
              text: '01  固定排版，范围动画',
              x: 60,
              y: 355,
              width: 500,
              height: 32,
              fontSize: 22,
              fontWeight: 600,
              fill: '#cedcf1',
            }),
            newNode({
              id: 'range-text',
              type: 'text',
              text: '选择 · 组合 · 自由创作\nStable words and lines',
              x: 60,
              y: 417,
              width: 560,
              height: 138,
              fontSize: 30,
              lineHeight: 1.65,
              fill: '#fafbff',
              textAnimators: [
                {
                  id: 'reveal',
                  selector: { unit: 'grapheme', start: 0, end: 0 },
                  values: { y: 20, opacity: 0, scaleY: 0.7 },
                },
                {
                  id: 'line-lift',
                  selector: { unit: 'line', mode: 'index', start: 1, end: 2 },
                  values: { x: 0 },
                },
              ],
              animations: [
                {
                  property: 'textAnimators.0.selector.start',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 100, value: 100, easing: 'easeInOut' },
                  ],
                },
                {
                  property: 'textAnimators.0.selector.end',
                  keys: [
                    { frame: 0, value: 100 },
                    { frame: 100, value: 100 },
                  ],
                },
                {
                  property: 'textAnimators.1.values.x',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 90, value: 12, easing: 'easeInOut' },
                    { frame: 179, value: 0 },
                  ],
                },
              ],
            }),
            newNode({
              id: 'shape-caption',
              type: 'text',
              text: '02  布尔 → 偏移 → 轮廓',
              x: 722,
              y: 355,
              width: 500,
              height: 32,
              fontSize: 22,
              fontWeight: 600,
              fill: '#cedcf1',
            }),
            newNode({
              id: 'shape',
              type: 'rect',
              x: 773,
              y: 427,
              width: 300,
              height: 130,
              fill: '#72ddc5',
              shapeOperators: [
                { id: 'round', type: 'round', radius: 22 },
                {
                  id: 'hole',
                  type: 'boolean',
                  operation: 'difference',
                  paths: [{ path: 'M90 30H210V100H90Z' }],
                },
                { id: 'offset', type: 'offset', amount: 0, join: 'round' },
                { id: 'outline', type: 'outline', width: 3, join: 'round' },
              ],
              animations: [
                {
                  property: 'shapeOperators.2.amount',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 90, value: 14, easing: 'easeInOut' },
                    { frame: 179, value: 0 },
                  ],
                },
              ],
            }),
            newNode({
              id: 'dash',
              type: 'path',
              x: 724,
              y: 603,
              path: 'M0 0C130 -50 320 50 444 0',
              fill: '#b49aff',
              shapeOperators: [
                { id: 'flow', type: 'dash', on: 18, off: 10, phase: 0 },
                { id: 'outline', type: 'outline', width: 5, cap: 'round' },
              ],
              animations: [
                {
                  property: 'shapeOperators.0.phase',
                  keys: [
                    { frame: 0, value: 0 },
                    { frame: 179, value: 84 },
                  ],
                },
              ],
            }),
            newNode({
              id: 'footer',
              type: 'text',
              text: '稳定 ID · 精简 MCP 候选 · 随机跳帧一致 · 预览与导出共用布局',
              x: 60,
              y: 660,
              width: 1160,
              height: 32,
              fontSize: 20,
              fill: '#7899b6',
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 180,
          tracks: [
            {
              id: 'video',
              name: '文字与形状',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'intro',
                  sceneId: 'intro',
                  start: 0,
                  duration: 180,
                  sourceIn: 0,
                  speed: 1,
                  volume: 1,
                  fadeIn: 0,
                  fadeOut: 0,
                },
              ],
            },
          ],
        },
      },
    ]);
  await mkdir(path.join(root, 'exports'), { recursive: true });
  for (const frame of [0, 36, 90, 140, 179])
    await writeFile(
      path.join(root, `exports/frame-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 36, 90, 140, 179],
    width: 640,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  const cached = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 90, 179],
      width: 1280,
      repeat: 3,
    }),
    baseline = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 90, 179],
      width: 1280,
      repeat: 3,
      graphicsCache: false,
    });
  await writeFile(
    path.join(root, 'exports/performance.json'),
    JSON.stringify({ cached, baseline }, null, 2),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
      format: 'mp4',
      encoder: 'libx264',
      output: path.join(root, 'exports/typography-shapes.mp4'),
    });
    console.log(JSON.stringify(await app.renders.wait(job.id)));
  }
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      audit: audit.summary,
      cachedMs: cached.summary.warmMeanMs,
      baselineMs: baseline.summary.warmMeanMs,
    }),
  );
} finally {
  await app.close();
}
