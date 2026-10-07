import path from 'node:path';
import { existsSync } from 'node:fs';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { newNode, sceneSchema } from '../src/core/model.js';
const root = path.resolve('examples/storyboard-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits, or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '分镜与全片检查', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 8,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    const scenes = [
      ['intro', '分镜，让整支视频保持可编辑。', '#173853'],
      ['inspect', '检查来源对象，也检查最终画面。', '#232c4d'],
      ['output', '一个候选，从编排到检查与导出。', '#153c39'],
    ].map(([id, title, background], index) =>
      sceneSchema.parse({
        id,
        name: title,
        duration: 240,
        background,
        nodes: [
          newNode({
            id: `title-${id}`,
            type: 'text',
            text: title,
            x: 74,
            y: 58,
            width: 1120,
            height: 74,
            fontSize: 40,
            fontWeight: 700,
            fill: '#edf4ff',
          }),
          newNode({
            id: `sub-${id}`,
            type: 'text',
            text: [
              '稳定镜头 ID · 章节 · 来源 · 时长 · 关联素材',
              '按边界与全片时间分层采样，明确未检查范围',
              '场景与源码保留，后续可继续修改和重渲染',
            ][index],
            x: 76,
            y: 151,
            width: 1120,
            height: 42,
            fontSize: 23,
            fill: '#a0c0d8',
          }),
          ...Array.from({ length: 4 }, (_, i) =>
            newNode({
              id: `card-${i}`,
              type: 'rect',
              x: 76 + i * 278,
              y: 277,
              width: 250,
              height: 196,
              radius: 14,
              fill: ['#417697', '#517b94', '#457b8e', '#3c808d'][i],
              opacity: 0.8,
              animations: [
                {
                  property: 'y',
                  keys: [
                    { frame: 0, value: 310, easing: 'linear' },
                    { frame: 30 + i * 6, value: 277, easing: 'easeOut' },
                    { frame: 239, value: 277, easing: 'linear' },
                  ],
                },
              ],
            }),
          ),
          ...['编排', '预检', '检查', '导出'].map((text, i) =>
            newNode({
              id: `label-${i}`,
              type: 'text',
              text,
              x: 100 + i * 278,
              y: 354,
              width: 202,
              height: 52,
              fontSize: 32,
              fontWeight: 700,
              fill: '#f0f5fc',
            }),
          ),
          newNode({
            id: 'footer',
            type: 'text',
            text: 'VMOTION / 可编程工作站 · 外部 Agent 通过文件、CLI 和 MCP 创作',
            x: 76,
            y: 621,
            width: 1110,
            height: 37,
            fontSize: 19,
            fill: '#87a9c0',
          }),
        ],
      }),
    );
    const operations: any[] = [
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          tracks: app.service.snapshot.sequences[0].tracks.map((t) => ({
            ...t,
            clips: t.clips.filter((c) => c.id.startsWith('sb/')),
          })),
        },
      },
    ];
    for (const scene of scenes)
      operations.push(
        app.service.snapshot.scenes.some((s) => s.id === scene.id)
          ? { type: 'updateScene', sceneId: scene.id, patch: scene }
          : { type: 'addScene', scene },
      );
    const plan = await app.dispatch('storyboardPlan', {
      videoTrackId: 'visual',
      operations,
      document: {
        kind: 'storyboard',
        version: 1,
        id: 'workstation',
        name: '全片创作闭环',
        unit: 'seconds',
        chapters: [
          { id: 'build', name: '编排' },
          { id: 'review', name: '检查' },
          { id: 'deliver', name: '交付' },
        ],
        shots: [
          {
            id: 'start',
            name: '从稳定镜头开始',
            chapterId: 'build',
            source: { type: 'scene', id: 'intro' },
            duration: 2,
          },
          {
            id: 'compose',
            name: '继续组织整支视频',
            chapterId: 'build',
            source: { type: 'scene', id: 'intro' },
            sourceIn: 2,
            duration: 2,
          },
          {
            id: 'evidence',
            name: '检查最终画面',
            chapterId: 'review',
            source: { type: 'scene', id: 'inspect' },
            duration: 2,
          },
          {
            id: 'render',
            name: '导出与继续修改',
            chapterId: 'deliver',
            source: { type: 'scene', id: 'output' },
            duration: 2,
          },
        ],
      },
    });
    const checked = await app.dispatch('projectPreflight', plan.candidate);
    if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
    await app.dispatch('projectApply', plan.apply);
  }
  const audit = await app.dispatch('sequenceAudit', {
    maxFrames: 24,
    maxImages: 8,
    width: 320,
    output: path.join(root, 'exports/audit.png'),
  });
  if (audit.summary.errors) throw new Error(JSON.stringify(audit.findings));
  const job = await app.dispatch('render', {
      revision: app.service.snapshot.revision,
      output: path.join(root, 'exports/storyboard-lab.mp4'),
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
        audit: audit.output,
        coverage: audit.coverage,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
