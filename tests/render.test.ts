import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, stat, readdir } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { Renderer } from '../src/core/renderer.js';
import { probe } from '../src/media/ffmpeg.js';
import { loadImage, createCanvas } from '@napi-rs/canvas';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-render-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app?.close();
  await rm(root, { recursive: true, force: true });
});
describe('native rendering and export', () => {
  it('rejects type-invalid component source without overwriting valid code', async () => {
    const original = await readFile(path.join(root, 'components/wave.ts'), 'utf8');
    await expect(
      app.service.transact([
        {
          type: 'writeSource',
          path: 'components/wave.ts',
          content: original + '\nconst invalid: number = "text";\n',
        },
      ]),
    ).rejects.toThrow('validation');
    expect(await readFile(path.join(root, 'components/wave.ts'), 'utf8')).toBe(original);
  });
  it('draws formula glyphs rather than an empty SVG', async () => {
    const frame = await app.frame({ frame: 90, width: 960, height: 540 });
    const image = await loadImage(frame.buffer),
      canvas = createCanvas(960, 540),
      ctx = canvas.getContext('2d');
    ctx.drawImage(image, 0, 0);
    const pixels = ctx.getImageData(55, 440, 470, 65).data;
    let bright = 0;
    for (let i = 0; i < pixels.length; i += 4) if (pixels[i] > 180 && pixels[i + 1] > 180) bright++;
    expect(bright).toBeGreaterThan(100);
  }, 30000);
  it('renders identical randomly accessed frames and exposes editable parameters', async () => {
    const first = await app.frame({ frame: 90, width: 640, height: 360 });
    await app.frame({ frame: 0, width: 640, height: 360 });
    const again = await app.frame({ frame: 90, width: 640, height: 360 });
    expect(first.buffer.equals(again.buffer)).toBe(true);
    expect(first.buffer.subarray(1, 4).toString()).toBe('PNG');
    const info = await app.dispatch('component', { source: 'components/wave.ts' });
    expect(info.parameters.amplitude.type).toBe('number');
  }, 30000);
  it('reports component errors and retains the last valid preview', async () => {
    await app.frame({ frame: 30, width: 320, height: 180 });
    await writeFile(path.join(root, 'components/wave.ts'), 'export default {');
    await app.service.reload();
    const validation = await app.dispatch('validate');
    expect(validation.valid).toBe(false);
    const frame = await app.frame({ frame: 30, width: 320, height: 180, fallback: true });
    expect(frame.stale).toBe(false);
    expect(app.service.pendingFiles?.['components/wave.ts']).toBe('export default {');
    await expect(
      app.dispatch('render', { output: path.join(root, 'invalid.mp4') }),
    ).rejects.toThrow('Fix project diagnostics');
  }, 30000);
  it('exports playable video with synchronized audio and checkpoint resume', async () => {
    const output = path.join(root, 'video.mp4');
    const job = app.renders.start(app.service.snapshot, {
      output,
      format: 'mp4',
      end: 6,
      width: 320,
      height: 180,
    });
    const result = await app.renders.wait(job.id);
    expect(result.error).toBeUndefined();
    expect(result.status).toBe('completed');
    const metadata = await probe(output);
    expect(metadata.streams.map((s) => s.codec_type)).toEqual(
      expect.arrayContaining(['video', 'audio']),
    );
    expect(Number(metadata.format.duration)).toBeCloseTo(0.2, 1);
    expect((await stat(output)).size).toBeGreaterThan(1000);
    const again = app.renders.start(app.service.snapshot, {
      output,
      format: 'mp4',
      end: 6,
      width: 320,
      height: 180,
    });
    expect((await app.renders.wait(again.id)).status).toBe('completed');
    const cacheRoot = path.join(root, '.vmotion/renders'),
      directories = await readdir(cacheRoot),
      checkpoint = path.join(cacheRoot, directories[0], 'checkpoint.json'),
      saved = JSON.parse(await readFile(checkpoint, 'utf8'));
    expect(saved.runtime).toMatch(/^[a-f0-9]{64}$/);
    saved.runtime = '0'.repeat(64);
    await writeFile(checkpoint, JSON.stringify(saved));
    const spy = vi.spyOn(Renderer.prototype, 'render');
    try {
      const stale = app.renders.start(app.service.snapshot, {
        output,
        format: 'mp4',
        end: 6,
        width: 320,
        height: 180,
      });
      expect((await app.renders.wait(stale.id)).status).toBe('completed');
      expect(spy).toHaveBeenCalledTimes(6);
    } finally {
      spy.mockRestore();
    }
  }, 30000);
  it('cancels a render without declaring a completed output', async () => {
    const job = app.renders.start(app.service.snapshot, {
      output: path.join(root, 'cancel.mp4'),
      format: 'mp4',
      width: 320,
      height: 180,
    });
    app.renders.cancel(job.id);
    expect((await app.renders.wait(job.id)).status).toBe('cancelled');
  }, 30000);
  it('reports unavailable explicit encoders before writing video pixels', async () => {
    const job = app.renders.start(app.service.snapshot, {
      output: path.join(root, 'missing-encoder.mp4'),
      format: 'mp4',
      end: 1,
      width: 320,
      height: 180,
      encoder: 'vmotion-no-such-encoder',
    });
    const result = await app.renders.wait(job.id);
    expect(result.status).toBe('failed');
    expect(result.error).toContain('Requested encoder is unavailable');
  });
});
