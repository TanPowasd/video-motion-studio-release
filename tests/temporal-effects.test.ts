import { it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { loadProject } from '../src/service/project.js';
import { Renderer } from '../src/core/renderer.js';
import { newNode } from '../src/core/model.js';
import { glow } from '../src/sdk/effects.js';
it('glow selects bright edges instead of flooding dark fills', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-bright-'));
  await initProject(root);
  const s = await loadProject(root),
    renderer = new Renderer(root);
  s.project.width = 160;
  s.project.height = 90;
  s.scenes[0].background = 'transparent';
  s.scenes[0].nodes = [
    newNode({
      id: 'edge',
      type: 'rect',
      x: 40,
      y: 20,
      width: 60,
      height: 40,
      fill: '#112030',
      stroke: '#ffffff',
      strokeWidth: 3,
      effects: [glow('#5599ff', 8)],
    }),
  ];
  try {
    const canvas = await renderer.render(s, 10, { sceneId: 'intro' }),
      pixel = canvas.getContext('2d').getImageData(70, 40, 1, 1).data;
    expect(pixel[2]).toBeLessThan(85);
  } finally {
    await renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('fades an entire clip once instead of repeatedly fading its contents', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-fade-'));
  await initProject(root);
  const s = await loadProject(root),
    renderer = new Renderer(root);
  s.project.width = 160;
  s.project.height = 90;
  s.scenes[0].background = 'transparent';
  s.scenes[0].nodes = [
    newNode({ id: 'a', type: 'rect', x: 20, y: 20, width: 40, height: 30, fill: '#ff0000' }),
    newNode({ id: 'b', type: 'rect', x: 40, y: 20, width: 40, height: 30, fill: '#ff0000' }),
  ];
  s.sequences[0].tracks[0].clips[0].fadeIn = 20;
  try {
    const canvas = await renderer.render(s, 10),
      ctx = canvas.getContext('2d');
    expect(ctx.getImageData(30, 30, 1, 1).data[3]).toBeCloseTo(128, 0);
    expect(ctx.getImageData(50, 30, 1, 1).data[3]).toBeCloseTo(128, 0);
  } finally {
    await renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});
it('temporally samples motion in linear light with premultiplied alpha', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-shutter-'));
  await initProject(root);
  const s = await loadProject(root),
    renderer = new Renderer(root);
  s.project.width = 160;
  s.project.height = 90;
  s.project.motionBlur = { samples: 8, shutterAngle: 360 };
  s.scenes[0].background = 'transparent';
  s.scenes[0].nodes = [
    newNode({
      id: 'moving',
      type: 'rect',
      x: 0,
      y: 20,
      width: 10,
      height: 20,
      fill: '#ff0000',
      animations: [
        {
          property: 'x',
          keys: [
            { frame: 0, value: 0, easing: 'linear' },
            { frame: 30, value: 120, easing: 'linear' },
          ],
        },
      ],
    }),
  ];
  try {
    const canvas = await renderer.render(s, 10, { sceneId: 'intro' }),
      edge = canvas.getContext('2d').getImageData(39, 25, 1, 1).data,
      center = canvas.getContext('2d').getImageData(45, 25, 1, 1).data;
    expect(edge[3]).toBeGreaterThan(0);
    expect(edge[3]).toBeLessThan(255);
    expect(center[0]).toBe(255);
    expect(center[3]).toBe(255);
  } finally {
    await renderer.close();
    await rm(root, { recursive: true, force: true });
  }
});
