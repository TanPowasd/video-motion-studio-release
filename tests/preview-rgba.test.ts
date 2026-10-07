import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { serveHttp } from '../src/service/http.js';
import { newNode } from '../src/core/model.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-rgba-'));
  await initProject(root, 'rgba', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
  await app.service.transact([
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        background: 'transparent',
        nodes: [
          newNode({
            id: 'shape',
            type: 'rect',
            x: 20,
            y: 20,
            width: 90,
            height: 60,
            fill: '#ff2288',
            opacity: 0.5,
            effects: [{ type: 'blur', radius: 2 }],
          }),
        ],
      },
    },
  ]);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('transfers lossless raw preview pixels with the same dimensions/version/frame as decoded PNG', async () => {
  const png = await app.frame({ sceneId: 'intro', frame: 15, width: 320, height: 180 }),
    raw = await app.frame({ sceneId: 'intro', frame: 15, width: 320, height: 180, format: 'rgba' }),
    image = await loadImage(png.buffer),
    canvas = createCanvas(320, 180);
  canvas.getContext('2d').drawImage(image, 0, 0);
  expect(raw.buffer).toEqual(
    Buffer.from(canvas.getContext('2d').getImageData(0, 0, 320, 180).data),
  );
  expect(raw.revision).toBe(png.revision);
  expect(raw.buffer.length).toBe(320 * 180 * 4);
  expect(raw.encodeMs).toBeGreaterThanOrEqual(0);
  canvas.width = 1;
});
it('publishes HTTP transport/timing headers and keeps raw/PNG fallback formats separate', async () => {
  const server = await serveHttp(app, 0),
    address = server.address();
  if (!address || typeof address === 'string') throw new Error('No HTTP listener');
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const response = await fetch(
      `${base}/api/frame?scene=intro&frame=0&width=320&height=180&format=rgba`,
    );
    expect(response.headers.get('Content-Type')).toBe('application/x-vmotion-rgba');
    expect(response.headers.get('X-Vmotion-Width')).toBe('320');
    expect((await response.arrayBuffer()).byteLength).toBe(320 * 180 * 4);
    expect(response.headers.get('X-Vmotion-Render-Ms')).not.toBeNull();
    const legacy = await fetch(`${base}/api/frame?scene=intro&frame=0&width=320&height=180`);
    expect(legacy.headers.get('Content-Type')).toBe('image/png');
    const saved = await legacy.arrayBuffer(),
      failed = await app.frame({
        sceneId: 'missing',
        frame: 2,
        width: 320,
        height: 180,
        format: 'rgba',
        fallback: true,
      });
    expect(failed.stale).toBe(true);
    expect(failed.format).toBe('rgba');
    expect(failed.buffer.length).toBe(320 * 180 * 4);
    const pngFailure = await app.frame({ sceneId: 'missing', frame: 2, fallback: true });
    expect(pngFailure.format).toBe('png');
    expect(pngFailure.buffer).toEqual(Buffer.from(saved));
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
