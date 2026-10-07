import path from 'node:path';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { newNode, sceneSchema, type Snapshot } from '../src/core/model.js';
import { runProcess, ffmpegBinary } from '../src/media/ffmpeg.js';
const root = path.resolve('examples/editing-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '电影剪辑与二创实验室');
const app = await new Application(root).open(false);
try {
  await mkdir(path.join(root, 'assets'), { recursive: true });
  await mkdir(path.join(root, 'exports'), { recursive: true });
  const scenes = ['wide', 'street', 'detail'].map((id) =>
    sceneSchema.parse({
      id: `source-${id}`,
      name: `原始镜头 ${id}`,
      duration: 90,
      background: '#071522',
      nodes: [
        newNode({
          id: 'city',
          type: 'component',
          component: 'components/city.ts',
          width: 1280,
          height: 720,
          params: { shot: id },
        }),
      ],
    }),
  );
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/city.ts',
      content: await readFile('scripts/editing-lab-component.ts', 'utf8'),
    },
    { type: 'updateProject', patch: { width: 1280, height: 720 } },
    ...scenes.map((scene) =>
      app.service.snapshot.scenes.some((s) => s.id === scene.id)
        ? { type: 'updateScene' as const, sceneId: scene.id, patch: scene }
        : { type: 'addScene' as const, scene },
    ),
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        name: '原始镜头导出',
        duration: 270,
        tracks: [
          {
            id: 'v',
            name: '原始镜头',
            type: 'video',
            muted: false,
            clips: scenes.map((scene, i) => ({
              id: `source-${i}`,
              sceneId: scene.id,
              start: i * 90,
              duration: 90,
              sourceIn: 0,
              speed: 1,
              volume: 1,
              fadeIn: 0,
              fadeOut: 0,
            })),
          },
        ],
      },
    },
  ]);
  const footage = path.join(root, 'assets/city-source.mp4');
  if (!existsSync(footage)) {
    const job = app.renders.start(app.service.snapshot, {
      output: footage,
      format: 'mp4',
      encoder: 'libx264',
    });
    const done = await app.renders.wait(job.id);
    if (done.status !== 'completed') throw new Error(JSON.stringify(done));
  }
  await app.dispatch('import', { path: footage, type: 'video' });
  const asset = app.service.snapshot.project.assets.filter((a) => a.type === 'video').at(-1)!;
  const audio = path.join(root, 'assets/bed.wav');
  if (!existsSync(audio))
    await runProcess(ffmpegBinary(), [
      '-y',
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      "aevalsrc=exprs='0.07*sin(2*PI*130.8128*t)+0.04*sin(2*PI*195.9977*t)+0.028*sin(2*PI*261.6256*t)*exp(-6*mod(t,0.5))':s=48000:d=9",
      '-c:a',
      'pcm_s16le',
      audio,
    ]);
  await app.dispatch('import', { path: audio, type: 'audio' });
  const music = app.service.snapshot.project.assets.filter((a) => a.type === 'audio').at(-1)!;
  await app.service.transact([
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        name: 'Night City · 电影剪辑',
        duration: 270,
        workflow: 'film',
        markers: [
          { id: 'wide', frame: 0, label: '远景', kind: 'chapter' },
          { id: 'street', frame: 90, label: '街道', kind: 'chapter' },
          { id: 'detail', frame: 180, label: '细节', kind: 'chapter' },
        ],
        tracks: [
          {
            id: 'picture',
            name: '画面 / 镜头',
            type: 'video',
            muted: false,
            clips: ['远景', '街道', '细节'].map((name, i) => ({
              id: `shot-${i}`,
              name,
              assetId: asset.id,
              start: i * 90,
              duration: 90,
              sourceIn: i * 90,
              speed: 1,
              volume: 1,
              fadeIn: i === 0 ? 12 : 0,
              fadeOut: i === 2 ? 18 : 0,
              audioEnabled: false,
            })),
          },
          {
            id: 'music',
            name: '音乐',
            type: 'audio',
            muted: false,
            clips: [
              {
                id: 'bed',
                name: '原创环境音乐',
                assetId: music.id,
                start: 0,
                duration: 270,
                sourceIn: 0,
                speed: 1,
                volume: 0.7,
                fadeIn: 20,
                fadeOut: 30,
              },
            ],
          },
        ],
      },
    },
  ]);
  const caption =
    '1\n00:00:00,400 --> 00:00:02,700\n镜头一：城市入夜\n\n2\n00:00:03,200 --> 00:00:05,700\n镜头二：街道中的运动\n\n3\n00:00:06,200 --> 00:00:08,400\n镜头三：细节建立情绪';
  await writeFile(path.join(root, 'assets/demo.zh.srt'), caption + '\n');
  if (!app.service.snapshot.sequences[0].tracks.some((t) => t.name === '中文字幕'))
    await app.dispatch('captionsImport', {
      content: caption,
      name: '中文字幕',
      fontSize: 34,
      bottom: 46,
    });
  console.log(
    JSON.stringify({
      root,
      revision: app.service.snapshot.revision,
      sourceFootage: footage,
      tracks: app.service.snapshot.sequences[0].tracks.length,
    }),
  );
  if (process.argv.includes('--render')) {
    const job = app.renders.start(app.service.snapshot, {
      output: path.join(root, 'exports/movie-workflow-demo.mp4'),
      format: 'mp4',
      encoder: 'libx264',
    });
    console.log(JSON.stringify(await app.renders.wait(job.id)));
  }
} finally {
  await app.close();
}
