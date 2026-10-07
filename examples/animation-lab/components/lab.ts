import {
  defineComponent,
  node,
  text,
  rect,
  ellipse,
  path,
  group,
  linearGradient,
  radialGradient,
  glow,
  particles,
  progress,
  tween,
  spring,
  stagger,
  followPath,
  morphPoints,
  pointsPath,
  project3D,
  trail,
  type ComponentContext,
  type Node,
} from '@vmotion/sdk';
const ring = (cx: number, cy: number, r: number) =>
  Array.from({ length: 97 }, (_, i) => ({
    x: cx + Math.cos((i / 96) * Math.PI * 2) * r,
    y: cy + Math.sin((i / 96) * Math.PI * 2) * r,
  }));
export default defineComponent({
  name: 'Animation laboratory',
  parameters: {
    mode: { type: 'string', default: 'type' },
    accent: { type: 'color', default: '#79b6ff' },
  },
  render(ctx, params) {
    const s = ctx.seconds,
      accent = String(params.accent),
      mode = String(params.mode),
      nodes: Node[] = [
        rect('background', {
          width: 1280,
          height: 720,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, [
            '#0b1021',
            '#14132d',
            '#091929',
          ]),
        }),
        text('label', `VMOTION / ANIMATION LAB / ${mode.toUpperCase()}`, {
          x: 78,
          y: 42,
          width: 1100,
          height: 40,
          fontSize: 16,
          fill: '#8b99bb',
        }),
        text('footer', '外部 agent 编程创作 · 可组合 SDK · 多帧视觉检查', {
          x: 78,
          y: 668,
          width: 1120,
          height: 36,
          fontSize: 18,
          fill: '#8999b8',
        }),
      ];
    for (let i = 0; i < 7; i++)
      nodes.push(
        path(`grid-${i}`, `M 70 ${190 + i * 65} L 1210 ${190 + i * 65}`, {
          stroke: '#24334a',
          strokeWidth: 1,
          opacity: 0.35,
          fill: 'transparent',
        }),
      );
    if (mode === 'type') {
      const p = spring(ctx, { mass: 1, stiffness: 110, damping: 16, start: 8 });
      nodes.push(
        ...group(
          'title',
          [
            text('main', '让动画真正动起来', {
              width: 1120,
              height: 150,
              fontSize: 82,
              fontWeight: 700,
              fill: '#e2ecff',
              textMotion: {
                unit: 'grapheme',
                start: 5,
                duration: 22,
                stagger: 4,
                offsetX: 0,
                offsetY: 48,
                rotation: -12,
                scale: 0.7,
              },
            }),
          ],
          { x: 78, y: 150, effects: [glow(accent, 16, 0.75)] },
        ),
      );
      nodes.push(
        text('detail', '错峰文字 / 物理弹簧 / 图层发光', {
          x: 84,
          y: 290,
          width: 1080,
          height: 60,
          fontSize: 27,
          fill: '#8099c4',
          opacity: progress(ctx, { start: 40, duration: 24 }),
        }),
      );
      for (let i = 0; i < 4; i++) {
        const enter = stagger(ctx, i, { start: 28, duration: 28, delay: 9 });
        nodes.push(
          rect(`card-${i}`, {
            x: 82 + i * 282,
            y: 425 + (1 - enter) * 70,
            width: 258,
            height: 140,
            radius: 18,
            opacity: enter,
            gradient: linearGradient({ x: 0, y: 0 }, { x: 260, y: 140 }, ['#283968', '#181c37']),
          }),
          text(`card-title-${i}`, ['TIMING', 'LAYERS', 'EFFECTS', 'FEEDBACK'][i], {
            x: 105 + i * 282,
            y: 452 + (1 - enter) * 70,
            width: 220,
            height: 60,
            fontSize: 22,
            fill: accent,
            opacity: enter,
          }),
          path(
            `pulse-${i}`,
            `M ${106 + i * 282} 530 L ${106 + i * 282 + 160 * Math.max(0, Math.min(1, p))} 530`,
            { stroke: '#accfff', strokeWidth: 4, fill: 'transparent', opacity: enter },
          ),
        );
      }
      nodes.push(
        ...group(
          'dust',
          particles('p', ctx, {
            seed: 23,
            count: 80,
            origin: { x: 640, y: 680 },
            spread: { x: 1100, y: 100 },
            velocity: { x: 10, y: -105 },
            velocitySpread: { x: 80, y: 70 },
            lifetime: 3,
            colors: [accent, '#ffffff'],
            size: [1, 2.5],
          }),
          { effects: [glow(accent, 7, 0.5)] },
        ),
      );
    } else if (mode === 'science') {
      nodes.push(
        text('heading', '让关系随时间展开', {
          x: 78,
          y: 100,
          width: 1140,
          height: 110,
          fontSize: 64,
          fontWeight: 600,
          fill: '#e0ebff',
        }),
      );
      const amount = progress(ctx, { duration: 80, loop: true, yoyo: true }),
        from = ring(365, 395, 135),
        to = from.map((_, i) => {
          const a = (i / 96) * Math.PI * 2,
            r = 88 + 65 * Math.cos(5 * a);
          return { x: 365 + Math.cos(a) * r, y: 395 + Math.sin(a) * r };
        });
      nodes.push(
        ...group(
          'morph',
          [
            path('shape', pointsPath(morphPoints(from, to, amount), true), {
              fill: '#142d48',
              stroke: accent,
              strokeWidth: 4,
            }),
          ],
          { effects: [glow(accent, 14, 0.7)] },
        ),
      );
      const wave = Array.from({ length: 161 }, (_, i) => ({
        x: 695 + i * 2.8,
        y: 410 - Math.sin((i / 160) * 4 * Math.PI - s * 2) * 74,
      }));
      nodes.push(
        path('axis', 'M 695 410 L 1148 410', {
          stroke: '#546888',
          strokeWidth: 1.5,
          fill: 'transparent',
        }),
        path('wave', pointsPath(wave), { stroke: '#d6b377', strokeWidth: 4, fill: 'transparent' }),
      );
      const at = followPath(wave, progress(ctx, { duration: 75, loop: true }));
      nodes.push(
        ...group(
          'tracer',
          trail(
            'trace',
            ctx,
            (past) => {
              const a = followPath(wave, progress(past, { duration: 75, loop: true }));
              return [
                ellipse('dot', { x: a.x - 7, y: a.y - 7, width: 14, height: 14, fill: '#fff0ba' }),
              ];
            },
            { samples: 8, spacing: 2, opacity: 0.7 },
          ),
          { effects: [glow('#eec27d', 8, 0.6)] },
        ),
        ellipse('head', { x: at.x - 9, y: at.y - 9, width: 18, height: 18, fill: '#fff3d0' }),
      );
      nodes.push(
        text('morph-label', '相同拓扑点集的连续形变', {
          x: 170,
          y: 577,
          width: 500,
          height: 50,
          fontSize: 22,
          fill: '#93aaca',
        }),
        text('wave-label', '轨迹弧长 / 历史残影 / 函数表达式', {
          x: 660,
          y: 577,
          width: 570,
          height: 50,
          fontSize: 21,
          fill: '#93aaca',
        }),
      );
    } else {
      nodes.push(
        text('heading', '镜头，让空间有了层次', {
          x: 78,
          y: 100,
          width: 1140,
          height: 105,
          fontSize: 64,
          fontWeight: 600,
          fill: '#e0ebff',
        }),
      );
      const camera = {
        position: { x: Math.sin(s * 0.6) * 7, y: 3, z: Math.cos(s * 0.6) * 7 },
        target: { x: 0, y: 0, z: 0 },
        width: 1280,
        height: 720,
        fov: 55,
      };
      const vertices = Array.from({ length: 8 }, (_, i) => ({
          x: (i & 1 ? 1 : -1) * 1.35,
          y: (i & 2 ? 1 : -1) * 1.35,
          z: (i & 4 ? 1 : -1) * 1.35,
        })),
        projected = vertices.map((v) => project3D(v, camera));
      const wires: Node[] = [];
      for (let i = 0; i < 8; i++)
        for (const bit of [1, 2, 4]) {
          const j = i ^ bit;
          if (j > i && projected[i].visible && projected[j].visible)
            wires.push(
              path(
                `edge-${i}-${j}`,
                `M ${projected[i].x} ${projected[i].y + 25} L ${projected[j].x} ${projected[j].y + 25}`,
                { stroke: accent, strokeWidth: 3, fill: 'transparent' },
              ),
            );
        }
      nodes.push(...group('cube', wires, { effects: [glow(accent, 13, 0.9)] }));
      const orbit: Node[] = [];
      for (let i = 0; i < 30; i++) {
        const angle = (i / 30) * 2 * Math.PI,
          p = project3D(
            {
              x: Math.cos(angle) * 3.2,
              y: Math.sin(angle * 3 + s) * 0.45,
              z: Math.sin(angle) * 3.2,
            },
            camera,
          );
        if (!p.visible) continue;
        orbit.push(
          ellipse(`orbit-${i}`, {
            x: p.x - 4,
            y: p.y + 25 - 4,
            width: 8,
            height: 8,
            fill: i % 3 ? '#8ab7e8' : '#f0cf90',
            opacity: 0.75,
          }),
        );
      }
      nodes.push(...group('orbit', orbit, { effects: [glow(accent, 8, 0.6)] }));
      nodes.push(
        text('camera-note', '透视相机 + 近裁剪 + 2.5D 投影（尚非网格与灯光渲染）', {
          x: 78,
          y: 610,
          width: 1140,
          height: 58,
          fontSize: 22,
          fill: '#8d9fbd',
        }),
      );
    }
    return nodes;
  },
});
