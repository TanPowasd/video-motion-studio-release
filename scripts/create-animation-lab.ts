import { cp, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { atomicWrite, json } from '../src/service/project.js';
import { newNode, type Project, type Scene, type Sequence } from '../src/core/model.js';
const root = path.resolve('examples/animation-lab');
if (!existsSync(path.join(root, 'project.vmotion.json')))
  await initProject(root, 'Vmotion 动画特效实验台');
await cp('scripts/animation-lab-component.ts', path.join(root, 'components/lab.ts'));
const project = JSON.parse(
  await readFile(path.join(root, 'project.vmotion.json'), 'utf8'),
) as Project;
project.width = 1280;
project.height = 720;
project.scenes = [];
const sequence: Sequence = {
  id: 'main',
  name: '动效 · 数学动画 · 空间镜头',
  duration: 540,
  markers: [],
  tracks: [{ id: 'visual', name: 'Effects demonstration', type: 'video', muted: false, clips: [] }],
};
for (const [i, [id, name]] of [
  ['type', '文字与粒子'],
  ['science', '科学图形与轨迹'],
  ['camera', '透视镜头与空间'],
].entries()) {
  const file = `scenes/${id}.json`,
    scene: Scene = {
      id,
      name,
      duration: 180,
      background: '#0b1021',
      nodes: [
        newNode({
          id: 'lab',
          type: 'component',
          name,
          component: 'components/lab.ts',
          width: 1280,
          height: 720,
          params: { mode: id, accent: '#79b6ff' },
        }),
      ],
    };
  project.scenes.push(file);
  await atomicWrite(path.join(root, file), json(scene));
  sequence.tracks[0].clips.push({
    id: `clip-${id}`,
    sceneId: id,
    start: i * 180,
    duration: 180,
    sourceIn: 0,
    speed: 1,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  });
  sequence.markers.push({ id: `marker-${id}`, frame: i * 180, label: name });
}
await atomicWrite(path.join(root, 'project.vmotion.json'), json(project));
await atomicWrite(path.join(root, 'sequences/main.json'), json(sequence));
console.log(json({ project: root, seconds: 18, frames: 540 }));
