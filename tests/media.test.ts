import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync, strToU8 } from 'fflate';
import { createCanvas } from '@napi-rs/canvas';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { runProcess, ffmpegBinary, probe } from '../src/media/ffmpeg.js';
import { loadProject } from '../src/service/project.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-media-'));
  await initProject(root);
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('imports layered OpenRaster pixels and pressure strokes as editable project objects', async () => {
  const canvas = createCanvas(64, 64);
  canvas.getContext('2d').fillRect(0, 0, 64, 64);
  const file = path.join(root, 'painting.ora');
  await writeFile(
    file,
    zipSync({
      mimetype: strToU8('image/openraster'),
      'stack.xml': strToU8(
        '<image w="64" h="64"><stack><layer name="Ink" src="data/layer.png" x="20" y="30"/></stack></image>',
      ),
      'data/layer.png': await canvas.encode('png'),
    }),
  );
  await app.dispatch('import', { path: file, type: 'image', sceneId: 'intro' });
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.name === 'Ink')).toMatchObject({
    x: 20,
    y: 30,
    type: 'image',
  });
  await app.dispatch('drawingStroke', {
    sceneId: 'intro',
    points: [
      { x: 10, y: 10, pressure: 0.2 },
      { x: 30, y: 50, pressure: 0.9 },
    ],
    color: '#ff0088',
    width: 12,
    start: 0,
    end: 30,
  });
  expect(app.service.snapshot.project.assets.some((a) => a.type === 'drawing')).toBe(true);
  expect((await app.frame({ frame: 15, width: 320, height: 180 })).buffer.length).toBeGreaterThan(
    500,
  );
}, 30000);
it('an audio asset has a measured waveform, mixes into export and packs portably', async () => {
  const audio = path.join(root, 'tone.wav');
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=1',
    '-c:a',
    'pcm_s16le',
    audio,
  ]);
  await app.dispatch('import', { path: audio, type: 'audio' });
  const asset = app.service.snapshot.project.assets[0];
  const peaks = await app.dispatch('waveform', { assetId: asset.id });
  expect(peaks.length).toBeGreaterThan(10);
  expect(Math.max(...peaks)).toBeGreaterThan(0.05);
  await app.service.transact([
    {
      type: 'addClip',
      sequenceId: 'main',
      trackId: 'voice',
      clip: {
        id: 'sound',
        assetId: asset.id,
        start: 0,
        duration: 30,
        sourceIn: 0,
        speed: 1,
        volume: 0.8,
        fadeIn: 3,
        fadeOut: 3,
      },
    },
  ]);
  const output = path.join(root, 'mix.wav');
  const job = app.renders.start(app.service.snapshot, { output, format: 'wav', end: 30 });
  expect((await app.renders.wait(job.id)).status).toBe('completed');
  const p = await probe(output);
  expect(Number(p.format.duration)).toBeCloseTo(1, 2);
  const portable = path.join(root, 'packed');
  await app.dispatch('pack', { output: portable });
  const packed = await loadProject(portable);
  expect(path.isAbsolute(packed.project.assets[0].path)).toBe(false);
  expect(
    (await readFile(path.join(portable, packed.project.assets[0].path))).length,
  ).toBeGreaterThan(1000);
}, 30000);
