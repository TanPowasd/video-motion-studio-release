import path from 'node:path';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/vector-lab');
if (!existsSync(path.join(root, 'project.vmotion.json'))) await initProject(root, '矢量动画实验室');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/vectors.ts',
      content: await readFile('scripts/vector-lab-component.ts', 'utf8'),
    },
    { type: 'updateProject', patch: { width: 1920, height: 1080 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '矢量动画',
        duration: 240,
        nodes: [
          newNode({
            id: 'vectors',
            type: 'component',
            name: '矢量实验室',
            component: 'components/vectors.ts',
            width: 1920,
            height: 1080,
          }),
        ],
      },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 240,
        tracks: [
          {
            id: 'visual',
            name: '矢量动画',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'vectors',
                sceneId: 'intro',
                start: 0,
                duration: 240,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
        ],
      },
    },
  ]);
  await mkdir(path.join(root, 'exports'), { recursive: true });
  for (const frame of [0, 36, 90, 180, 239]) {
    const sample = await app.frame({ frame });
    await writeFile(path.join(root, `exports/vector-${frame}.png`), sample.buffer);
  }
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 36, 90, 180, 239],
    width: 640,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  console.log(
    JSON.stringify(
      {
        root,
        revision: app.service.snapshot.revision,
        diagnostics: app.service.diagnostics,
        audit: audit.summary,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--render')) {
    const job = app.renders.start(app.service.snapshot, {
      output: path.join(root, 'exports/vector-animation-1080p.mp4'),
      format: 'mp4',
      encoder: 'libx264',
    });
    const done = await app.renders.wait(job.id);
    console.log(JSON.stringify(done));
    if (done.status !== 'completed') process.exitCode = 1;
  }
} finally {
  await app.close();
}
