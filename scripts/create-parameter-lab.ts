import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/parameter-lab');
await initProject(root, '结构化参数与数据动画');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 1280, height: 720 } },
    {
      type: 'writeSource',
      path: 'components/data.ts',
      content: await readFile('scripts/parameter-lab-component.ts', 'utf8'),
    },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '参数与数据动画',
        duration: 240,
        nodes: [
          newNode({
            id: 'chart',
            type: 'component',
            name: '可编辑数据组件',
            component: 'components/data.ts',
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
        duration: 240,
        tracks: [
          {
            id: 'visual',
            type: 'video',
            name: '数据动画',
            muted: false,
            clips: [
              {
                id: 'intro-clip',
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
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'chart',
    keys: [
      { path: 'data.1.value', frame: 0, value: 20 },
      { path: 'data.1.value', frame: 180, value: 92 },
      { path: 'origin.x', frame: 0, value: 150 },
      { path: 'origin.x', frame: 180, value: 225 },
    ],
  });
  const preview = await app.dispatch('sample', {
    frames: [0, 60, 120, 180],
    sceneId: 'intro',
    width: 480,
    output: path.join(root, 'exports/parameter-frames.png'),
  });
  console.log(JSON.stringify({ root, preview }, null, 2));
} finally {
  await app.close();
}
