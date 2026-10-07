import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/animation-layers-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits; explicit --rebuild rewrites example');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '动作层与循环编排', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/showcase.ts',
        content: await readFile('scripts/animation-layers-lab-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#0d1728',
          nodes: [
            newNode({
              id: 'showcase',
              type: 'component',
              component: 'components/showcase.ts',
              width: 1280,
              height: 720,
              params: { amplitude: 24 },
            }),
          ],
        },
      },
    ]);
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 24, 55, 90, 149, 179].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/animation-layers-lab.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  console.log(
    JSON.stringify({
      root,
      revision: result.revision,
      output: result.output,
      frames: result.totalFrames,
      contact: checked.output,
    }),
  );
} finally {
  await app.close();
}
