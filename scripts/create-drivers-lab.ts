import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/drivers-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve existing edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '表达式、布局与曲线路径', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 4,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/lab.ts',
        content: await readFile('scripts/drivers-lab-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          nodes: [
            newNode({
              id: 'lab',
              type: 'component',
              component: 'components/lab.ts',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
    ]);
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 15, 45, 75, 119].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/drivers-lab.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(result.error);
  process.stdout.write(
    JSON.stringify(
      {
        root,
        revision: result.revision,
        output: result.output,
        frames: result.totalFrames,
        contact: checked.output,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
