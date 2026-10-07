import { field } from '../tests/result-assertions.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode, sceneSchema } from '../src/core/model.js';
import { transitionStyles } from '../src/sdk/transitions.js';
import { hash } from '../src/service/project.js';
const root = path.resolve('examples/workstation-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits, or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '通用创作与性能', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 8,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    if (app.service.snapshot.scenes.some((s) => s.id === 'space' || s.id.startsWith('style-'))) {
      const cleanup: any[] = [
        {
          type: 'updateSequence',
          sequenceId: 'main',
          patch: {
            tracks: app.service.snapshot.sequences[0].tracks.map((t) => ({ ...t, clips: [] })),
          },
        },
        ...app.service.snapshot.scenes
          .filter((s) => s.id === 'space' || s.id.startsWith('style-'))
          .map((s) => ({ type: 'removeScene', sceneId: s.id })),
      ];
      const edits = Object.entries(app.service.snapshot.files)
        .filter(([name]) => name.startsWith('components/transitions/'))
        .map(([name, source]) => ({
          type: 'delete' as const,
          path: name,
          expectedHash: hash(source),
        }));
      if (edits.length) cleanup.push({ type: 'editFiles', edits });
      await app.service.transact(cleanup);
    }
    const source = String.raw`import {defineComponent,node,plot} from '@vmotion/sdk';export default defineComponent({name:'可编程数学画面',parameters:{},render(ctx){return [node({id:'heading',type:'text',text:'代码创作 · 数学可视化',x:74,y:54,width:1100,height:68,fontSize:42,fontWeight:700,fill:'#edf5ff'}),node({id:'subtitle',type:'text',text:'场景复用 / 动画 / 排版 / 矢量 / 转场',x:76,y:132,width:1110,height:34,fontSize:21,fill:'#98b7d6'}),node({id:'panel',type:'rect',x:70,y:207,width:1140,height:367,radius:18,fill:'#173552',effects:[{type:'shadow',x:0,y:6,blur:12,color:'#030a17'}]}),plot('curve',x=>Math.sin(x+ctx.seconds)*.75,[-Math.PI*2,Math.PI*2],{x:142,y:252,width:968,height:242,stroke:'#89dac4',strokeWidth:4}),node({id:'formula',type:'formula',text:'e^{i\\pi}+1=0',x:87,y:597,width:1090,height:63,fontSize:34,fill:'#ccdced'})]}});`;
    await app.service.transact([
      { type: 'writeSource', path: 'components/math.ts', content: source },
      {
        type: 'writeSource',
        path: 'components/depth.ts',
        content: await readFile('scripts/depth3d-component.ts', 'utf8'),
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 240,
          background: '#081522',
          nodes: [
            newNode({
              id: 'math',
              type: 'component',
              component: 'components/math.ts',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
      {
        type: 'addScene',
        scene: sceneSchema.parse({
          id: 'space',
          name: '原生三维画面',
          duration: 240,
          background: '#091523',
          nodes: [
            newNode({
              id: 'space',
              type: 'component',
              component: 'components/depth.ts',
              width: 1280,
              height: 720,
              params: { angle: 43, speed: 18 },
            }),
          ],
        }),
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 240,
          tracks: app.service.snapshot.sequences[0].tracks.map((t) => ({ ...t, clips: [] })),
        },
      },
    ]);
    const plan = await app.dispatch('transitionPlan', {
      items: transitionStyles.map((style, i) => ({
        sceneId: `style-${style}`,
        fromSceneId: i % 2 ? 'space' : 'intro',
        toSceneId: i % 2 ? 'intro' : 'space',
        style,
        name: `转场 · ${style}`,
        duration: 30,
        placement: { trackId: 'visual', at: i * 30 },
      })),
    });
    const checked = await app.dispatch('projectPreflight', plan.candidate);
    if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
    await app.dispatch('projectApply', plan.apply);
  }
  const frames = [0, ...transitionStyles.map((_, i) => i * 30 + 15), 239],
    contact = await app.dispatch('sample', {
      frames,
      width: 320,
      output: path.join(root, 'exports/contact.png'),
    });
  const on = await app.dispatch('renderProfile', {
      sceneId: 'style-crossfade',
      frames: [0, 15, 29],
      width: 1280,
      repeat: 3,
      encode: true,
    }),
    off = await app.dispatch('renderProfile', {
      sceneId: 'style-crossfade',
      frames: [0, 15, 29],
      width: 1280,
      repeat: 3,
      surfacePoolMb: 0,
    });
  if (JSON.stringify(field(on, 'frames')) !== JSON.stringify(field(off, 'frames')))
    throw new Error('Pooling changed pixels');
  await mkdir(path.join(root, 'exports'), { recursive: true });
  await writeFile(
    path.join(root, 'exports/performance.json'),
    JSON.stringify({ pooled: on, allocationBaseline: off }, null, 2),
  );
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/workstation-lab.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(result.error);
  process.stdout.write(
    JSON.stringify(
      {
        root,
        revision: result.revision,
        output: result.output,
        frames: result.totalFrames,
        contact: contact.output,
        performance: { pooled: on.summary, baseline: off.summary, pool: on.cache.surfaces },
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
