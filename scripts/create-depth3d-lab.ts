import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/depth3d-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root))
  throw new Error('Close example service before authoring or rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '原生深度 3D · 穿插遮挡');
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/depth3d.ts',
        content: await readFile('scripts/depth3d-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '深度缓冲与穿插物体',
          duration: 240,
          background: '#081422',
          nodes: [
            newNode({
              id: 'depth-demo',
              type: 'component',
              component: 'components/depth3d.ts',
              width: 1280,
              height: 720,
              params: { angle: 43, speed: 18 },
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 240,
          tracks: [
            {
              id: 'visual',
              name: '3D scene',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'depth-scene',
                  sceneId: 'intro',
                  start: 0,
                  duration: 240,
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
  const frames = [0, 45, 90, 150, 239];
  for (const frame of frames)
    await writeFile(
      path.join(root, `exports/depth-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const preflight = await app.dispatch('projectPreflight', {
    revision: app.service.snapshot.revision,
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    width: 480,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (!preflight.valid) throw new Error(JSON.stringify(preflight.diagnostics));
  const evidence = await app.dispatch('scene3dRender', {
    source: {
      sceneId: 'intro',
      nodeId: 'depth-demo/depth-tested',
      path: ['depth-demo'],
      frame: 90,
    },
    width: 540,
    output: path.join(root, 'exports/3d-evidence'),
    picks: [
      { x: 225, y: 175 },
      { x: 315, y: 175 },
    ],
  });
  await writeFile(path.join(root, 'exports/3d-evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      preflight: { valid: preflight.valid, diagnostics: preflight.diagnostics },
      evidence: { backend: evidence.backend, picks: evidence.picks, stats: evidence.stats },
    }),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/depth3d-demo.mp4'),
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
