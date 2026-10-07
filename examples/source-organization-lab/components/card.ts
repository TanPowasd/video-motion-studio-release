import { defineComponent, node, ellipse, text, linearGradient, group } from '@vmotion/sdk';
export default defineComponent({
  name: '可复用来源卡片',
  parameters: {
    accent: { type: 'color', default: '#87baff' },
    secondary: { type: 'color', default: '#254777' },
    value: { type: 'number', default: 72, min: 0, max: 100 },
  },
  render(ctx, p) {
    const t = ctx.seconds,
      accent = String(p.accent),
      position = 110 + Math.sin(t * 1.2) * 7,
      nodes = [
        text('title', '共享视觉源', {
          x: 20,
          y: 12,
          width: 310,
          height: 40,
          fontSize: 22,
          fontWeight: 600,
          fill: '#eaf2ff',
        }),
        text('subtitle', '参数、时间与稳定对象 ID 保持', {
          x: 20,
          y: 52,
          width: 310,
          height: 26,
          fontSize: 13,
          fill: '#839bbb',
        }),
        ellipse('sphere', {
          x: position,
          y: 82 + Math.cos(t) * 7,
          width: 125,
          height: 125,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 100, y: 125 }, [
            accent,
            String(p.secondary),
          ]),
        }),
        ellipse('highlight', {
          x: position + 30,
          y: 103 + Math.cos(t) * 7,
          width: 34,
          height: 20,
          fill: '#fff',
          opacity: 0.18,
        }),
        node({
          id: 'orbit',
          type: 'path',
          path: 'M55 160 C80 218 265 202 288 137',
          stroke: accent,
          strokeWidth: 2,
          fill: 'transparent',
        }),
        ellipse('orbiter', {
          x: 165 + Math.cos(t) * 98,
          y: 179 + Math.sin(t) * 23,
          width: 9,
          height: 9,
          fill: accent,
        }),
        text('value', String(Math.round(Number(p.value))) + '%', {
          x: 20,
          y: 224,
          width: 140,
          height: 28,
          fontSize: 20,
          fontWeight: 600,
          fill: accent,
        }),
        text('tag', 'EDITABLE / SHARED SOURCE', {
          x: 140,
          y: 234,
          width: 190,
          height: 23,
          fontSize: 10,
          fill: '#7890ac',
        }),
      ];
    return group('content', nodes, { width: 350, height: 270 });
  },
});
