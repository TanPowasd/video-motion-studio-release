import {
  defineComponent,
  node,
  rect,
  text,
  group,
  ellipse,
  effectGraph,
  linearGradient,
} from '@vmotion/sdk';
export default defineComponent({
  name: '通道、多输出与可复用合成',
  parameters: { exposure: { type: 'number', default: 1, min: 0.2, max: 2 } },
  render(ctx, params) {
    const t = ctx.seconds,
      entrance = Math.min(1, Math.max(0, ctx.frame / 22)),
      ease = 1 - (1 - entrance) ** 3,
      nodes = [
        text('eyebrow', 'VMOTION  /  COMPOSITING LAB', {
          x: 64,
          y: 34,
          width: 800,
          height: 24,
          fontSize: 15,
          fill: '#72b9df',
        }),
        text('title', '一份视觉，三种表达', {
          x: 60,
          y: 75 + (1 - ease) * 16,
          width: 1100,
          height: 76,
          fontSize: 50,
          fontWeight: 700,
          fill: '#f1f5ff',
          opacity: ease,
        }),
        text('intro', '复用图像 · 选择输出 · 自由组合通道', {
          x: 64,
          y: 158,
          width: 1000,
          height: 32,
          fontSize: 21,
          fill: '#889fb7',
          opacity: ease,
        }),
      ];
    const cards = [
      {
        id: 'original',
        label: '原始颜色',
        caption: 'SOURCE / RGB + ALPHA',
        graph: 'components/effects/visual.json',
        output: 'original',
        accent: '#8fe4fc',
      },
      {
        id: 'grade',
        label: '矩阵调色',
        caption: 'LINEAR RGB / 4 × 5 MATRIX',
        graph: 'components/effects/visual.json',
        output: 'graded',
        accent: '#ffb18e',
      },
      {
        id: 'matte',
        label: '复用透明遮罩',
        caption: 'SUBGRAPH / NAMED OUTPUT',
        graph: 'components/effects/mask-tint.json',
        output: undefined,
        accent: '#b7a3ff',
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
          fill: '#131e30',
          stroke: '#253b51',
          strokeWidth: 1,
          opacity: ease,
        }),
      );
      nodes.push(
        text(card.id + '-index', '0' + (i + 1), {
          x: x + 22,
          y: y + 17,
          width: 70,
          height: 22,
          fontSize: 14,
          fill: card.accent,
          opacity: ease,
        }),
      );
      nodes.push(
        text(card.id + '-label', card.label, {
          x: x + 22,
          y: y + 49,
          width: 310,
          height: 36,
          fontSize: 25,
          fontWeight: 600,
          fill: '#eaf0fa',
          opacity: ease,
        }),
      );
      nodes.push(
        text(card.id + '-caption', card.caption, {
          x: x + 22,
          y: y + 300,
          width: 320,
          height: 22,
          fontSize: 12,
          fill: '#7892ac',
          opacity: ease,
        }),
      );
      for (let row = 0; row < 6; row++)
        for (let col = 0; col < 9; col++)
          nodes.push(
            ellipse(`${card.id}-dot-${row}-${col}`, {
              x: x + 34 + col * 36,
              y: y + 101 + row * 31,
              width: 2,
              height: 2,
              fill: '#33516e',
              opacity: ease,
            }),
          );
      const content = [
        ellipse('sphere', {
          x: 82 + Math.sin(t * 1.1) * 5,
          y: 21 + Math.cos(t * 1.1) * 7,
          width: 140,
          height: 140,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 98, y: 140 }, [
            '#cbe6ff',
            '#518eed',
            '#313185',
          ]),
        }),
        ellipse('highlight', {
          x: 117 + Math.sin(t * 1.1) * 5,
          y: 43 + Math.cos(t * 1.1) * 7,
          width: 35,
          height: 23,
          fill: '#ffffff',
          opacity: 0.3,
        }),
        rect('chip', {
          x: 187 + Math.cos(t) * 5,
          y: 111 + Math.sin(t) * 8,
          width: 53,
          height: 53,
          radius: 12,
          rotation: 10 + t * 12,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 53, y: 53 }, ['#ffbb98', '#d76e75']),
        }),
        node({
          id: 'orbit',
          type: 'path',
          path: 'M40 120 C75 184 258 173 278 82',
          stroke: '#76cdf8',
          strokeWidth: 3,
          fill: 'transparent',
        }),
        ellipse('orbiter', {
          x: 152 + Math.cos(t * 0.9) * 108,
          y: 138 + Math.sin(t * 0.9) * 38,
          width: 13,
          height: 13,
          fill: '#a2e9ff',
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
              card.graph,
              {
                exposure: Math.max(
                  0.2,
                  Number(params.exposure) * (card.id === 'grade' ? 0.9 + 0.1 * Math.sin(t) : 1),
                ),
              },
              {},
              card.output,
            ),
          ],
        }),
      );
    });
    nodes.push(rect('rule', { x: 64, y: 625, width: 1152, height: 1, fill: '#263b53' }));
    nodes.push(
      text('footer', '可编辑 JSON / TypeScript    ·    统一预览与导出    ·    确定性逐帧求值', {
        x: 64,
        y: 650,
        width: 1050,
        height: 25,
        fontSize: 16,
        fill: '#7d96ae',
      }),
    );
    return nodes;
  },
});
