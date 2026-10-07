import { field } from '../tests/result-assertions.js';
import path from 'node:path';
import { writeFile, mkdir } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
const root = path.resolve('examples/plugin-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    if (!process.argv.includes('--rebuild'))
      throw new Error('Use explicit --rebuild or --render-only to preserve edits');
    if (!app.service.snapshot.project.plugins?.length) {
      const plan = await app.dispatch('pluginsPlan', {
        revision: app.service.snapshot.revision,
        actions: [{ type: 'register', source: 'components/plugins/creative/plugin.json' }],
      });
      const check = await app.dispatch('projectPreflight', plan.candidate);
      if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
      await app.dispatch('projectApply', plan.apply);
    }
    const planned = field(
        await app.dispatch('agentToolInvoke', {
          name: 'plugin.example.creative.compose',
          arguments: { revision: app.service.snapshot.revision },
        }),
        'value',
      ),
      check = await app.dispatch('projectPreflight', field(planned, 'candidate'));
    if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
    await app.dispatch('projectApply', field(planned, 'apply'));
  }
  await mkdir(path.join(root, 'exports'), { recursive: true });
  for (const frame of [0, 30, 90, 150, 179])
    await writeFile(
      path.join(root, `exports/frame-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 30, 90, 150, 179],
    width: 640,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  if (renderOnly || process.argv.includes('--render')) {
    const job = app.renders.start(app.service.snapshot, {
        format: 'mp4',
        encoder: 'libx264',
        output: path.join(root, 'exports/plugin-workflow.mp4'),
      }),
      done = await app.renders.wait(job.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done));
    console.log(JSON.stringify(done));
  }
  console.log(JSON.stringify({ revision: app.service.snapshot.revision, audit: audit.summary }));
} finally {
  await app.close();
}
