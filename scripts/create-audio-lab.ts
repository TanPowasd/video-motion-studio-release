import path from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { newNode } from '../src/core/model.js';
import { initProject } from '../src/service/template.js';
import { Application } from '../src/service/application.js';
import { ffmpegBinary, runProcess } from '../src/media/ffmpeg.js';
const root = path.resolve('examples/audio-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '声音与画面同步实验');
const app = await new Application(root).open(false);
try {
  const file = path.join(root, 'assets', 'beat.wav');
  await mkdir(path.dirname(file), { recursive: true });
  await runProcess(ffmpegBinary(), [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'aevalsrc=0.18*sin(2*PI*220*t)+0.2*sin(2*PI*660*t)*exp(-18*mod(t\\,0.5)):s=48000:d=12',
    '-c:a',
    'pcm_s16le',
    file,
  ]);
  await app.dispatch('import', { path: file, type: 'audio' });
  const asset = app.service.snapshot.project.assets[0];
  await app.service.transact([
    { type: 'updateProject', patch: { width: 1280, height: 720 } },
    {
      type: 'updateScene',
      sceneId: 'intro',
      patch: {
        name: '声音与画面同步',
        duration: 360,
        nodes: [
          newNode({
            id: 'label',
            type: 'text',
            name: 'Label',
            x: 72,
            y: 42,
            width: 1100,
            height: 40,
            fontSize: 18,
            fill: '#849bbb',
            text: 'VMOTION / AUDIO PREVIEW',
          }),
          newNode({
            id: 'title',
            type: 'text',
            name: 'Title',
            x: 72,
            y: 105,
            width: 1100,
            height: 100,
            fontSize: 50,
            fill: '#e0ecff',
            text: '先听见节奏，再设计动画',
          }),
          newNode({
            id: 'pulse',
            type: 'component',
            name: '同步节奏',
            component: 'components/pulse.ts',
            width: 1280,
            height: 720,
          }),
        ],
      },
    },
    {
      type: 'writeSource',
      path: 'components/pulse.ts',
      content:
        "import {defineComponent,ellipse,text,rect} from '@vmotion/sdk';export default defineComponent({name:'Pulse',parameters:{},render(ctx){const phase=(ctx.seconds%0.5)/0.5,p=Math.exp(-phase*9),r=70+p*40;return [ellipse('pulse',{x:640-r,y:395-r,width:2*r,height:2*r,fill:'#79b6ff',opacity:0.45+p*0.5}),rect('time',{x:130,y:595,width:1020*(ctx.seconds/12),height:8,fill:'#c2d9fa'}),text('timecode',ctx.seconds.toFixed(2)+' 秒',{x:72,y:650,width:1100,height:40,fontSize:22,fill:'#8da8ca'})];}});",
    },
    {
      type: 'updateSequence',
      sequenceId: 'main',
      patch: {
        duration: 360,
        tracks: [
          {
            id: 'visual',
            type: 'video',
            name: '节奏画面',
            muted: false,
            clips: [
              {
                id: 'scene',
                sceneId: 'intro',
                start: 0,
                duration: 360,
                sourceIn: 0,
                speed: 1,
                volume: 1,
                fadeIn: 0,
                fadeOut: 0,
              },
            ],
          },
          {
            id: 'voice',
            type: 'audio',
            name: '节奏音轨',
            muted: false,
            clips: [
              {
                id: 'sound',
                assetId: asset.id,
                start: 0,
                duration: 360,
                sourceIn: 0,
                speed: 1,
                volume: 0.8,
                fadeIn: 15,
                fadeOut: 30,
              },
            ],
          },
        ],
      },
    },
  ]);
  const sample = await app.dispatch('audioPreview', {
    sequenceId: 'main',
    startSample: 48000 * 2,
    sampleCount: 48000 * 4,
    output: path.join(root, 'exports/audio-preview.wav'),
  });
  console.log(
    JSON.stringify(
      {
        root,
        preview: {
          output: sample.output,
          rms: sample.metrics.rms,
          peak: sample.metrics.peak,
          duration: sample.duration,
        },
      },
      null,
      2,
    ),
  );
} finally {
  await app.close();
}
