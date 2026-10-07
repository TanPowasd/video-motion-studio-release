import path from 'node:path';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('artifacts/repeater-ui-20261004');
if (!existsSync(path.join(root, 'project.vmotion.json'))) await initProject(root, '重复器交互验收');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/shape.ts',
      content: `import {defineComponent,rect,group} from '@vmotion/sdk';
    export default defineComponent({name:'Source',parameters:{},render:()=>group('motif',[
      rect('tile',{name:'基准图形',width:56,height:80,radius:8,fill:'#73e5d2',matrix:[1,0,.22,1,0,0]}),
      rect('line',{name:'亮线',x:10,y:16,width:34,height:3,fill:'#ffffff'})
    ],{name:'图形组合',x:70,y:90})});`,
    },
    { type: 'updateProject', patch: { width: 960, height: 540 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '重复图案',
        duration: 180,
        nodes: [
          newNode({
            id: 'base',
            type: 'component',
            component: 'components/shape.ts',
            name: '原始图形',
            width: 960,
            height: 540,
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
            name: '图案',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'pattern',
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
    await app.dispatch('drawingCreate', { name: '运行时验收画稿', width: 160, height: 90 });
  console.log(JSON.stringify({ root, revision: app.service.snapshot.revision }));
} finally {
  await app.close();
}
