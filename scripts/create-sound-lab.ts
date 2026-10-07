import { present } from '../tests/result-assertions.js';
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { initProject } from '../src/service/template.js';
import { existingService } from '../src/service/ipc.js';
import { Application } from '../src/service/application.js';
import { soundPreset, compileSound } from '../src/core/sound.js';
import { newNode, assetSchema } from '../src/core/model.js';
import { pcmWave } from '../src/media/audio.js';
import { soundLabSource } from './sound-lab-source.js';
const root = path.resolve('examples/sound-lab'),
  renderOnly = process.argv.includes('--render-only');
if (await existingService(root)) throw new Error('Close the example before authoring/rendering');
if (
  !renderOnly &&
  existsSync(path.join(root, 'project.vmotion.json')) &&
  !process.argv.includes('--rebuild')
)
  throw new Error('Use --render-only to preserve existing edits, or explicit --rebuild');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, '音效与音乐制作', {
    template: 'blank',
    width: 1280,
    height: 720,
    durationSeconds: 14,
  });
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    await mkdir(path.join(root, 'assets'), { recursive: true });
    const count = 28800,
      pcm = Buffer.alloc(count * 8);
    for (let i = 0; i < count; i++) {
      const t = i / 48000,
        envelope = Math.min(1, t / 0.006) * Math.exp(-7 * t),
        v =
          0.18 *
          envelope *
          (Math.sin(2 * Math.PI * 523.251 * t) + 0.4 * Math.sin(2 * Math.PI * 1046.502 * t));
      pcm.writeFloatLE(v, i * 8);
      pcm.writeFloatLE(v, i * 8 + 4);
    }
    await writeFile(path.join(root, 'assets/chime.wav'), pcmWave(pcm));
    await app.service.transact([
      {
        type: 'updateProject',
        patch: {
          assets: [
            assetSchema.parse({
              id: 'chime-source',
              name: '原始铃声采样',
              type: 'audio',
              path: 'assets/chime.wav',
              managed: true,
              metadata: { duration: 0.6, sampleRate: 48000, channels: 2, hasAudio: true },
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: 420,
          tracks: app.service.snapshot.sequences[0].tracks.filter((t) => t.type === 'video'),
        },
      },
    ]);
    const notes = [
        60, 64, 67, 71, 62, 65, 69, 72, 64, 67, 71, 74, 65, 69, 72, 76, 67, 71, 74, 79, 64, 67, 72,
        76,
      ],
      raw = {
        kind: 'sound',
        version: 1,
        id: 'score',
        name: 'Luminous / 原创声音示例',
        unit: 'beats',
        duration: 24,
        tail: 2,
        tempo: [{ beat: 0, bpm: 120 }],
        tracks: [
          {
            id: 'pad',
            name: '和弦 · FM Pad',
            instrument: soundPreset('pad'),
            gainDb: -8,
            busId: 'music',
            sends: [{ busId: 'space', db: -14 }],
            events: [0, 4, 8, 12, 16, 20].flatMap((at, i) =>
              [
                [60, 64, 67],
                [62, 65, 69],
                [64, 67, 71],
                [65, 69, 72],
                [67, 71, 74],
                [60, 64, 67],
              ][i].map((note, j) => ({
                id: `chord-${i}-${j}`,
                at,
                duration: 3.5,
                note,
                velocity: 0.6,
              })),
            ),
          },
          {
            id: 'lead',
            name: '旋律 · Pluck',
            instrument: soundPreset('pluck'),
            gainDb: -3,
            busId: 'music',
            sends: [{ busId: 'space', db: -10 }],
            effects: [
              { type: 'delay', seconds: 0.25, rightSeconds: 0.375, mix: 0.2, feedback: 0.25 },
            ],
            events: notes.map((note, i) => ({
              id: `lead-${i}`,
              at: i,
              duration: 0.65,
              note,
              velocity: 0.6 + (i % 4) * 0.06,
            })),
          },
          {
            id: 'bass',
            name: '低音 · Subtractive',
            instrument: soundPreset('bass'),
            gainDb: -7,
            busId: 'music',
            effects: [{ type: 'filter', mode: 'lowpass', frequency: 850 }],
            events: [36, 38, 40, 41, 43, 36].flatMap((note, i) =>
              [0, 2].map((step, j) => ({
                id: `bass-${i}-${j}`,
                at: i * 4 + step,
                duration: 1.6,
                note,
                velocity: 0.7,
              })),
            ),
          },
          {
            id: 'kick',
            name: '鼓组 · Kick',
            instrument: soundPreset('kick'),
            gainDb: -3,
            busId: 'drums',
            events: Array.from({ length: 12 }, (_, i) => ({
              id: `kick-${i}`,
              at: i * 2,
              duration: 0.1,
              note: 33,
              velocity: 0.85,
            })),
          },
          {
            id: 'snare',
            name: '鼓组 · Snare + Hat',
            instrument: soundPreset('snare'),
            gainDb: -7,
            busId: 'drums',
            events: Array.from({ length: 6 }, (_, i) => ({
              id: `snare-${i}`,
              at: i * 4 + 2,
              duration: 0.1,
              note: 60,
              velocity: 0.7,
            })),
          },
          {
            id: 'sample',
            name: '铃声 · 音频采样',
            instrument: {
              type: 'sample',
              assetId: 'chime-source',
              sourceDuration: 0.6,
              rootNote: 72,
              gain: 0.7,
            },
            gainDb: -2,
            sends: [{ busId: 'space', db: -8 }],
            events: [0, 8, 16, 22].map((at, i) => ({
              id: `sample-${i}`,
              at,
              duration: 1,
              note: [72, 74, 76, 79][i],
              velocity: 0.8,
            })),
          },
          {
            id: 'riser',
            name: '音效 · 扫频上升',
            instrument: {
              ...soundPreset('sine'),
              fmRatio: 2,
              fmIndex: 1.2,
              attack: 0.2,
              release: 0.4,
              gain: 0.18,
            },
            gainDb: -8,
            pan: -0.3,
            events: [{ id: 'rise', at: 14, duration: 2, note: 36, endNote: 84, velocity: 0.8 }],
            automation: [
              {
                property: 'gainDb',
                keys: [
                  { at: 0, value: -20 },
                  { at: 14, value: -16 },
                  { at: 16, value: -5 },
                  { at: 17, value: -30 },
                  { at: 24, value: -30 },
                ],
              },
            ],
          },
        ],
        buses: [
          {
            id: 'music',
            name: '乐器总线',
            effects: [
              {
                type: 'compressor',
                thresholdDb: -20,
                ratio: 2,
                kneeDb: 6,
                attack: 0.02,
                release: 0.2,
              },
            ],
          },
          {
            id: 'drums',
            name: '鼓组总线',
            effects: [
              {
                type: 'compressor',
                thresholdDb: -18,
                ratio: 3,
                kneeDb: 4,
                attack: 0.008,
                release: 0.12,
              },
            ],
          },
          {
            id: 'space',
            name: '空间 Send',
            effects: [{ type: 'reverb', seconds: 1.6, damping: 0.45, mix: 1 }],
          },
        ],
        master: {
          gainDb: -1,
          effects: [
            { type: 'filter', mode: 'highpass', frequency: 25 },
            { type: 'limiter', ceilingDb: -1, release: 0.08 },
          ],
        },
      };
    const plan = await app.dispatch('soundPlan', {
      items: [
        {
          assetId: 'score',
          document: compileSound(raw).document,
          placement: { trackId: 'music', createTrack: '音乐与音效', start: 0 },
        },
      ],
    });
    const audition = await app.dispatch('soundPreview', {
      planId: present(present(present(plan)).plan).planId,
      assetId: 'score',
      sampleCount: 48000 * 10,
    });
    if (audition.fullMix.clippedSampleRatio) throw new Error('Unexpected clipping in demo master');
    await app.dispatch('projectApply', plan.apply);
    await app.service.transact([
      { type: 'writeSource', path: 'components/lab.ts', content: soundLabSource },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          duration: 420,
          nodes: [
            newNode({
              id: 'lab',
              type: 'component',
              component: 'components/lab.ts',
              audioAssetId: 'score',
              width: 1280,
              height: 720,
            }),
          ],
        },
      },
    ]);
  }
  const checked = await app.dispatch('projectPreflight', {
    samples: [0, 45, 100, 195, 255, 359, 419].map((frame) => ({ sceneId: 'intro', frame })),
    width: 640,
    determinism: true,
    visual: true,
    output: path.join(root, 'exports/contact.png'),
  });
  if (!checked.valid) throw new Error(JSON.stringify(checked.diagnostics));
  for (const format of ['wav', 'mp4'] as const) {
    const job = await app.dispatch('render', {
        revision: app.service.snapshot.revision,
        format,
        output: path.join(root, `exports/sound-lab.${format}`),
      }),
      result = await app.renders.wait(job.id);
    if (result.status !== 'completed') throw new Error(result.error);
  }
  process.stdout.write(
    JSON.stringify(
      {
        root,
        revision: app.service.snapshot.revision,
        output: path.join(root, 'exports/sound-lab.mp4'),
        audio: path.join(root, 'exports/sound-lab.wav'),
        frames: 420,
        contact: checked.output,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await app.close();
}
