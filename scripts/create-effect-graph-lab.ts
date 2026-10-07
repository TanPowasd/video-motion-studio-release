import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode, type Operation } from '../src/core/model.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
const root = path.resolve('examples/effect-graph-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve existing edits');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, 'Agent 特效节点图', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 4,
  });
const branch = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Glow branch',
  parameters: {
    radius: { type: 'number', default: 7, min: 0, max: 50 },
    offset: { type: 'number', default: 8, min: -30, max: 30 },
  },
  nodes: [
    { id: 'src', type: 'input' },
    {
      id: 'glow',
      type: 'pass',
      input: 'src',
      effect: { type: 'glow', radius: 7, color: '#668bff', intensity: 1.4, threshold: 0.4 },
    },
    { id: 'shift', type: 'transform', input: 'glow', matrix: [1, 0, 0, 1, 8, 0] },
    {
      id: 'out',
      type: 'blend',
      foreground: 'shift',
      background: 'src',
      mode: 'screen',
      opacity: 0.7,
    },
  ],
  links: [
    { nodeId: 'glow', property: 'effect.radius', parameter: 'radius' },
    { nodeId: 'shift', property: 'matrix.4', parameter: 'offset' },
  ],
  output: 'out',
});
const mask = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Named layer mask',
  nodes: [
    { id: 'src', type: 'input' },
    { id: 'matte', type: 'input', slot: 'matte' },
    { id: 'out', type: 'mask', input: 'src', matte: 'matte' },
  ],
  output: 'out',
});
const warp = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Noise displacement',
  parameters: {
    amount: { type: 'number', default: 15, min: 0, max: 100 },
    evolution: { type: 'number', default: 0 },
  },
  nodes: [
    { id: 'src', type: 'input' },
    { id: 'map', type: 'noise', scale: 70, seed: 17, octaves: 3 },
    { id: 'out', type: 'displace', input: 'src', map: 'map', amountX: 15, amountY: 15 },
  ],
  links: [
    { nodeId: 'map', property: 'evolution', parameter: 'evolution' },
    { nodeId: 'out', property: 'amountX', parameter: 'amount' },
    { nodeId: 'out', property: 'amountY', parameter: 'amount' },
  ],
  output: 'out',
});
const nested = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Reusable glow',
  parameters: {
    opacity: { type: 'number', default: 0.7, min: 0, max: 1 },
    shift: { type: 'number', default: 12, min: -50, max: 50 },
  },
  nodes: [
    { id: 'src', type: 'input' },
    {
      id: 'child',
      type: 'subgraph',
      source: 'components/effects/branch.json',
      params: { radius: 5, offset: 2 },
      inputs: { source: 'src' },
    },
    { id: 'shift', type: 'transform', input: 'child' },
    { id: 'out', type: 'blend', background: 'src', foreground: 'shift', mode: 'screen' },
  ],
  links: [
    { nodeId: 'shift', property: 'matrix.4', parameter: 'shift' },
    { nodeId: 'out', property: 'opacity', parameter: 'opacity' },
  ],
  output: 'out',
});
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      ...Object.entries({ branch, mask, warp, nested }).map(([name, graph]): Operation => ({
        type: 'writeSource',
        path: `components/effects/${name}.json`,
        content: JSON.stringify(graph, null, 2) + '\n',
      })),
      {
        type: 'writeSource',
        path: 'components/lab.ts',
        content: await readFile('scripts/effect-graph-lab-component.ts', 'utf8'),
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
    output: path.join(root, 'exports/effect-graph-lab.mp4'),
  });
  const result = await app.renders.wait(job.id);
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
