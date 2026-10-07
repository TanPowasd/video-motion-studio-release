import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/gpu-effects-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits; explicit --rebuild rewrites example');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, 'Direct3D12 逐像素特效', {
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
        content: await readFile('scripts/gpu-effects-lab-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#0c1628',
          nodes: [
            newNode({
              id: 'showcase',
              type: 'component',
              component: 'components/showcase.ts',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
    ]);
  const revision = app.service.snapshot.revision,
    frames = [0, 45, 90, 135, 179];
  const compared = await app.dispatch('renderCompare', {
    revision,
    sceneId: 'intro',
    frames: [0, 90, 179],
    repeat: 2,
    width: 1280,
    height: 720,
    pixelTolerance: 2,
    baseline: { gpu: 'cpu', graphOptimize: true },
    optimized: { gpu: 'gpu' },
  });
  if (!compared.equivalence.matched || !compared.optimized.gpu.requests)
    throw new Error(JSON.stringify(compared));
  const checked = await app.dispatch('projectPreflight', {
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    visual: true,
    determinism: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision,
      gpu: 'gpu',
      output: path.join(root, 'exports/gpu-effects-lab.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  console.log(
    JSON.stringify({
      root,
      revision,
      output: result.output,
      frames: result.totalFrames,
      contact: checked.output,
      gpu: result.gpu,
      equivalence: compared.equivalence,
      difference: compared.difference,
    }),
  );
} finally {
  await app.close();
}
