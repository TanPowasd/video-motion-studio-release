import path from 'node:path';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('artifacts/vector-ui-20261004');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '矢量编辑交互验收');
const app = await new Application(root).open(false);
try {
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/shapes.ts',
      content: `import {defineComponent,rect,ellipse,path} from '@vmotion/sdk';
      export default defineComponent({name:'矢量图层',parameters:{},render:()=>[
        rect('a',{name:'矩形 A',x:120,y:100,width:260,height:220,fill:'#72e6d4'}),
        ellipse('b',{name:'椭圆 B',x:300,y:160,width:260,height:220,fill:'#b6a2ff'}),
        path('curve','M0 0C200 -120 400 120 600 0',{name:'流动曲线',x:150,y:430,fill:'transparent',stroke:'#ffffff',strokeWidth:6,strokeCap:'round'})
      ]});`,
    },
    { type: 'updateProject', patch: { width: 960, height: 540 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '矢量交互',
        duration: 180,
        nodes: [
          newNode({
            id: 'shapes',
            type: 'component',
            name: '矢量图层',
            component: 'components/shapes.ts',
            width: 960,
            height: 540,
          }),
        ],
      },
    },
  ]);
  if (!(await app.dispatch('drawingList')).length)
    await app.dispatch('drawingCreate', { name: '打包绘画验收', width: 160, height: 90 });
  console.log(JSON.stringify({ root, revision: app.service.snapshot.revision }));
} finally {
  await app.close();
}
