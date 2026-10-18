// examples/jsx-lab: 48 beats at 128 BPM (675 frames @ 30 fps) authored in JSX/TSX.
// The components/*.tsx sources are hand-written and tracked in Git; this script only (re)writes
// the scene/sequence timing around the component layer and exports evidence.
//   npx tsx scripts/create-jsx-lab.ts --rebuild [--render] [--output f.mp4] [--contact sheet.png]
//   npx tsx scripts/create-jsx-lab.ts --render-only [--output f.mp4]
import path from 'node:path';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { Application } from '../src/service/application.js';
import { existingService } from '../src/service/ipc.js';
import { newNode } from '../src/core/model.js';

const root = path.resolve('examples/jsx-lab'),
  renderOnly = process.argv.includes('--render-only'),
  arg = (name: string) => {
    const i = process.argv.indexOf(name);
    return i > 0 ? process.argv[i + 1] : undefined;
  };
if (!existsSync(path.join(root, 'project.vmotion.json')))
  throw new Error('examples/jsx-lab is tracked in Git; restore it with git checkout');
if (await existingService(root)) throw new Error('Close the example before authoring');
if (!renderOnly && !process.argv.includes('--rebuild'))
  throw new Error('Use --render-only to preserve edits, or explicit --rebuild');
const FRAMES = 675, // 48 beats × 30 fps × 60 / 128
  barFrames = (4 * 30 * 60) / 128;
const app = await new Application(root).open(false);
try {
  if (!renderOnly) {
    const existing = app.service.snapshot.scenes.find((s) => s.id === 'intro')?.nodes.find((n) => n.id === 'lab');
    await app.service.transact([
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          name: 'JSX 实验室',
          duration: FRAMES,
          background: '#07090f',
          nodes: [
            newNode({
              id: 'lab',
              type: 'component',
              name: 'JSX Lab',
              width: 1280,
              height: 720,
              component: 'components/jsx-lab.tsx',
              // Keep visual-edit overrides and parameters made in the editor.
              params: existing?.params ?? {},
              overrides: existing?.overrides ?? {},
            }),
          ],
        },
      },
      {
        type: 'updateSequence',
        sequenceId: 'main',
        patch: {
          duration: FRAMES,
          tracks: [
            {
              id: 'visual',
              name: '画面',
              type: 'video',
              muted: false,
              clips: [
                { id: 'intro-clip', sceneId: 'intro', start: 0, duration: FRAMES, sourceIn: 0, speed: 1, volume: 1, fadeIn: 0, fadeOut: 0 },
              ],
            },
            { id: 'voice', name: '声音', type: 'audio', muted: false, clips: [] },
          ],
          markers: Array.from({ length: 12 }, (_, i) => ({
            id: `beat-bar-${i}`,
            frame: Math.round(i * barFrames),
            label: `bar ${i + 1}`,
            kind: 'beat' as const,
          })),
        },
      },
    ]);
  }
  await mkdir(path.join(root, 'exports'), { recursive: true });
  // 12 frames (visualAudit maxImages cap) spanning all seven steps, four inside the layout chapters.
  const frames = [40, 150, 240, 330, 400, 440, 470, 520, 560, 585, 620, 660];
  const contact = arg('--contact') ?? path.join(root, 'exports/contact-sheet.png');
  const audit = await app.dispatch('visualAudit', { sceneId: 'intro', frames, width: 426, maxImages: 12, output: contact });
  for (const frame of [420, 540]) await writeFile(path.join(root, `exports/jsx-lab-${frame}.png`), (await app.frame({ frame })).buffer);
  if (process.argv.includes('--render') || renderOnly) {
    const job = app.renders.start(app.service.snapshot, {
        format: 'mp4',
        encoder: 'libx264',
        output: arg('--output') ?? path.join(root, 'exports/jsx-lab.mp4'),
      }),
      done = await app.renders.wait(job.id);
    console.log(JSON.stringify({ status: done.status, output: done.output, error: done.error }));
    if (done.status !== 'completed') process.exitCode = 1;
  }
  console.log(JSON.stringify({ root, revision: app.service.snapshot.revision, contact, audit: audit.summary }));
} finally {
  await app.close();
}
