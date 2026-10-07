import path from 'node:path';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('artifacts/shared-scene-ui-20261004');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '共享合成交互验收');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    { type: 'updateProject', patch: { width: 960, height: 540 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '主场景',
        duration: 180,
        background: '#111a29',
        nodes: [
          newNode({ id: 'group', type: 'group', name: '信息卡', x: 90, y: 90 }),
          newNode({
            id: 'panel',
            parentId: 'group',
            type: 'rect',
            name: '卡片底板',
            width: 300,
            height: 180,
            radius: 16,
            fill: '#1c344a',
          }),
          newNode({
            id: 'heading',
            parentId: 'group',
            type: 'text',
            name: '卡片标题',
            x: 26,
            y: 50,
            width: 250,
            height: 70,
            fontSize: 36,
            text: '共享文字',
            fill: '#75e6d3',
          }),
        ],
      },
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 180,
        tracks: [
          {
            id: 'visual',
            name: '主场景',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'intro',
                sceneId: 'intro',
                start: 0,
                duration: 180,
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
  if (!(await app.dispatch('drawingList')).length)
    await app.dispatch('drawingCreate', { name: '打包绘画检查', width: 160, height: 90 });
  console.log(JSON.stringify({ root, revision: app.service.snapshot.revision }));
} finally {
  await app.close();
}
