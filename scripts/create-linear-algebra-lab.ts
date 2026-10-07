import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';

const root = path.resolve('examples/linear-algebra-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root))
  throw new Error('Close the project service before rebuilding/rendering this example');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits, or explicitly --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '线性代数 · 变换、拟合与优化');
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/linear-algebra.ts',
        content: await readFile('scripts/linear-algebra-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '线性代数实验室',
          duration: 360,
          background: '#091321',
          nodes: [
            newNode({
              id: 'math',
              type: 'component',
              component: 'components/linear-algebra.ts',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 360,
          tracks: [
            {
              id: 'visual',
              name: '数学可视化',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'math',
                  sceneId: 'intro',
                  start: 0,
                  duration: 360,
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
  for (const frame of [0, 60, 150, 240, 359])
    await writeFile(
      path.join(root, `exports/math-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const check = await app.dispatch('projectPreflight', {
    revision: app.service.snapshot.revision,
    samples: [0, 60, 150, 240, 359].map((frame) => ({ frame, sceneId: 'intro' })),
    determinism: true,
    visual: true,
    width: 480,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  console.log(JSON.stringify({ root, revision: app.service.snapshot.revision, preflight: check }));
  if (!check.valid) throw new Error('Math animation preflight failed');
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/linear-algebra-demo.mp4'),
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
