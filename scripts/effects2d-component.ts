import {
  defineComponent,
  rect,
  text,
  path,
  ellipse,
  group,
  linearGradient,
  waveWarp,
  twirl,
  bulge,
  rgbSplit,
  linearWipe,
  radialWipe,
  progress,
  node,
} from '@vmotion/sdk';
const cards = [
  { id: 'wave', name: '波形扭曲', detail: '相位驱动 · 局部方向' },
  { id: 'twirl', name: '旋转扭曲', detail: '半径衰减 · 中心控制' },
  { id: 'bulge', name: '膨胀与收缩', detail: '径向反向采样' },
  { id: 'rgb', name: 'RGB 分离', detail: '透明边缘 · 色散层叠' },
  { id: 'linear', name: '线性擦除', detail: '方向 / 羽化 / 进度' },
  { id: 'radial', name: '圆形展开', detail: '中心 / 羽化 / 进度' },
];
export default defineComponent({
  name: 'Planar effects',
  parameters: { strength: { type: 'number', default: 1, min: 0, max: 2 } },
  render(ctx, params) {
    const s = ctx.seconds,
      strength = params.strength,
      p = progress(ctx, { duration: 60, loop: true, yoyo: true }),
      nodes = [
        rect('background', {
          width: 1280,
          height: 720,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, [
            '#091322',
            '#12213b',
            '#071a2a',
          ]),
        }),
        text('label', 'VMOTION  /  PLANAR EFFECTS', {
          x: 44,
          y: 25,
          width: 1190,
          height: 28,
          fontSize: 18,
          fill: '#91a9c7',
        }),
        text('title', '组合平面特效，让画面拥有节奏', {
          x: 44,
          y: 67,
          width: 1190,
          height: 62,
          fontSize: 42,
          fontWeight: 700,
          fill: '#eff7ff',
        }),
        text('subtitle', '图层坐标 · 透明边缘 · 批量编辑 · 稳定特效 ID · 原生预检与导出', {
          x: 46,
          y: 134,
          width: 1190,
          height: 35,
          fontSize: 23,
          fill: '#96b0ce',
        }),
      ];
    for (const [i, card] of cards.entries()) {
      const x = 44 + (i % 3) * 401,
        y = 185 + Math.floor(i / 3) * 241,
        color = i % 2 ? '#ae98ff' : '#73e3d0';
      nodes.push(
        rect(`panel-${card.id}`, {
          x,
          y,
          width: 389,
          height: 227,
          radius: 14,
          fill: '#101e31',
          stroke: '#2d435f',
          strokeWidth: 1,
        }),
        text(`label-${card.id}`, card.name, {
          x: x + 18,
          y: y + 12,
          width: 354,
          height: 31,
          fontSize: 22,
          fill: color,
        }),
        text(`detail-${card.id}`, card.detail, {
          x: x + 18,
          y: y + 190,
          width: 354,
          height: 27,
          fontSize: 17,
          fill: '#91a9c7',
        }),
      );
      const children = [
        rect('base', {
          width: 348,
          height: 138,
          radius: 8,
          fill: '#162c47',
          stroke: '#375979',
          strokeWidth: 1,
        }),
      ];
      for (let j = 0; j < 10; j++)
        children.push(
          path(`grid-${j}`, `M ${j * 36} 0 V 138 M0 ${j * 16}H348`, {
            fill: 'transparent',
            stroke: '#2b4863',
            strokeWidth: 1,
          }),
        );
      children.push(
        ellipse('ring', {
          x: 23,
          y: 21,
          width: 95,
          height: 95,
          fill: 'transparent',
          stroke: color,
          strokeWidth: 5,
        }),
        path('arrow', 'M135 75H288 M270 55L290 75L270 95', {
          fill: 'transparent',
          stroke: color,
          strokeWidth: 5,
          strokeCap: 'round',
        }),
        text('word', 'VMOTION', {
          x: 142,
          y: 23,
          width: 190,
          height: 38,
          fontSize: 28,
          fontWeight: 700,
          fill: '#edf6ff',
        }),
      );
      const effect =
        card.id === 'wave'
          ? waveWarp({ amountX: 14 * strength, wavelength: 90, phase: s * 0.4 })
          : card.id === 'twirl'
            ? twirl({ radius: 140, amount: Math.sin(s * 0.9) * 110 * strength })
            : card.id === 'bulge'
              ? bulge({ radius: 150, amount: Math.sin(s) * 0.7 * strength })
              : card.id === 'rgb'
                ? rgbSplit({
                    amountX: (4 + Math.sin(s * 1.8) * 3) * strength,
                    amountY: 2 * strength,
                  })
                : card.id === 'linear'
                  ? linearWipe(p, { angle: 20, feather: 24 })
                  : radialWipe(p, { feather: 20 });
      nodes.push(
        node({
          id: `viewport-${card.id}`,
          type: 'group',
          x: x + 20,
          y: y + 45,
          width: 348,
          height: 138,
          clip: { x: 0, y: 0, width: 348, height: 138 },
        }),
      );
      const content = group(`sample-${card.id}`, children, {
        x: 0,
        y: 0,
        width: 348,
        height: 138,
        effects: [{ ...effect, id: `fx-${card.id}` }],
      });
      content[0].parentId = `viewport-${card.id}`;
      nodes.push(...content);
    }
    nodes.push(
      text(
        'footer',
        'effects_guide / effects_inspect / effects_plan · 复制/排序自动迁移键 · 预检 → 原子提交',
        { x: 46, y: 684, width: 1190, height: 27, fontSize: 17, fill: '#829dbd' },
      ),
    );
    return nodes;
  },
});
