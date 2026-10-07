import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
import { prepareCamera3D, project3D, type Camera3D } from '../src/sdk/index.js';
const root = path.resolve('examples/matrix3d-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root))
  throw new Error('Close the project service before rebuilding/rendering this example');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '矩阵 3D · 双相机与层级动画');
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/matrix3d.ts',
        content: await readFile('scripts/matrix3d-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '矩阵 3D',
          duration: 300,
          background: '#07111e',
          nodes: [
            newNode({
              id: 'matrix-world',
              type: 'component',
              component: 'components/matrix3d.ts',
              width: 1280,
              height: 720,
              params: { spin: 35, orbit: 22 },
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 300,
          tracks: [
            {
              id: 'visual',
              name: '三维画面',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'matrix3d',
                  sceneId: 'intro',
                  start: 0,
                  duration: 300,
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
  const frames = [0, 60, 150, 240, 299];
  for (const frame of frames)
    await writeFile(
      path.join(root, `exports/3d-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const preflight = await app.dispatch('projectPreflight', {
    revision: app.service.snapshot.revision,
    samples: frames.map((frame) => ({ frame, sceneId: 'intro' })),
    width: 480,
    determinism: true,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (!preflight.valid) throw new Error(JSON.stringify(preflight.diagnostics));
  // Compare equivalent projected vertex results and record timings without hardware-specific pass thresholds.
  const camera: Camera3D = {
      position: { x: 5, y: 3, z: 7 },
      target: { x: 0, y: 0, z: 0 },
      width: 1280,
      height: 720,
    },
    points = Array.from({ length: 5000 }, (_, i) => ({
      x: Math.sin(i) * 3,
      y: Math.cos(i * 0.1),
      z: Math.cos(i) * 3,
    })),
    prepared = prepareCamera3D(camera);
  const start = performance.now(),
    single = points.map((p) => project3D(p, camera)),
    singleMs = performance.now() - start,
    next = performance.now(),
    batch = prepared.projectPoints(points),
    batchMs = performance.now() - next;
  const maxError = Math.max(
    ...single.map((p, i) => Math.max(Math.abs(p.x - batch[i].x), Math.abs(p.y - batch[i].y))),
  );
  const benchmark = {
    vertices: points.length,
    singleMs,
    batchMs,
    speedup: singleMs / batchMs,
    maxPixelCoordinateError: maxError,
  };
  await writeFile(path.join(root, 'exports/benchmark.json'), JSON.stringify(benchmark, null, 2));
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      preflight: { valid: preflight.valid, samples: preflight.samples.length },
      benchmark,
    }),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/matrix3d-demo.mp4'),
        format: 'mp4',
        encoder: 'libx264',
      }),
      done = await app.renders.wait(job.id);
    console.log(JSON.stringify(done));
    if (done.status !== 'completed') process.exitCode = 1;
  }
} finally {
  await app.close();
}
