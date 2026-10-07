import { field } from '../tests/result-assertions.js';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';
import { hash } from '../src/service/project.js';
const projectOption = process.argv.indexOf('--project');
if (
  projectOption >= 0 &&
  (!process.argv[projectOption + 1] || process.argv[projectOption + 1].startsWith('--'))
)
  throw new Error('--project requires an output directory');
const root = path.resolve(
    projectOption >= 0 ? process.argv[projectOption + 1] : 'examples/design-lab',
  ),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '主题与模板实例', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const app = await new Application(root).open(false);
const source = String.raw`import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'可编辑信息卡',parameters:{title:{type:'string',default:'默认标题'},accent:{type:'color',default:'#59bada'},size:{type:'number',default:30,min:18,max:48},value:{type:'number',default:62,min:0,max:100}},render(ctx,p){return [node({id:'panel',type:'rect',width:360,height:318,radius:18,fill:'#162a3e',stroke:'#35546c',strokeWidth:1}),node({id:'bar',type:'rect',x:26,y:30,width:44,height:6,radius:3,fill:p.accent}),node({id:'label',type:'text',text:p.title,x:26,y:66,width:312,height:100,fontSize:p.size,fontWeight:700,lineHeight:1.5,fill:'#eef6ff'}),node({id:'value',type:'text',text:String(Math.round(p.value)),x:26,y:198,width:270,height:70,fontSize:52,fontWeight:700,fill:p.accent}),node({id:'hint',type:'text',text:'SOURCE / VERSION 1',x:26,y:285,width:312,height:24,fontSize:13,fill:'#809fb8'})]}});`;
async function apply<M extends 'themePlan' | 'templatePlan'>(method: M, request: unknown) {
  const plan = await app.dispatch(method, {
    revision: app.service.snapshot.revision,
    ...(request as object),
  });
  const check = await app.dispatch('projectPreflight', field(plan, 'candidate'));
  if (!check.valid) throw new Error(JSON.stringify(check.diagnostics));
  await app.dispatch('projectApply', field(plan, 'apply'));
  return plan;
}
try {
  if (!renderOnly) {
    const versions = Object.keys(app.service.snapshot.files)
        .map((f) => /^components\/templates\/design-card\/v(\d+)\/manifest\.json$/.exec(f))
        .filter(Boolean)
        .map((m) => Number(m![1])),
      first = Math.max(0, ...versions) + 1,
      author = source.replace('SOURCE / VERSION 1', 'SOURCE / VERSION ' + first);
    const bootstrap = [
      newNode({
        id: 'heading',
        type: 'text',
        text: '让风格统一，让每个实例保持自由。',
        x: 54,
        y: 44,
        width: 1170,
        height: 65,
        fontSize: 42,
        fontWeight: 700,
        fill: '#f0f7ff',
      }),
      newNode({
        id: 'subtitle',
        type: 'text',
        text: '实时主题 / 固定源码版本 / 选择性升级 / 自定义参数与动画保留',
        x: 56,
        y: 126,
        width: 1168,
        height: 34,
        fontSize: 22,
        fill: '#8faccc',
      }),
      newNode({
        id: 'footer',
        type: 'text',
        text: '外部 Agent：查询版本 → 精简候选 → 画面预检 → 原样提交 → 一次撤销',
        x: 56,
        y: 653,
        width: 1170,
        height: 34,
        fontSize: 20,
        fill: '#87a7c2',
      }),
    ];
    await app.service.transact([
      { type: 'writeSource', path: 'components/card.ts', content: author },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: { duration: 180, background: '#09131f', nodes: bootstrap },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 180,
          tracks: [
            {
              id: 'visual',
              name: '设计资源',
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
    const theme = 'components/themes/brand.json';
    await apply('themePlan', {
      source: theme,
      expectedHash:
        app.service.snapshot.files[theme] === undefined
          ? null
          : hash(app.service.snapshot.files[theme]),
      document: {
        kind: 'theme',
        version: 1,
        id: 'brand',
        name: '统一蓝色主题',
        tokens: [
          { id: 'brand.accent', type: 'color', value: '#65cfda' },
          { id: 'type.heading', type: 'number', value: 30, min: 18, max: 48 },
        ],
      },
    });
    const definition = {
        id: 'design-card',
        name: '信息卡',
        version: first,
        width: 360,
        height: 318,
        duration: 180,
        parameters: {
          title: { type: 'string', default: '默认标题' },
          accent: { type: 'color', default: '#59bada' },
          size: { type: 'number', default: 30, min: 18, max: 48 },
          value: { type: 'number', default: 62, min: 0, max: 100 },
        },
        ports: [
          { parameter: 'title', nodeId: 'content', property: 'params.title' },
          { parameter: 'accent', nodeId: 'content', property: 'params.accent' },
          { parameter: 'size', nodeId: 'content', property: 'params.size' },
          { parameter: 'value', nodeId: 'content', property: 'params.value' },
        ],
      },
      nodes = [
        newNode({
          id: 'content',
          type: 'component',
          component: 'components/card.ts',
          width: 360,
          height: 318,
          params: { title: '默认标题', accent: '#59bada', size: 30, value: 62 },
        }),
      ];
    const one = await apply('templatePlan', {
      publish: { definition, nodes },
      placements: [
        { sceneId: 'intro', nodeId: 'old', x: 56, y: 278 },
        { sceneId: 'intro', nodeId: 'updated', x: 460, y: 278 },
        {
          sceneId: 'intro',
          nodeId: 'custom',
          x: 864,
          y: 278,
          params: { title: '自己的标题', value: 84 },
        },
      ],
    });
    await apply('themePlan', {
      source: theme,
      targets: ['old', 'updated', 'custom'].map((nodeId) => ({
        sceneId: 'intro',
        nodeId,
        links: { 'params.accent': 'brand.accent', 'params.size': 'type.heading' },
      })),
    });
    await app.dispatch('componentParametersEdit', {
      sceneId: 'intro',
      nodeId: 'custom',
      keys: [
        { path: 'value', frame: 0, value: 40 },
        { path: 'value', frame: 90, value: 84 },
        { path: 'value', frame: 179, value: 70 },
      ],
    });
    await app.dispatch('compositionTransact', {
      sceneId: 'intro',
      nodeId: 'custom/content/label',
      path: ['custom', 'custom/content'],
      frame: 0,
      contextFrames: [0, 0],
      patch: { fill: '#ffd28b' },
    });
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/card.ts',
        content: author
          .replace('SOURCE / VERSION ' + first, 'SOURCE / VERSION ' + (first + 1))
          .replace("fill:'#162a3e'", "fill:'#1a3147'"),
      },
    ]);
    const two = await apply('templatePlan', {
      publish: {
        definition: {
          ...definition,
          version: first + 1,
          parameters: {
            ...definition.parameters,
            title: { type: 'string', default: '升级后的标题' },
            value: { type: 'number', default: 76, min: 0, max: 100 },
          },
        },
        nodes,
      },
      upgrades: [
        { sceneId: 'intro', nodeId: 'updated' },
        { sceneId: 'intro', nodeId: 'custom' },
      ],
    });
    await app.service.transact([
      {
        type: 'addNode',
        sceneId: 'intro',
        node: newNode({
          id: 'caption-old',
          type: 'text',
          text: '01  保留 V' + first,
          x: 56,
          y: 218,
          width: 360,
          height: 32,
          fontSize: 22,
          fontWeight: 600,
          fill: '#cfe1ee',
        }),
      },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: newNode({
          id: 'caption-new',
          type: 'text',
          text: '02  采用 V' + (first + 1) + ' 默认值',
          x: 460,
          y: 218,
          width: 360,
          height: 32,
          fontSize: 22,
          fontWeight: 600,
          fill: '#cfe1ee',
        }),
      },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: newNode({
          id: 'caption-custom',
          type: 'text',
          text: '03  升级并保留自定义',
          x: 864,
          y: 218,
          width: 360,
          height: 32,
          fontSize: 22,
          fontWeight: 600,
          fill: '#cfe1ee',
        }),
      },
    ]);
    const guide = await readFile(path.join(root, 'AGENTS.md'), 'utf8');
    const start = '<!-- vmotion-design-demo:start -->',
      end = '<!-- vmotion-design-demo:end -->',
      section = `${start}\n## Design demo\n\nPublished V${first}: ${field(one, 'published')}. V${first + 1}: ${field(two, 'published')}. Brand: ${theme}. Source components/card.ts remains editable; published copies are pinned. Use theme_inspect/template_inspect for details and theme_plan/template_plan for exact candidates. --render-only preserves edits; published demo versions are immutable.\n${end}`,
      before = guide.includes(start)
        ? guide.replace(new RegExp(start + '[\\s\\S]*?' + end), section)
        : guide.replace(/\n## Design demo\n\n[^\n]*\n/g, '') + '\n' + section + '\n';
    await writeFile(path.join(root, 'AGENTS.md'), before);
  }
  await mkdir(path.join(root, 'exports'), { recursive: true });
  for (const frame of [0, 36, 90, 140, 179])
    await writeFile(
      path.join(root, `exports/frame-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 36, 90, 140, 179],
    width: 640,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  const cached = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 90, 179],
      width: 1280,
      repeat: 3,
    }),
    baseline = await app.dispatch('renderProfile', {
      sceneId: 'intro',
      frames: [0, 90, 179],
      width: 1280,
      repeat: 3,
      resourceCache: false,
    });
  await writeFile(
    path.join(root, 'exports/performance.json'),
    JSON.stringify({ cached, baseline }, null, 2),
  );
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
      format: 'mp4',
      encoder: 'libx264',
      output: path.join(root, 'exports/themes-templates.mp4'),
    });
    const done = await app.renders.wait(job.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done));
    console.log(JSON.stringify(done));
  }
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      audit: audit.summary,
      cached: cached.summary.warmMeanMs,
      baseline: baseline.summary.warmMeanMs,
    }),
  );
} finally {
  await app.close();
}
