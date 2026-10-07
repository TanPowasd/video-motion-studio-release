import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { defineEffectGraph } from '../src/core/effect-graph.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/keying-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close this example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits; explicit --rebuild rewrites this example');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '抠像与背景重建', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const graph = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Green / keyed / matte',
  parameters: {
    threshold: { type: 'number', default: 0.08, min: 0, max: 0.35 },
    softness: { type: 'number', default: 0.15, min: 0, max: 0.4 },
  },
  nodes: [
    { id: 'source', type: 'input' },
    {
      id: 'key',
      type: 'keyer',
      input: 'source',
      color: '#36ff36',
      threshold: 0.08,
      softness: 0.15,
      spill: 0.6,
    },
    {
      id: 'matte',
      type: 'keyer',
      input: 'source',
      color: '#36ff36',
      threshold: 0.08,
      softness: 0.15,
      view: 'matte',
    },
  ],
  links: [
    { nodeId: 'key', property: 'threshold', parameter: 'threshold' },
    { nodeId: 'key', property: 'softness', parameter: 'softness' },
    { nodeId: 'matte', property: 'threshold', parameter: 'threshold' },
    { nodeId: 'matte', property: 'softness', parameter: 'softness' },
  ],
  output: 'key',
  outputs: { original: 'source', keyed: 'key', matte: 'matte' },
});
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/effects/key.json',
        content: JSON.stringify(graph, null, 2) + '\n',
      },
      {
        type: 'writeSource',
        path: 'components/showcase.ts',
        content: await readFile('scripts/keying-lab-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#0b1623',
          nodes: [
            newNode({
              id: 'showcase',
              type: 'component',
              component: 'components/showcase.ts',
              width: 1280,
              height: 720,
              params: { threshold: 0.08, softness: 0.15 },
            }),
          ],
        },
      },
    ]);
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 24, 55, 99, 149, 179].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const compare = await app.dispatch('renderCompare', {
    sceneId: 'intro',
    frames: [24, 55, 99, 149],
    width: 640,
    height: 360,
    repeat: 2,
  });
  if (!compare.equivalence.matched) throw new Error('Optimized keying pixels differ');
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/keying-lab.mp4'),
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
      comparison: {
        equivalence: compare.equivalence,
        difference: compare.difference,
        baseline: compare.baseline.graph,
        optimized: compare.optimized.graph,
      },
    }),
  );
} finally {
  await app.close();
}
