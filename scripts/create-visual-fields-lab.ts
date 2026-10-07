import { field } from '../tests/result-assertions.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/visual-fields-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits, or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '程序化纹理与光效', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 4,
  });
const app = await new Application(root).open(false);
const source = String.raw`import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'可组合视觉图',parameters:{},render(ctx){
const titles=['域扭曲纹理','大理石与调色','图层纹理置换','多级辉光','径向光束','渐变映射'],ids=['field','marble','distort','bloom','rays','tone'],items=[node({id:'heading',type:'text',text:'代码生成视觉，让效果保持可组合。',x:54,y:40,width:1180,height:61,fontSize:39,fontWeight:700,fill:'#edf6ff'}),node({id:'subtitle',type:'text',text:'程序化纹理 / 图层输入 / 光效 / 调色 / 明确的性能证据',x:56,y:113,width:1165,height:32,fontSize:20,fill:'#9eb7d3'})];
ids.forEach((id,i)=>{const x=54+(i%3)*402,y=218+Math.floor(i/3)*222;
items.push(node({id:'label-'+id,type:'text',text:titles[i],x,y:y-40,width:370,height:30,fontSize:23,fontWeight:600,fill:'#dce8fa'}));
items.push(node({id:'panel-'+id,type:'rect',x,y,width:370,height:166,radius:12,fill:'#162a42'}));
items.push(node({id,type:id==='rays'?'ellipse':'rect',x:x+28,y:y+22,width:id==='rays'?40:314,height:id==='rays'?40:122,radius:8,fill:id==='tone'?'#eab781':id==='rays'?'#ffffff':'#68b7d7'}));
if(id==='distort'){items.push(node({id:'map',type:'rect',x:x+28,y:y+22,width:314,height:122,fill:'#000000'}),node({id:'mask-carrier',type:'rect',opacity:0,maskId:'map'}));items.push(node({id:'distort-text',type:'text',parentId:'distort',text:'WAVE / 纹理',x:22,y:36,width:280,height:48,fontSize:30,fontWeight:800,fill:'#ffffff'}));}
});items.push(node({id:'footer',type:'text',text:'固定时间与种子 · 参数可动画 · 同一预览/导出管线 · 外部 Agent 通过 MCP 创作',x:56,y:678,width:1165,height:28,fontSize:17,fill:'#8ca8c6'}));return items;}});`;
try {
  if (!renderOnly) {
    await app.service.transact([
      { type: 'writeSource', path: 'components/lab.ts', content: source },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 120,
          nodes: [
            newNode({
              id: 'lab',
              type: 'component',
              component: 'components/lab.ts',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
      { type: 'updateSequence', sequenceId: 'main', patch: { duration: 120 } },
    ]);
    const apply = async (
      preset: string,
      nodeId: string,
      params: unknown,
      keys: unknown[] = [],
      bindings: unknown = {},
    ) => {
      const plan = await app.dispatch('visualPlan', {
        revision: app.service.snapshot.revision,
        preset,
        targets: [
          { sceneId: 'intro', path: ['lab'], nodeId: `lab/${nodeId}`, params, keys, bindings },
        ],
      });
      await app.dispatch('projectApply', plan.apply);
    };
    await apply('texture', 'field', { warp: 2, scale: 46, low: '#12394a', high: '#92ebcc' }, [
      {
        parameter: 'evolution',
        keys: [
          { frame: 0, value: 0 },
          { frame: 119, value: 1.8 },
        ],
      },
    ]);
    await apply('marble', 'marble', { warp: 0.4, scale: 34, low: '#273155', high: '#d6b7e8' }, [
      {
        parameter: 'evolution',
        keys: [
          { frame: 0, value: 0 },
          { frame: 119, value: 1 },
        ],
      },
    ]);
    await apply('cellular', 'map', { scale: 35, low: '#183742', high: '#eaefd8' }, [
      {
        parameter: 'evolution',
        keys: [
          { frame: 0, value: 0 },
          { frame: 119, value: 1.3 },
        ],
      },
    ]);
    await apply('layerDisplace', 'distort', { amountX: 11, amountY: 5 }, [], { map: 'map' });
    await apply('neonBloom', 'bloom', {
      radius: 6,
      intensity: 1.4,
      threshold: 0.4,
      color: '#8bdaf1',
    });
    await apply(
      'radialRays',
      'rays',
      { center: { x: 0.5, y: 0.5 }, length: 0.6, intensity: 2, threshold: 0.1, color: '#e7f3ff' },
      [
        {
          parameter: 'center.x',
          keys: [
            { frame: 0, value: -1 },
            { frame: 59, value: 0.5 },
            { frame: 119, value: 2 },
          ],
        },
      ],
    );
    await apply('duotone', 'tone', { low: '#1a365a', high: '#a4e9cc', intensity: 1 });
  }
  const check = await app.dispatch('projectPreflight', {
    samples: [0, 30, 60, 90, 119].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
  const bounded = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [30],
      width: 1280,
      repeat: 2,
    }),
    full = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [30],
      width: 1280,
      repeat: 2,
      fieldScan: 'full',
    });
  if (JSON.stringify(field(bounded, 'frames')) !== JSON.stringify(field(full, 'frames')))
    throw new Error('Region optimization changed pixels');
  await mkdir(path.join(root, 'exports'), { recursive: true });
  await writeFile(
    path.join(root, 'exports/performance.json'),
    JSON.stringify({ bounded, full }, null, 2),
  );
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/visual-fields.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(result.error);
  process.stdout.write(
    JSON.stringify(
      {
        root,
        revision: result.revision,
        output: result.output,
        frames: 120,
        contact: check.output,
        performance: {
          bounded: bounded.summary,
          full: full.summary,
          boundedFieldPixels: bounded.cache.fieldPixels,
          fullFieldPixels: full.cache.fieldPixels,
        },
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
