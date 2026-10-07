import { performance } from 'node:perf_hooks';
import { mkdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
import { atomicWrite, json } from '../src/service/project.js';
const root = path.resolve('examples/science'),
  app = await new Application(root).open(false),
  snapshot = structuredClone(app.service.snapshot);
snapshot.project.width = 3840;
snapshot.project.height = 2160;
snapshot.project.fps = { num: 60, den: 1 };
snapshot.sequences[0].duration = 432000;
snapshot.sequences[0].tracks[0].clips[0].duration = 432000;
snapshot.scenes[0].duration = 432000;
for (let i = 0; i < 94; i++)
  snapshot.scenes[0].nodes.push(
    newNode({
      id: `benchmark-${i}`,
      type: i % 3 ? 'ellipse' : 'rect',
      x: (i % 16) * 230,
      y: 1200 + Math.floor(i / 16) * 140,
      width: 90,
      height: 90,
      fill: '#526597',
      opacity: 0.7,
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: (i % 16) * 230, easing: 'easeInOut' },
            { frame: 432000, value: (i % 16) * 230 + 35, easing: 'linear' },
          ],
        },
      ],
    }),
  );
const samples: number[] = [];
const memory: number[] = [];
try {
  await app.renderer.render(snapshot, 0, { width: 1920, height: 1080 });
  for (let i = 0; i < 60; i++) {
    const start = performance.now(),
      canvas = await app.renderer.render(snapshot, Math.round((431999 * i) / 59), {
        width: 1920,
        height: 1080,
      });
    await canvas.encode('png');
    samples.push(performance.now() - start);
    memory.push(process.memoryUsage().rss);
  }
  const start = performance.now(),
    full = await app.renderer.render(snapshot, 431999, { width: 3840, height: 2160 });
  await atomicWrite(path.resolve('artifacts/benchmark-4k.png'), await full.encode('png'));
  const p95 = [...samples].sort((a, b) => a - b)[Math.floor(samples.length * 0.95)];
  const result = {
    machine: 'current host; not the prescribed reference workstation',
    nodes: snapshot.scenes[0].nodes.length,
    timelineSeconds: 7200,
    preview: {
      width: 1920,
      height: 1080,
      meanMs: samples.reduce((a, b) => a + b) / samples.length,
      p95Ms: p95,
      meanFps: 1000 / (samples.reduce((a, b) => a + b) / samples.length),
    },
    last4KFrameMs: performance.now() - start,
    peakRssMB: Math.max(...memory) / 1024 / 1024,
    fullTwoHourExportTested: false,
    gpuTested: false,
  };
  await atomicWrite(path.resolve('artifacts/benchmark.json'), json(result));
  process.stdout.write(json(result));
} finally {
  await app.close();
}
