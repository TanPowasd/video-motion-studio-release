import path from 'node:path';
import { access } from 'node:fs/promises';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { musicStudioScore } from './music-studio-score.js';
const root = path.resolve('examples/music-studio-lab');
let exists = false;
try {
  await access(path.join(root, 'project.vmotion.json'));
  exists = true;
} catch {}
const renderOnly = process.argv.includes('--render-only');
if (exists && !renderOnly && !process.argv.includes('--rebuild'))
  throw new Error(
    'Existing example preserved. Use --render-only, or explicitly --rebuild to replace it.',
  );
if (!exists && renderOnly) throw new Error('Create the example before rendering it.');
if (!renderOnly)
  await initProject(root, '音乐工作室 · Pattern 编排', {
    template: 'blank',
    width: 640,
    height: 360,
    durationSeconds: 34,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    const plan = await app.dispatchTyped('soundPlan', {
      items: [
        {
          assetId: 'studio-score',
          document: musicStudioScore(),
          placement: { trackId: 'music', createTrack: '配乐', start: 0 },
        },
      ],
    });
    const checked = await app.dispatchTyped('projectPreflight', plan.candidate);
    if (!checked.valid) throw new Error('Example preflight failed');
    await app.dispatchTyped('projectApply', plan.apply);
  }
  console.log(
    JSON.stringify(await app.dispatchTyped('soundExport', { assetId: 'studio-score' }), null, 2),
  );
} finally {
  await app.close();
}
