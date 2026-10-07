import {
  defineComponent,
  rect,
  text,
  ellipse,
  node,
  group,
  linearGradient,
  effectGraph,
} from '@vmotion/sdk';
export default defineComponent({
  name: '可编程抠像与背景重建',
  parameters: {
    threshold: { type: 'number', default: 0.08, min: 0, max: 0.35 },
    softness: { type: 'number', default: 0.15, min: 0, max: 0.4 },
  },
  render(ctx, p) {
    const t = ctx.seconds,
      ease = 1 - (1 - Math.min(1, ctx.frame / 24)) ** 3,
      nodes = [
        text('brand', 'VMOTION  /  KEYING LAB', {
          x: 64,
          y: 34,
          width: 800,
          height: 25,
          fontSize: 15,
          fill: '#69c9ad',
        }),
        text('title', '保留主体，重建画面', {
          x: 60,
          y: 74 + (1 - ease) * 15,
          width: 1120,
          height: 78,
          fontSize: 50,
          fontWeight: 700,
          fill: '#f1f5ff',
          opacity: ease,
        }),
        text('subtitle', '颜色分离 · 柔和边缘 · 可复用 Alpha', {
          x: 64,
          y: 160,
          width: 1000,
          height: 32,
          fontSize: 21,
          fill: '#8ba3b8',
          opacity: ease,
        }),
      ];
    const cards = [
      {
        id: 'source',
        label: '原始绿幕',
        caption: 'SOURCE / ENCODED SDR',
        output: 'original',
        accent: '#75dcaa',
      },
      {
        id: 'matte',
        label: '检查透明遮罩',
        caption: 'UV DISTANCE / SOFT MATTE',
        output: 'matte',
        accent: '#c3cfff',
      },
      {
        id: 'composite',
        label: '放进新的画面',
        caption: 'KEYED ALPHA / NEW BACKGROUND',
        output: 'keyed',
        accent: '#ffb690',
      },
    ];
    cards.forEach((card, i) => {
      const x = 64 + i * 392,
        y = 246 + (1 - ease) * (28 + i * 6);
      nodes.push(
        rect(card.id + '-panel', {
          x,
          y,
          width: 368,
          height: 337,
          radius: 18,
          fill: '#132131',
          stroke: '#2a4356',
          strokeWidth: 1,
          opacity: ease,
        }),
        text(card.id + '-index', '0' + (i + 1), {
          x: x + 22,
          y: y + 16,
          width: 60,
          height: 23,
          fontSize: 14,
          fill: card.accent,
          opacity: ease,
        }),
        text(card.id + '-label', card.label, {
          x: x + 22,
          y: y + 49,
          width: 330,
          height: 38,
          fontSize: 25,
          fontWeight: 600,
          fill: '#eaf2fa',
          opacity: ease,
        }),
        text(card.id + '-caption', card.caption, {
          x: x + 22,
          y: y + 300,
          width: 330,
          height: 25,
          fontSize: 12,
          fill: '#7996ad',
          opacity: ease,
        }),
      );
      if (card.id === 'composite') {
        nodes.push(
          rect('new-bg', {
            x: x + 50,
            y: y + 102,
            width: 268,
            height: 184,
            radius: 14,
            gradient: linearGradient({ x: 0, y: 0 }, { x: 268, y: 184 }, ['#41648d', '#22324b']),
            opacity: ease,
          }),
        );
        for (let k = 0; k < 6; k++)
          nodes.push(
            rect('new-band-' + k, {
              x: x + 58 + k * 48,
              y: y + 99,
              width: 2,
              height: 188,
              fill: '#6f8eb4',
              opacity: 0.16 * ease,
              rotation: 12,
            }),
          );
      }
      const avatar = [
        node({
          id: 'body',
          type: 'path',
          path: 'M75 192 Q86 127 145 122 Q213 126 231 192 Z',
          gradient: linearGradient({ x: 70, y: 110 }, { x: 230, y: 195 }, ['#98b5ed', '#4d6eb6']),
        }),
        ellipse('hair', { x: 102, y: 30, width: 112, height: 111, fill: '#172d44' }),
        ellipse('face', { x: 117, y: 51, width: 85, height: 94, fill: '#f3b38b' }),
        ellipse('ear', { x: 192, y: 88, width: 18, height: 24, fill: '#ecaa83' }),
        ellipse('fringe', { x: 108, y: 36, width: 95, height: 37, fill: '#172d44', rotation: -6 }),
        ellipse('eye-left', { x: 136, y: 92, width: 5, height: 7, fill: '#263146' }),
        ellipse('eye-right', { x: 171, y: 92, width: 5, height: 7, fill: '#263146' }),
        node({
          id: 'smile',
          type: 'path',
          path: 'M146 119 Q157 128 170 117',
          stroke: '#9a594e',
          strokeWidth: 2,
          fill: 'transparent',
        }),
      ];
      const content = [
        rect('green', { x: 30, y: 16, width: 250, height: 184, radius: 14, fill: '#36ff36' }),
        ...group('avatar', avatar, {
          x: Math.sin(t * 1.05) * 8,
          y: Math.cos(t * 1.05) * 3,
          width: 300,
          height: 204,
        }),
      ];
      nodes.push(
        ...group(card.id + '-visual', content, {
          x: x + 28,
          y: y + 87,
          width: 310,
          height: 204,
          opacity: ease,
          effects: [
            effectGraph(
              'components/effects/key.json',
              { threshold: Number(p.threshold), softness: Number(p.softness) },
              {},
              card.output,
            ),
          ],
        }),
      );
    });
    nodes.push(
      rect('rule', { x: 64, y: 625, width: 1152, height: 1, fill: '#294056' }),
      text('footer', '可编辑阈值与边缘 · 逐帧像素对照 · 同一核心预览与导出', {
        x: 64,
        y: 649,
        width: 1090,
        height: 26,
        fontSize: 17,
        fill: '#849db1',
      }),
    );
    return nodes;
  },
});
