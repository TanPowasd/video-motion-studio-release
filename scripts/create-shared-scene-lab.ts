import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode, sceneSchema } from '../src/core/model.js';
const root = path.resolve('examples/shared-scene-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '共享场景与实例覆盖');
const app = await new Application(root).open(false);
try {
  const source = sceneSchema.parse({
    id: 'card',
    name: '共享信息卡',
    width: 600,
    height: 520,
    duration: 240,
    background: 'transparent',
    nodes: [
      newNode({
        id: 'panel',
        type: 'rect',
        name: '卡片底板',
        width: 600,
        height: 520,
        radius: 22,
        fill: '#152438',
        stroke: '#2d4761',
        strokeWidth: 2,
      }),
      newNode({
        id: 'heading',
        type: 'text',
        name: '卡片标题',
        x: 36,
        y: 30,
        width: 528,
        height: 54,
        fontSize: 34,
        fontWeight: 600,
        text: '共同的动画逻辑',
        fill: '#e9f7ff',
      }),
      newNode({
        id: 'ring',
        type: 'ellipse',
        name: '路径书写圆环',
        x: 176,
        y: 132,
        width: 248,
        height: 248,
        fill: 'transparent',
        stroke: '#75e6d3',
        strokeWidth: 12,
        strokeCap: 'round',
        pathTrim: { start: 0, end: 0.72, offset: 0 },
        animations: [
          {
            property: 'pathTrim.offset',
            keys: [
              { frame: 0, value: 0, easing: 'linear' },
              { frame: 240, value: 2, easing: 'linear' },
            ],
          },
        ],
      }),
      newNode({
        id: 'count',
        type: 'text',
        name: '数据文字',
        x: 185,
        y: 218,
        width: 230,
        height: 75,
        fontSize: 52,
        fontWeight: 700,
        align: 'center',
        text: '01',
        fill: '#75e6d3',
      }),
      newNode({
        id: 'footer',
        type: 'text',
        name: '卡片说明',
        x: 36,
        y: 434,
        width: 528,
        height: 50,
        fontSize: 26,
        align: 'center',
        text: '来源更新同步 · 实例覆盖保留',
        fill: '#9ebbd2',
      }),
    ],
  });
  const existing = app.service.snapshot.scenes.find((s) => s.id === 'card');
  await app.service.transact([
    { type: 'updateProject', patch: { width: 1920, height: 1080 } },
    existing
      ? { type: 'updateScene', sceneId: 'card', patch: source }
      : { type: 'addScene', scene: source },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '共享场景实验室',
        width: 1920,
        height: 1080,
        duration: 240,
        background: '#0a121f',
        nodes: [
          newNode({
            id: 'label',
            type: 'text',
            x: 72,
            y: 46,
            width: 1776,
            height: 38,
            fontSize: 22,
            text: 'VMOTION / SHARED COMPOSITIONS',
            fill: '#839bb7',
          }),
          newNode({
            id: 'title',
            type: 'text',
            x: 72,
            y: 105,
            width: 1776,
            height: 90,
            fontSize: 62,
            fontWeight: 700,
            text: '同一个场景，不同的表达',
            fill: '#f2f7ff',
          }),
          newNode({
            id: 'subtitle',
            type: 'text',
            x: 76,
            y: 200,
            width: 1740,
            height: 48,
            fontSize: 28,
            text: '共享 JSON 场景 · 独立属性覆盖 · 同步动画 · 稳定 ID',
            fill: '#9eb6d2',
          }),
          ...['one', 'two', 'three'].flatMap((id, i) => [
            newNode({
              id: `tag-${id}`,
              type: 'text',
              x: 72 + i * 604,
              y: 300,
              width: 568,
              height: 48,
              fontSize: 25,
              text: ['SOURCE / 共享基准', 'INSTANCE / 文字与颜色', 'INSTANCE / 结构与效果'][i],
              fill: ['#75e6d3', '#b7a5ff', '#ffb68a'][i],
            }),
            newNode({
              id,
              type: 'scene',
              name: ['基准实例', '紫色实例', '暖色实例'][i],
              sceneId: 'card',
              x: 72 + i * 604,
              y: 370,
              width: 568,
              height: 492,
            }),
          ]),
          newNode({
            id: 'description',
            type: 'text',
            x: 76,
            y: 919,
            width: 1768,
            height: 64,
            fontSize: 31,
            text: '更新源场景时，三个圆环同步运动；实例文字、颜色和效果独立保留。',
            fill: '#b7cce2',
          }),
          newNode({
            id: 'footer',
            type: 'text',
            x: 76,
            y: 1022,
            width: 1768,
            height: 34,
            fontSize: 20,
            text: '可进入实例编辑 · 原子预合成 · CLI / MCP 查询依赖与获取帧',
            fill: '#718ba9',
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
            name: '共享场景',
            type: 'video',
            muted: false,
            clips: [
              {
                id: 'intro',
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
  await app.dispatch('compositionTransactBatch', {
    sceneId: 'intro',
    frame: 0,
    edits: [
      { path: ['two'], nodeId: 'two/heading', patch: { text: '只修改当前实例' } },
      { path: ['two'], nodeId: 'two/ring', patch: { stroke: '#b7a5ff' } },
      { path: ['two'], nodeId: 'two/count', patch: { text: '02', fill: '#b7a5ff' } },
      {
        path: ['three'],
        nodeId: 'three/ring',
        patch: {
          stroke: '#ffb68a',
          effects: [{ type: 'glow', color: '#ffb68a', radius: 10, intensity: 0.4 }],
        },
      },
      { path: ['three'], nodeId: 'three/count', patch: { text: '03', fill: '#ffb68a' } },
      { path: ['three'], nodeId: 'three/footer', patch: { text: '原始圆环 · 本实例新增亮点' } },
    ],
  });
  await app.dispatch('compositionStructure', {
    sceneId: 'intro',
    path: ['three'],
    action: {
      type: 'add',
      node: newNode({
        id: 'dot',
        name: '实例新增亮点',
        type: 'ellipse',
        x: 434,
        y: 107,
        width: 15,
        height: 15,
        fill: '#ffcd9c',
      }),
    },
  });
  await mkdir(path.join(root, 'exports'), { recursive: true });
  for (const frame of [0, 36, 90, 180, 239])
    await writeFile(
      path.join(root, `exports/shared-${frame}.png`),
      (await app.frame({ frame })).buffer,
    );
  const audit = await app.dispatch('visualAudit', {
    sceneId: 'intro',
    frames: [0, 36, 90, 180, 239],
    width: 640,
    output: path.join(root, 'exports/contact-sheet.png'),
  });
  console.log(
    JSON.stringify(
      {
        root,
        revision: app.service.snapshot.revision,
        audit: audit.summary,
        references: (await app.dispatch('sceneReferences', { sourceId: 'card' })).incoming,
      },
      null,
      2,
    ),
  );
  if (process.argv.includes('--render')) {
    const job = app.renders.start(app.service.snapshot, {
        output: path.join(root, 'exports/shared-compositions-1080p.mp4'),
        format: 'mp4',
        encoder: 'libx264',
      }),
      done = await app.renders.wait(job.id);
    console.log(JSON.stringify(done));
    if (done.status !== 'completed') process.exitCode = 1;
  }
} finally {
  await app.close();
}
