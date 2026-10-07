import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { parseCaptions, captionsSchema } from '../src/core/captions.js';
import { measureTextBlock } from '../src/core/text-layout.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
it('parses SRT and WebVTT against a rational frame rate, strips styling and rejects overlapping cues', () => {
  const srt =
    '1\n00:00:01,000 --> 00:00:02,500\n第一行\n第二行\n\n2\n00:00:03,000 --> 00:00:04,000\n继续。';
  const doc = parseCaptions(srt, { num: 30000, den: 1001 });
  expect(doc.cues.map((c) => [c.start, c.end])).toEqual([
    [30, 75],
    [90, 120],
  ]);
  expect(
    parseCaptions(
      'WEBVTT\n\n00:01.000 --> 00:02.000 align:middle\n<b>Hello</b> &amp; world',
      { num: 30, den: 1 },
      'vtt',
    ).cues[0].text,
  ).toBe('Hello & world');
  expect(() =>
    parseCaptions('1\n00:00:01,000 --> 00:00:03,000\na\n\n2\n00:00:02,000 --> 00:00:04,000\nb', {
      num: 30,
      den: 1,
    }),
  ).toThrow('overlap');
  expect(() => captionsSchema.parse({ ...doc, cues: [doc.cues[0], doc.cues[0]] })).toThrow();
});
it('native text measurement accounts for wrapping when computing subtitle height', () => {
  const block = measureTextBlock('这是一条比较长的中文字幕，需要自动换行后完整显示。', {
    fontSize: 28,
    width: 260,
    lineHeight: 1.35,
  });
  expect(block.lineCount).toBeGreaterThan(1);
  expect(block.height).toBeCloseTo(block.lineCount * 28 * 1.35);
  expect(block.width).toBeLessThanOrEqual(260);
});
let root: string, app: Application;
beforeEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-captions-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async (context) => {
  if (!context.task.name.startsWith('integration:')) return;
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('integration: imports editable subtitles, renders only active cues, preserves wrapped text and supports undo', async () => {
  const original = app.service.snapshot.revision;
  const made = await app
    .dispatch('captionsImport', {
      content:
        '1\n00:00:01,000 --> 00:00:03,000\n这是一条比较长的中文字幕，自动换行后应当完整显示。',
      format: 'srt',
      fontSize: 42,
    })
    .catch((e) => {
      throw new Error(JSON.stringify(e.details));
    });
  expect(made.captions.count).toBe(1);
  const doc = await app.dispatch('captionsInspect', { dataFile: made.captions.dataFile });
  expect(doc.cues[0].start).toBe(30);
  const scene = made.captions.sceneId;
  const off = await app.renderer.inspectInteractions(app.service.snapshot, scene, 0);
  expect(off.layers.filter((l) => l.node.type === 'text')).toHaveLength(0);
  const on = await app.renderer.inspectInteractions(app.service.snapshot, scene, 45);
  expect(on.layers.filter((l) => l.node.type === 'text')).toHaveLength(1);
  const audit = await app.dispatch('visualAudit', { sceneId: scene, frames: [45], images: false });
  expect(audit.findings.some((f: { code: string }) => f.code === 'TEXT_TRUNCATED')).toBe(false);
  expect(await readFile(path.join(root, made.captions.dataFile), 'utf8')).toContain('cue-0001');
  await app.service.undo();
  expect(app.service.snapshot.revision).toBe(original);
}, 30000);
it('integration: invalid subtitles do not create partial data, component or tracks', async () => {
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('captionsImport', { content: '1\n00:00:01,000 --> 00:00:20,000\nLong' }),
  ).rejects.toThrow('exceeds');
  expect(app.service.snapshot.revision).toBe(revision);
  expect(Object.keys(app.service.snapshot.files).some((f) => f.includes('captions-'))).toBe(false);
});
