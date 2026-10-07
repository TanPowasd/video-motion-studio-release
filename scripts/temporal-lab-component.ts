import {
  defineComponent,
  node,
  group,
  text,
  rect,
  ellipse,
  motionBlur,
  echo,
  particleField,
  meshWarp,
  makeWarpGrid,
  linearGradient,
  liquify,
} from '@vmotion/sdk';
export default defineComponent({
  name: '时间与平面特效',
  parameters: { strength: { type: 'number', default: 1, min: 0, max: 1 } },
  render(ctx, params) {
    const t = ctx.seconds,
      s = Number(params.strength),
      nodes = [
        text('heading', '时间与平面特效', {
          x: 42,
          y: 22,
          width: 1100,
          height: 65,
          fontSize: 36,
          fontWeight: 700,
          fill: '#edf3ff',
        }),
        text('subtitle', 'Motion blur · Echo · Particles · Mesh deformation', {
          x: 44,
          y: 73,
          width: 1100,
          height: 38,
          fontSize: 18,
          fill: '#8098b8',
        }),
      ];
    const card = (id: string, label: string, detail: string, x: number, y: number, draw: any[]) => {
      nodes.push(
        rect(id + '-bg', { x, y, width: 572, height: 250, radius: 12, fill: '#17233a' }),
        text(id + '-title', label, {
          x: x + 20,
          y: y + 14,
          width: 532,
          height: 34,
          fontSize: 22,
          fontWeight: 700,
          fill: '#d6e6ff',
        }),
        ...group(id, draw, {
          x: x + 20,
          y: y + 58,
          width: 532,
          height: 146,
          clip: { x: 0, y: 0, width: 532, height: 146 },
        }),
        text(id + '-detail', detail, {
          x: x + 20,
          y: y + 213,
          width: 532,
          height: 28,
          fontSize: 13,
          fill: '#7991b3',
        }),
      );
    };
    const x = 55 + 410 * (0.5 + 0.5 * Math.sin(t * 5)),
      y = 72 + 25 * Math.sin(t * 3);
    card('blur', '01 / 运动模糊', '逐子帧重新求值 TypeScript 动画', 44, 124, [
      text('sharp-label', '原始', {
        x: 8,
        y: 5,
        width: 70,
        height: 24,
        fontSize: 13,
        fill: '#718dad',
      }),
      rect('sharp', { x, y: 32, width: 18, height: 25, radius: 4, fill: '#74beff' }),
      text('blur-label', '8 采样', {
        x: 8,
        y: 82,
        width: 80,
        height: 24,
        fontSize: 13,
        fill: '#718dad',
      }),
      rect('blurred', {
        x,
        y: 111,
        width: 18,
        height: 25,
        radius: 4,
        fill: '#b1d9ff',
        effects: [motionBlur({ samples: 8, shutterAngle: 360 * s })],
      }),
    ]);
    card('echo', '02 / 时间拖尾', '历史位置、透明度与内容 · 可随机跳转', 664, 124, [
      ellipse('orb', {
        x: 230 + 190 * Math.cos(t * 2) - 12,
        y: 65 + 46 * Math.sin(t * 4) - 12,
        width: 24,
        height: 24,
        fill: '#dfaaff',
        effects: [echo({ count: 10, spacing: 2, decay: 0.78, strength: s, operator: 'screen' })],
      }),
    ]);
    card(
      'particles',
      '03 / 解析粒子',
      '稳定出生 ID · 重力、阻力、渐变与速度条纹',
      44,
      408,
      group(
        'field',
        particleField('spark', ctx, {
          seed: 71,
          mode: 'continuous',
          rate: 55,
          origin: { x: 265, y: 119 },
          emission: 'line',
          area: { x: 80, y: 0 },
          direction: -90,
          spread: 95,
          speed: { min: 70, max: 140 },
          gravity: { x: 25, y: 75 },
          drag: 0.2,
          lifetime: { min: 1, max: 1.7 },
          size: { min: 2, max: 4 },
          shape: 'streak',
          streakScale: 0.05,
          colors: ['#92d5ff', '#8b9bff', '#ffffff'],
          tintEnd: true,
          endColor: '#955dd2',
        }),
        {
          width: 532,
          height: 146,
          effects: [
            echo({ count: 3, spacing: 1.5, strength: 0.45 * s, decay: 0.55, operator: 'screen' }),
          ],
        },
      ),
    );
    const grid = makeWarpGrid(10, 4, (u, v) => ({
      x: u,
      y: v + Math.sin(u * 10 - t * 3) * 0.13 * u * s,
    }));
    const texture = [
      rect('fabric', {
        width: 330,
        height: 96,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 330, y: 90 }, ['#367cef', '#906ded']),
      }),
      text('fabric-title', 'VMOTION', {
        x: 22,
        y: 25,
        width: 290,
        height: 52,
        fontSize: 32,
        fontWeight: 700,
        fill: '#f3f5ff',
      }),
      ...Array.from({ length: 11 }, (_, i) =>
        rect('line' + i, { x: i * 33, y: 0, width: 1, height: 96, fill: '#ffffff', opacity: 0.15 }),
      ),
    ];
    card(
      'warp',
      '04 / 可编辑网格',
      'UV 纹理变形 · 控制点、权重与强度动画',
      664,
      408,
      group('fabric', texture, {
        x: 105,
        y: 25,
        width: 330,
        height: 96,
        effects: [
          meshWarp({ columns: 10, rows: 4, points: grid }),
          liquify({
            amount: s,
            brushes: [
              {
                mode: 'twirl',
                center: { x: 0.7, y: 0.5 },
                radius: 38,
                angle: 35 * Math.sin(t * 2),
              },
            ],
          }),
        ],
      }),
    );
    nodes.push(
      text('footer', 'VMOTION / 外部 Agent 创作 · 本地确定性渲染', {
        x: 44,
        y: 685,
        width: 1150,
        height: 24,
        fontSize: 12,
        fill: '#657f9f',
      }),
    );
    return nodes;
  },
});
