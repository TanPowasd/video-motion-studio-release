import { field } from '../tests/result-assertions.js';
import { existsSync } from 'node:fs';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { createCanvas } from '@napi-rs/canvas';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { Application } from '../src/service/application.js';
import { newNode } from '../src/core/model.js';
const root = path.resolve('examples/tracking-lab'),
  renderOnly = process.argv.includes('--render-only'),
  frames = 180,
  seeds = [
    { id: 'tl', x: 145, y: 105 },
    { id: 'tr', x: 475, y: 105 },
    { id: 'br', x: 475, y: 265 },
    { id: 'bl', x: 145, y: 265 },
  ];
if (await existingService(root)) throw new Error('Close the example before authoring');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve edits or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '运动跟踪与视频稳定', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 6,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    const inputs = path.join(root, '.vmotion/demo-input'),
      sourceFile = path.join(root, 'assets/tracking-source.mkv');
    await mkdir(inputs, { recursive: true });
    await mkdir(path.dirname(sourceFile), { recursive: true });
    for (let frame = 0; frame < frames; frame++) {
      const c = createCanvas(640, 360),
        g = c.getContext('2d');
      g.fillStyle = '#091522';
      g.fillRect(0, 0, 640, 360);
      const dx = 10 * Math.sin(frame * 0.45) + 18 * Math.sin(frame * 0.06),
        dy = 6 * Math.sin(frame * 0.3),
        angle = ((3 * Math.sin(frame * 0.08) + 1.5 * Math.sin(frame * 0.7)) * Math.PI) / 180;
      g.translate(320 + dx, 180 + dy);
      g.rotate(angle);
      g.translate(-320, -180);
      g.strokeStyle = '#213b51';
      g.lineWidth = 1;
      for (let x = 0; x <= 640; x += 32) {
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, 360);
        g.stroke();
      }
      for (let y = 0; y <= 360; y += 32) {
        g.beginPath();
        g.moveTo(0, y);
        g.lineTo(640, y);
        g.stroke();
      }
      g.fillStyle = '#183449';
      g.beginPath();
      g.roundRect(130, 90, 360, 190, 14);
      g.fill();
      g.strokeStyle = '#5499b2';
      g.lineWidth = 2;
      g.stroke();
      g.fillStyle = '#d9edf7';
      g.font = '600 31px "Microsoft YaHei"';
      g.fillText('VMOTION / SHOT 001', 166, 165);
      g.font = '20px "Microsoft YaHei"';
      g.fillStyle = '#82c8cb';
      g.fillText('本地素材 · 轨迹可编辑', 200, 211);
      for (const [pIndex, p] of seeds.entries())
        for (let y = -2; y <= 2; y++)
          for (let x = -2; x <= 2; x++) {
            g.fillStyle =
              ((Math.imul(x + 7, 73856093) ^
                Math.imul(y + 11, 19349663) ^
                Math.imul(pIndex + 1, 83492791)) >>>
                0) %
                3 ===
              0
                ? '#faf5d1'
                : '#285964';
            g.fillRect(p.x + x * 4 - 2, p.y + y * 4 - 2, 4, 4);
          }
      await writeFile(
        path.join(inputs, `${String(frame).padStart(3, '0')}.png`),
        await c.encode('png'),
      );
      c.width = 1;
    }
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-framerate',
        '30',
        '-i',
        path.join(inputs, '%03d.png'),
        '-c:v',
        'ffv1',
        '-level',
        '3',
        '-pix_fmt',
        'bgra',
        sourceFile,
      ],
      { windowsHide: true },
    );
    if (!app.service.snapshot.project.assets.some((a) => a.id === 'tracking-footage'))
      await app.service.transact([
        {
          type: 'addAsset',
          asset: {
            id: 'tracking-footage',
            name: '运动素材',
            path: 'assets/tracking-source.mkv',
            type: 'video',
            managed: true,
            metadata: { width: 640, height: 360, duration: 6 },
            fingerprint: undefined,
          },
        },
      ]);
    await app.service.transact([
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: frames,
          background: '#0a111d',
          nodes: [
            newNode({
              id: 'heading',
              type: 'text',
              text: '让画面运动，成为可编辑的数据。',
              x: 52,
              y: 40,
              width: 1176,
              height: 68,
              fontSize: 42,
              fontWeight: 700,
              fill: '#eef6ff',
            }),
            newNode({
              id: 'subtitle',
              type: 'text',
              text: '点跟踪 / 变换贴附 / 四点贴图 / 稳定 · 外部 Agent 使用同一候选',
              x: 54,
              y: 122,
              width: 1170,
              height: 34,
              fontSize: 22,
              fill: '#90afca',
            }),
            newNode({
              id: 'raw-title',
              type: 'text',
              text: '01  原始运动 + 跟踪贴附',
              x: 54,
              y: 214,
              width: 560,
              height: 34,
              fontSize: 24,
              fontWeight: 600,
              fill: '#cce3ed',
            }),
            newNode({
              id: 'stable-title',
              type: 'text',
              text: '02  锁定稳定 · 明确裁边',
              x: 664,
              y: 214,
              width: 560,
              height: 34,
              fontSize: 24,
              fontWeight: 600,
              fill: '#cce3ed',
            }),
            newNode({
              id: 'raw-video',
              type: 'video',
              assetId: 'tracking-footage',
              x: 54,
              y: 276,
              width: 560,
              height: 315,
            }),
            newNode({
              id: 'stable-video',
              type: 'video',
              assetId: 'tracking-footage',
              x: 664,
              y: 276,
              width: 560,
              height: 315,
            }),
            newNode({
              id: 'attached',
              type: 'text',
              text: 'TRACKED / 稳定 ID',
              x: 54 + 145 * 0.875 + 12,
              y: 276 + 105 * 0.875 - 30,
              width: 280,
              height: 34,
              fontSize: 19,
              fontWeight: 600,
              fill: '#ffd684',
            }),
            newNode({
              id: 'footer',
              type: 'text',
              text: '原始像素取证 · 失跟明确报告 · 独立 worker · 普通矩阵关键帧 · 代码与素材保留',
              x: 54,
              y: 654,
              width: 1170,
              height: 36,
              fontSize: 20,
              fill: '#819cb9',
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: frames,
          tracks: [
            {
              id: 'video',
              name: '跟踪对照',
              type: 'video',
              muted: false,
              clips: [
                {
                  id: 'intro',
                  sceneId: 'intro',
                  start: 0,
                  duration: frames,
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
    const job = await app.dispatch('trackingAnalyze', {
      wait: true,
      request: {
        assetId: 'tracking-footage',
        end: frames,
        width: 640,
        settings: { levels: 3, radius: 7 },
        points: seeds.map((p) => ({ id: p.id, seeds: [{ frame: 0, x: p.x, y: p.y }] })),
      },
    });
    if (field(job, 'status') !== 'completed') throw new Error(JSON.stringify(job));
    const info = await app.dispatch('trackingInspect', {
      analysisId: field(job, 'analysisId'),
      detail: true,
    });
    console.log(JSON.stringify(info.points));
    const plan = await app.dispatch('trackingPlan', {
      analysisId: field(job, 'analysisId'),
      revision: app.service.snapshot.revision,
      bindings: [
        {
          sceneId: 'intro',
          sourceNodeId: 'raw-video',
          targetNodeId: 'attached',
          mode: 'transform',
          model: 'similarity',
          pointIds: seeds.map((p) => p.id),
          endFrame: frames,
        },
        {
          sceneId: 'intro',
          sourceNodeId: 'stable-video',
          targetNodeId: 'stable-video',
          mode: 'stabilize',
          model: 'similarity',
          pointIds: seeds.map((p) => p.id),
          endFrame: frames,
          zoom: 1.04,
        },
      ],
    });
    const checked = await app.dispatch('projectPreflight', plan.candidate);
    if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
    await app.dispatch('projectApply', plan.apply);
    const guide = path.join(root, 'AGENTS.md'),
      prior = await readFile(guide, 'utf8'),
      begin = '<!-- vmotion-tracking-example:start -->',
      end = '<!-- vmotion-tracking-example:end -->',
      block = `${begin}\n## Tracking demo\n\nCurrent editable resource: ${plan.resource.file}. Source: assets/tracking-source.mkv. Read tracking_inspect for gaps/quality and tracking_evidence for original pixels; tracking_plan preserves code and creates exact candidate/undo. Repeated baking combines current matrices: undo it before updating the same binding.\n\nUse scripts/create-tracking-lab.ts --render-only to preserve edits; reauthoring requires --rebuild.\n${end}`,
      start = prior.indexOf(begin),
      finish = prior.indexOf(end);
    await writeFile(
      guide,
      start >= 0 && finish >= start
        ? prior.slice(0, start) + block + prior.slice(finish + end.length)
        : prior + '\n' + block + '\n',
    );
    await mkdir(path.join(root, 'exports'), { recursive: true });
    await app.dispatch('trackingEvidence', {
      analysisId: field(job, 'analysisId'),
      frames: [0, 36, 90, 140, 179],
      width: 320,
      output: path.join(root, 'exports/tracking-evidence.png'),
    });
    await writeFile(path.join(root, 'exports/analysis.json'), JSON.stringify(job, null, 2));
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
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
      format: 'mp4',
      encoder: 'libx264',
      output: path.join(root, 'exports/tracking-stabilization.mp4'),
    });
    const done = await app.renders.wait(job.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done));
    console.log(JSON.stringify(done));
  }
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      diagnostics: app.service.diagnostics,
      audit: audit.summary,
    }),
  );
} finally {
  await app.close();
}
