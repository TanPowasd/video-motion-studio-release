import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
import { newNode, type Operation } from '../src/core/model.js';
const root = path.resolve('examples/graph-outputs-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error(
    'Use --render-only to preserve project edits; explicit --rebuild rewrites this example',
  );
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '通道与多输出合成', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const visual = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Visual / color + matte',
  parameters: { exposure: { type: 'number', default: 1, min: 0.2, max: 2 } },
  nodes: [
    { id: 'source', type: 'input' },
    {
      id: 'grade',
      type: 'colorMatrix',
      input: 'source',
      colorSpace: 'linear',
      matrix: [1.15, 0.1, 0.02, 0, 0, 0.1, 0.7, 0.1, 0, 0, 0.03, 0.04, 0.6, 0, 0, 0, 0, 0, 1, 0],
    },
    {
      id: 'matte',
      type: 'channels',
      red: 1,
      green: 1,
      blue: 1,
      alpha: { input: 'source', channel: 'alpha' },
    },
    {
      id: 'swap',
      type: 'channels',
      red: { input: 'source', channel: 'blue' },
      green: { input: 'source', channel: 'red' },
      blue: { input: 'source', channel: 'green' },
      alpha: { input: 'source', channel: 'alpha' },
    },
  ],
  links: [{ nodeId: 'grade', property: 'matrix.0', parameter: 'exposure' }],
  output: 'grade',
  outputs: { original: 'source', graded: 'grade', matte: 'matte', swapped: 'swap' },
});
const maskTint = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Shared matte / violet ink',
  parameters: { exposure: { type: 'number', default: 1, min: 0.2, max: 2 } },
  nodes: [
    { id: 'source', type: 'input' },
    {
      id: 'mask',
      type: 'subgraph',
      source: 'components/effects/visual.json',
      output: 'matte',
      inputs: { source: 'source' },
    },
    {
      id: 'ink',
      type: 'channels',
      red: 0.65,
      green: 0.53,
      blue: 1,
      alpha: { input: 'mask', channel: 'alpha' },
    },
  ],
  output: 'ink',
});
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      ...Object.entries({ visual, 'mask-tint': maskTint }).map(([id, graph]): Operation => ({
        type: 'writeSource',
        path: `components/effects/${id}.json`,
        content: JSON.stringify(graph, null, 2) + '\n',
      })),
      {
        type: 'writeSource',
        path: 'components/showcase.ts',
        content: await readFile('scripts/graph-outputs-lab-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#0b1423',
          nodes: [
            newNode({
              id: 'showcase',
              type: 'component',
              component: 'components/showcase.ts',
              width: 1280,
              height: 720,
              params: { exposure: 1 },
            }),
          ],
        },
      },
    ]);
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 22, 55, 99, 149, 179].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/graph-outputs-lab.mp4'),
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
