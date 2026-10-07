import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { programLayer } from '../src/sdk/render-programs.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/program-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root))
  throw Error('Close the example service before rebuilding or exporting');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw Error('Use --render-only to preserve edits or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '自由编程视觉', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 2,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly)
    await app.service.transact([
      {
        type: 'writeSource',
        path: 'components/renderers/waves.py',
        content: await readFile('scripts/fixtures/program-wave.py', 'utf8'),
      },
      {
        type: 'writeSource',
        path: 'components/renderers/raymarch.wgsl',
        content: await readFile('scripts/fixtures/program-raymarch.wgsl', 'utf8'),
      },
      ...(['python', 'wgsl'] as const).map((backend) => ({
        type: 'writeSource' as const,
        path: `components/renderers/${backend}.json`,
        content: JSON.stringify(
          {
            kind: 'render-program',
            version: 1,
            name: backend === 'python' ? 'Wave interference' : 'SDF raymarch',
            backend,
            entry: `components/renderers/${backend === 'python' ? 'waves.py' : 'raymarch.wgsl'}`,
            parameters: { speed: { type: 'number', default: 1, min: 0.1, max: 3 } },
            uniforms: backend === 'wgsl' ? ['speed'] : [],
          },
          null,
          2,
        ),
      })),
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          background: '#0a1423',
          nodes: [
            newNode({
              id: 'title',
              type: 'text',
              text: '自由编程 · 无限视觉',
              x: 64,
              y: 45,
              width: 1150,
              height: 68,
              fontSize: 48,
              fontWeight: 700,
              fill: '#e8f2ff',
            }),
            newNode({
              id: 'subtitle',
              type: 'text',
              text: '自定义算法直接进入画面，在同一工程中动画、合成与导出',
              x: 66,
              y: 121,
              width: 1120,
              height: 44,
              fontSize: 23,
              fill: '#8faabe',
            }),
            programLayer('waves', 'components/renderers/python.json', {
              x: 64,
              y: 200,
              width: 548,
              height: 380,
            }),
            programLayer('world', 'components/renderers/wgsl.json', {
              x: 668,
              y: 200,
              width: 548,
              height: 380,
            }),
            newNode({
              id: 'python-label',
              type: 'text',
              text: 'PYTHON  /  波形干涉',
              x: 65,
              y: 606,
              width: 550,
              height: 38,
              fontSize: 24,
              fill: '#82d8ce',
            }),
            newNode({
              id: 'shader-label',
              type: 'text',
              text: 'WGSL  /  三维光线步进',
              x: 669,
              y: 606,
              width: 550,
              height: 38,
              fontSize: 24,
              fill: '#8fbbef',
            }),
            newNode({
              id: 'footer',
              type: 'text',
              text: '每一帧来自你的代码 · 稳定时钟 · 可编辑参数',
              x: 65,
              y: 661,
              width: 1140,
              height: 30,
              fontSize: 18,
              fill: '#71899c',
            }),
          ],
        },
      },
    ]);
  const revision = app.service.snapshot.revision,
    checked = await app.dispatch('projectPreflight', {
      revision,
      samples: [
        { sceneId: 'intro', frame: 0 },
        { sceneId: 'intro', frame: 30 },
        { sceneId: 'intro', frame: 59 },
      ],
      width: 640,
      determinism: true,
      output: path.join(root, 'exports/contact.png'),
    });
  if (!checked.valid) throw Error(JSON.stringify(checked.diagnostics));
  const frame = await app.frame({ frame: 30, width: 1280, height: 720, sceneId: 'intro' });
  const { atomicWrite } = await import('../src/platform/project-files.js');
  await atomicWrite(path.join(root, 'exports/preview.png'), frame.buffer);
  const job = await app.dispatch('render', {
    revision,
    gpu: 'gpu',
    output: path.join(root, 'exports/program-lab.mp4'),
  });
  const done = await app.renders.wait(job.id);
  if (done.status !== 'completed') throw Error(JSON.stringify(done.error));
  console.log(
    JSON.stringify({
      root,
      revision,
      output: done.output,
      frames: done.totalFrames,
      preview: path.join(root, 'exports/preview.png'),
      programs: app.renderer.programs.report(),
    }),
  );
} finally {
  await app.close();
}
