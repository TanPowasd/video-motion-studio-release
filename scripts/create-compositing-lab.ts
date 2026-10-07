import { cp, readFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { atomicWrite, json } from '../src/service/project.js';
import { newNode, type Project, type Scene, type Sequence } from '../src/core/model.js';
import { ffmpegBinary, runProcess } from '../src/media/ffmpeg.js';
const root = path.resolve('examples/compositing-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, 'Vmotion 合成与声音实验台');
await cp('scripts/compositing-lab-component.ts', path.join(root, 'components/lab.ts'));
await mkdir(path.join(root, 'assets'), { recursive: true });
await runProcess(ffmpegBinary(), [
  '-y',
  '-v',
  'error',
  '-f',
  'lavfi',
  '-i',
  "aevalsrc='0.3*sin(2*PI*110*t)*pow(sin(PI*t),8)+0.2*sin(2*PI*1200*t)*pow(cos(PI*t),8)+0.15*sin(2*PI*6000*t)*pow(sin(PI*t/2),8)':s=48000:d=6",
  '-c:a',
  'pcm_s16le',
  path.join(root, 'assets/reactive.wav'),
]);
const project = JSON.parse(
  await readFile(path.join(root, 'project.vmotion.json'), 'utf8'),
) as Project;
project.width = 1280;
project.height = 720;
project.scenes = [];
project.assets = [
  {
    id: 'reactive-audio',
    name: '声音频段演示',
    path: 'assets/reactive.wav',
    type: 'audio',
    managed: true,
    metadata: {},
  },
];
const sequence: Sequence = {
  id: 'main',
  name: '抠像 · 调色 · 参数动画 · 音频驱动',
  duration: 720,
  markers: [],
  tracks: [
    { id: 'visual', name: '合成演示', type: 'video', muted: false, clips: [] },
    {
      id: 'sound',
      name: '频段声音',
      type: 'audio',
      muted: false,
      clips: [
        {
          id: 'audio-clip',
          assetId: 'reactive-audio',
          start: 540,
          duration: 180,
          sourceIn: 0,
          speed: 1,
          volume: 0.45,
          fadeIn: 8,
          fadeOut: 8,
        },
      ],
    },
  ],
};
for (const [index, [id, name]] of [
  ['key', '颜色抠像'],
  ['grade', '曲线与色彩'],
  ['warp', '效果参数关键帧'],
  ['audio', '声音驱动动画'],
].entries()) {
  const file = `scenes/${id}.json`,
    scene: Scene = {
      id,
      name,
      duration: 180,
      background: '#0b1628',
      nodes: [
        newNode({
          id: 'lab',
          type: 'component',
          name,
          component: 'components/lab.ts',
          width: 1280,
          height: 720,
          params: { mode: id },
          ...(id === 'audio' ? { audioAssetId: 'reactive-audio' } : {}),
        }),
      ],
    };
  project.scenes.push(file);
  await atomicWrite(path.join(root, file), json(scene));
  sequence.tracks[0].clips.push({
    id: `clip-${id}`,
    sceneId: id,
    start: index * 180,
    duration: 180,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  });
  sequence.markers.push({ id: `marker-${id}`, frame: index * 180, label: name });
}
await atomicWrite(path.join(root, 'project.vmotion.json'), json(project));
await atomicWrite(path.join(root, 'sequences/main.json'), json(sequence));
console.log(json({ project: root, seconds: 24 }));
