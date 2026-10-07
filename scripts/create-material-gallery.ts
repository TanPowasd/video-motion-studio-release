import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/material-gallery'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '三维材质 · 光照与法线');
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/material-gallery.ts',
        content: await readFile('scripts/material-gallery-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '原生材质',
          duration: 180,
          nodes: [
            newNode({
              id: 'gallery',
              type: 'component',
              component: 'components/material-gallery.ts',
              width: 1280,
              height: 720,
              params: { spin: 20, exposure: 1 },
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
              id: 'v',
              name: 'Materials',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'materials',
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
  const frames = [0, 30, 75, 120, 179];
  for (const frame of frames)
    await writeFile(
      path.join(root, `exports/material-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const check = await app.dispatch('projectPreflight', {
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    width: 480,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
  const evidence = await app.dispatch('scene3dRender', {
    source: { sceneId: 'intro', path: ['gallery'], nodeId: 'gallery/material-metal', frame: 75 },
    width: 480,
    output: path.join(root, 'exports/material-evidence'),
  });
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      preflight: { valid: check.valid, diagnostics: check.diagnostics },
      evidence: {
        backend: evidence.backend,
        visiblePixels: evidence.visiblePixels,
        materials: evidence.materials,
      },
    }),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/material-gallery.mp4'),
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
