import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/visual-audit-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '画面检查与布局修复');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/layout.ts',
      content: await readFile('scripts/visual-audit-lab-component.ts', 'utf8'),
    },
    { type: 'updateProject', patch: { width: 1280, height: 720 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '排版与动态检查',
        duration: 120,
        nodes: [
          newNode({
            id: 'layout',
            type: 'component',
            name: '排版检查实验',
            component: 'components/layout.ts',
            width: 1280,
            height: 720,
          }),
        ],
      },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 120,
        tracks: [
          {
            id: 'visual',
            name: '排版检查',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'layout',
                sceneId: 'intro',
                start: 0,
                duration: 120,
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
  const before = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 59, 60, 119],
    width: 480,
    output: path.join(root, 'exports/layout-before.png'),
  });
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'layout',
    updates: [{ path: 'fixed', value: true }],
  });
  const after = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 59, 60, 119],
    width: 480,
    output: path.join(root, 'exports/layout-after.png'),
  });
  console.log(
    JSON.stringify(
      {
        root,
        before: {
          summary: before.summary,
          codes: [...new Set(before.findings.map((f: any) => f.code))],
          output: before.output,
        },
        after: { summary: after.summary, output: after.output },
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
