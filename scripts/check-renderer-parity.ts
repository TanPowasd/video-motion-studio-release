import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { loadProject, validateSnapshot } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
const baseline = process.argv.includes('--baseline');
const output = path.resolve('artifacts/renderer-parity-baseline.json');
await mkdir(path.dirname(output), { recursive: true });
const report: Array<Record<string, unknown>> = [];
for (const example of [
  'science',
  'animation-lab',
  'temporal-lab',
  'workstation-lab',
  'audio-lab',
  'depth3d-lab',
]) {
  const root = path.resolve('examples', example),
    snapshot = await loadProject(root);
  const renderer = new Renderer(root, { gpu: 'cpu' });
  try {
    const scene = snapshot.scenes[0];
    for (const frame of [scene.duration - 1, 0, Math.floor(scene.duration / 2)]) {
      const image = await renderer.render(snapshot, frame, {
        sceneId: scene.id,
        width: 640,
        height: 360,
      });
      try {
        const pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height).data;
        let min = 255,
          max = 0;
        for (let i = 3; i < pixels.length; i += 4) {
          min = Math.min(min, pixels[i]);
          max = Math.max(max, pixels[i]);
        }
        const interaction = await renderer.inspectInteractions(snapshot, scene.id, frame);
        report.push({
          example,
          revision: snapshot.revision,
          frame,
          width: image.width,
          height: image.height,
          hash: createHash('sha256').update(pixels).digest('hex'),
          alpha: { min, max },
          layers: interaction.layers.map((layer) => ({ id: layer.node.id, bounds: layer.bounds })),
          diagnostics: await validateSnapshot(root, snapshot),
          gpu: renderer.gpu.report().status,
        });
      } finally {
        image.width = 1;
        image.height = 1;
      }
    }
  } finally {
    await renderer.close();
  }
}
if (baseline) await writeFile(output, JSON.stringify(report, null, 2) + '\n');
else {
  assert.deepEqual(report, JSON.parse(await readFile(output, 'utf8')));
  await writeFile(
    'artifacts/renderer-parity-result.json',
    JSON.stringify({ passed: true, frames: report.length, examples: 6 }, null, 2),
  );
}
console.log(JSON.stringify({ baseline, frames: report.length, output }));
