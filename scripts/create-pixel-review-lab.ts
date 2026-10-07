import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/pixel-review-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits; explicit --rebuild rewrites example');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '原生像素检查实验室', {
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
        content: await readFile('scripts/pixel-review-lab-component.ts', 'utf8'),
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
  const scopes = await app.dispatch('colorScopes', {
    revision,
    scope: { sceneId: 'intro' },
    frames,
    width: 640,
    output: path.join(root, 'exports/scopes.png'),
  });
  const impact = await app.dispatch('layerImpact', {
    revision,
    sceneId: 'intro',
    nodeIds: ['showcase/covered', 'showcase/mask', 'showcase/moving'],
    frames: [45, 135],
    width: 640,
    maxImages: 6,
    output: path.join(root, 'exports/impact.png'),
  });
  const plan = await app.dispatch('visualRepairPlan', {
    revision,
    sceneId: 'intro',
    frame: 45,
    frames: [45, 135],
    targets: [{ nodeId: 'showcase/moving', actions: [{ type: 'move', delta: { x: 25, y: -20 } }] }],
  });
  const comparison = await app.dispatch('frameCompare', {
    revision,
    planId: plan.candidate.planId,
    scope: { sceneId: 'intro' },
    frames: [45, 135],
    width: 640,
    output: path.join(root, 'exports/comparison.png'),
  });
  const checked = await app.dispatch('projectPreflight', {
    samples: frames.map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision,
      output: path.join(root, 'exports/pixel-review-lab.mp4'),
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
      scopes: scopes.output,
      impact: impact.output,
      comparison: comparison.output,
    }),
  );
} finally {
  await app.close();
}
