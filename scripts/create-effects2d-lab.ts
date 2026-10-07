import path from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/effects2d-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Example exists; use --render-only to preserve edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '平面特效 · Agent 工作流');
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/effects2d.ts',
        content: await readFile('scripts/effects2d-component.ts', 'utf8'),
      },
      { type: 'updateProject', patch: { width: 1280, height: 720 } },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: '平面特效',
          duration: 240,
          nodes: [
            newNode({
              id: 'gallery',
              type: 'component',
              component: 'components/effects2d.ts',
              width: 1280,
              height: 720,
              params: { strength: 1 },
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
              id: 'v',
              name: '2D effects',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'effects',
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
  const frames = [0, 30, 60, 120, 239];
  for (const frame of frames)
    await writeFile(
      path.join(root, `exports/effects-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const check = await app.dispatch('projectPreflight', {
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    determinism: true,
    width: 480,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
  const inspect = await app.dispatch('effectsInspect', {
    sceneId: 'intro',
    path: ['gallery'],
    frame: 30,
    nodeIds: ['gallery/sample-wave', 'gallery/sample-rgb'],
  });
  await writeFile(
    path.join(root, 'exports/agent-inspection.json'),
    JSON.stringify(inspect, null, 2),
  );
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      preflight: { valid: check.valid, diagnostics: check.diagnostics },
      effects: inspect.layers.map((l: any) => ({
        id: l.nodeId,
        types: l.effects.map((e: any) => e.type),
      })),
    }),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/planar-effects.mp4'),
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
