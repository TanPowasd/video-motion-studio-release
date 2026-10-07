import {
  defineComponent,
  rect,
  text,
  ellipse,
  node,
  group,
  linearGradient,
  type Node,
} from '@vmotion/sdk';
export default defineComponent({
  name: '动作层与循环编排',
  parameters: { amplitude: { type: 'number', default: 24, min: 0, max: 50 } },
  render(ctx, p) {
    const entrance = 1 - (1 - Math.min(1, ctx.frame / 24)) ** 3,
      nodes: Node[] = [
        text('brand', 'VMOTION  /  MOTION LAYERS', {
          x: 64,
          y: 34,
          width: 1000,
          height: 25,
          fontSize: 15,
          fill: '#80b9fa',
        }),
        text('title', '让动作自由叠加', {
          x: 60,
          y: 74 + (1 - entrance) * 16,
          width: 1100,
          height: 78,
          fontSize: 50,
          fontWeight: 700,
          fill: '#f0f5ff',
          opacity: entrance,
        }),
        text('intro', '独立动作层 · 稳定权重 · 随机跳转一致', {
          x: 64,
          y: 160,
          width: 1050,
          height: 32,
          fontSize: 21,
          fill: '#91a6c0',
          opacity: entrance,
        }),
      ],
      cards = [
        { id: 'base', label: '基础关键帧', detail: 'NATIVE KEYS / EASE IN OUT', fill: '#8dbefc' },
        { id: 'mixed', label: '位移 + 呼吸', detail: 'ADD + MULTIPLY / PINGPONG', fill: '#b5a3ff' },
        {
          id: 'follower',
          label: '表达式跟随',
          detail: 'FINAL LAYER / PROPERTY LINK',
          fill: '#81dec8',
        },
      ];
    cards.forEach((card, i) => {
      const x = 64 + i * 392,
        y = 245 + (1 - entrance) * 24;
      nodes.push(
        rect(card.id + '-panel', {
          x,
          y,
          width: 368,
          height: 338,
          radius: 18,
          fill: '#152136',
          stroke: '#2b3c58',
          strokeWidth: 1,
          opacity: entrance,
        }),
        text(card.id + '-index', '0' + (i + 1), {
          x: x + 22,
          y: y + 16,
          width: 70,
          height: 23,
          fontSize: 14,
          fill: card.fill,
          opacity: entrance,
        }),
        text(card.id + '-label', card.label, {
          x: x + 22,
          y: y + 50,
          width: 310,
          height: 36,
          fontSize: 25,
          fontWeight: 600,
          fill: '#eaf0fa',
          opacity: entrance,
        }),
        text(card.id + '-caption', card.detail, {
          x: x + 22,
          y: y + 302,
          width: 325,
          height: 24,
          fontSize: 12,
          fill: '#8097b6',
          opacity: entrance,
        }),
      );
      nodes.push(
        node({
          id: card.id + '-route',
          type: 'path',
          path: `M${x + 40} ${y + 211} L${x + 328} ${y + 211}`,
          stroke: '#385271',
          strokeWidth: 2,
          fill: 'transparent',
          opacity: entrance,
        }),
      );
      const ball = node({
        id: card.id + '-ball',
        type: 'ellipse',
        x: x + 90,
        y: y + 145,
        width: 82,
        height: 82,
        originX: 41,
        originY: 41,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 82, y: 82 }, [card.fill, '#2a4975']),
        opacity: entrance,
        animations: [
          {
            property: 'x',
            keys: [
              { frame: 0, value: x + 90, easing: 'easeInOut' },
              { frame: 90, value: x + 196, easing: 'easeInOut' },
              { frame: 179, value: x + 90, easing: 'linear' },
            ],
          },
        ],
      });
      if (card.id === 'mixed')
        ball.animationLayers = [
          {
            id: 'float',
            name: '垂直浮动',
            enabled: true,
            blend: 'add',
            weight: 1,
            start: 0,
            rate: 1,
            offset: 0,
            channels: [
              {
                property: 'y',
                keys: [
                  { frame: 0, value: 0, easing: 'easeInOut' },
                  { frame: 24, value: -Number(p.amplitude), easing: 'easeInOut' },
                  { frame: 48, value: 0, easing: 'linear' },
                ],
                after: 'cycle',
              },
            ],
          },
          {
            id: 'breathe',
            name: '呼吸缩放',
            enabled: true,
            blend: 'multiply',
            weight: 1,
            start: 0,
            rate: 1,
            offset: 0,
            channels: ['scaleX', 'scaleY'].map((property) => ({
              property,
              keys: [
                { frame: 0, value: 1, easing: 'easeInOut' as const },
                { frame: 30, value: 1.15, easing: 'linear' as const },
              ],
              after: 'pingpong' as const,
            })),
          },
        ];
      if (card.id === 'follower') {
        ball.animations = [];
        ball.expressions = {
          x: 'layer("mixed-ball").x + 392',
          y: 'layer("mixed-ball").y',
          scaleX: 'layer("mixed-ball").scaleX',
          scaleY: 'layer("mixed-ball").scaleY',
        };
      }
      nodes.push(ball);
      nodes.push(
        ...group(
          card.id + '-annotation',
          [
            text('local', card.id === 'base' ? '仅运动' : '可叠加', {
              x: 0,
              y: 0,
              width: 110,
              height: 25,
              fontSize: 14,
              fill: card.fill,
            }),
          ],
          { x: x + 22, y: y + 272, width: 110, height: 25, opacity: entrance },
        ),
      );
    });
    nodes.push(
      rect('rule', { x: 64, y: 625, width: 1152, height: 1, fill: '#2a3f5c' }),
      text('footer', '普通关键帧 → 动作层混合 → 属性依赖 → 统一预览与导出', {
        x: 64,
        y: 650,
        width: 1090,
        height: 26,
        fontSize: 17,
        fill: '#819ab7',
      }),
    );
    return nodes;
  },
});
