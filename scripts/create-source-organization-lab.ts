import path from 'node:path';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode, sceneSchema } from '../src/core/model.js';
const root = path.resolve('examples/source-organization-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits; explicit --rebuild rewrites example');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '工程引用与选择换源', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    const cards = [
        { id: 'a', x: 64, name: '保留原版' },
        { id: 'b', x: 456, name: '选择换源' },
        { id: 'c', x: 848, name: '镜头复用' },
      ],
      nodes = cards.flatMap((c, i) => [
        newNode({
          id: c.id + '-panel',
          type: 'rect',
          x: c.x,
          y: 240,
          width: 368,
          height: 355,
          radius: 18,
          fill: '#152136',
          stroke: '#2b3e59',
          strokeWidth: 1,
        }),
        newNode({
          id: c.id + '-index',
          type: 'text',
          text: '0' + (i + 1),
          x: c.x + 22,
          y: 260,
          width: 60,
          height: 22,
          fontSize: 14,
          fill: '#8fabd8',
        }),
        newNode({
          id: c.id,
          type: 'scene',
          sceneId: 'original',
          x: c.x + 9,
          y: 300,
          width: 350,
          height: 270,
          overrides: {
            'graphic/content/title': { text: c.name },
            graphic: { params: { value: 60 + i * 16, accent: '#86bafd', secondary: '#274b7c' } },
          },
        }),
      ]);
    nodes.unshift(
      newNode({
        id: 'brand',
        type: 'text',
        text: 'VMOTION / SOURCE ORGANIZATION',
        x: 64,
        y: 34,
        width: 1000,
        height: 24,
        fontSize: 15,
        fill: '#7fb7f1',
      }),
      newNode({
        id: 'title',
        type: 'text',
        text: '一处素材，多个用途',
        x: 60,
        y: 76,
        width: 1110,
        height: 74,
        fontSize: 50,
        fontWeight: 700,
        fill: '#edf4ff',
      }),
      newNode({
        id: 'subtitle',
        type: 'text',
        text: '先检查引用，再选择换源；每个对象继续保持可编辑',
        x: 64,
        y: 160,
        width: 1080,
        height: 30,
        fontSize: 21,
        fill: '#8ca3bf',
      }),
    );
    nodes.push(
      newNode({ id: 'rule', type: 'rect', x: 64, y: 630, width: 1152, height: 1, fill: '#2a3e5a' }),
      newNode({
        id: 'footer',
        type: 'text',
        text: '文件引用图 → 选定用途 → 准确候选 → 画面验证 → 一次撤销',
        x: 64,
        y: 655,
        width: 1100,
        height: 27,
        fontSize: 17,
        fill: '#839cb8',
      }),
    );
    const source = await readFile('scripts/source-organization-lab-component.ts', 'utf8'),
      operations: any[] = [{ type: 'writeSource', path: 'components/card.ts', content: source }];
    for (const id of ['original', 'replacement']) {
      const scene = sceneSchema.parse({
        id,
        name: id === 'original' ? '原始蓝色版本' : '新紫色版本',
        width: 350,
        height: 270,
        duration: 180,
        background: 'transparent',
        nodes: [
          newNode({
            id: 'graphic',
            type: 'component',
            component: 'components/card.ts',
            width: 350,
            height: 270,
            params: {
              accent: id === 'original' ? '#86bafd' : '#b9a0ff',
              secondary: id === 'original' ? '#274b7c' : '#5e3a91',
              value: 72,
            },
          }),
        ],
      });
      if (app.service.snapshot.scenes.some((s) => s.id === id))
        operations.push({ type: 'updateScene', sceneId: id, patch: scene });
      else operations.push({ type: 'addScene', scene });
    }
    // Per-instance labels stay customized; parameter colors follow the selected source.
    for (const node of nodes)
      if (node.type === 'scene') {
        delete node.overrides.graphic;
        node.overrides['graphic/content/value'] = {
          text: (node.id === 'a' ? 60 : node.id === 'b' ? 76 : 92) + '%',
        };
      }
    operations.push({
      type: 'updateScene',
      sceneId: 'intro',
      patch: { background: '#0d182a', nodes },
    });
    await app.service.transact(operations);
    const uses = await app.dispatch('projectReferences', {
        entity: { kind: 'scene', id: 'original' },
        detail: true,
      }),
      selected = uses.items.filter(
        (r: any) => r.sceneId === 'intro' && ['b', 'c'].includes(r.nodeId),
      );
    const plan = await app.dispatch('referencePlan', {
      revision: app.service.snapshot.revision,
      items: [
        {
          from: { kind: 'scene', id: 'original' },
          to: { kind: 'scene', id: 'replacement' },
          referenceIds: selected.map((r: any) => r.id),
          expectedUses: 2,
        },
      ],
    });
    const checked = await app.dispatch('projectPreflight', plan.candidate);
    if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
    await app.dispatch('projectApply', plan.apply);
  }
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 24, 55, 90, 149, 179].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/source-organization-lab.mp4'),
    }),
    result = await app.renders.wait(job.id);
  if (result.status !== 'completed') throw new Error(JSON.stringify(result.error));
  console.log(
    JSON.stringify({
      root,
      revision: result.revision,
      output: result.output,
      frames: result.totalFrames,
      contact: checked.output,
    }),
  );
} finally {
  await app.close();
}
