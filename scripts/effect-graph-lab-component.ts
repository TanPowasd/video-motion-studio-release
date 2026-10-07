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
  name: '特效节点图实验台',
  parameters: { strength: { type: 'number', default: 1, min: 0, max: 1 } },
  render(ctx, params) {
    const nodes = [
        text('title', '可编程特效节点图', {
          x: 44,
          y: 25,
          width: 1140,
          height: 60,
          fontSize: 38,
          fontWeight: 700,
          fill: '#eaf1ff',
        }),
        text('subtitle', '分支 → 混合 / 图层输入 → 遮罩 / 噪声 → 置换 / 子图复用', {
          x: 45,
          y: 82,
          width: 1140,
          height: 34,
          fontSize: 18,
          fill: '#819cbd',
        }),
      ],
      s = Number(params.strength),
      t = ctx.seconds;
    const card = (
      id: string,
      title: string,
      detail: string,
      x: number,
      y: number,
      content: ReturnType<typeof node>[],
    ) => {
      nodes.push(
        rect(id + '-bg', { x, y, width: 572, height: 250, radius: 12, fill: '#17243b' }),
        text(id + '-label', title, {
          x: x + 20,
          y: y + 14,
          width: 532,
          height: 36,
          fontSize: 22,
          fontWeight: 700,
          fill: '#dbeaff',
        }),
        ...group(id, content, {
          x: x + 20,
          y: y + 55,
          width: 532,
          height: 150,
          clip: { x: 0, y: 0, width: 532, height: 150 },
        }),
        text(id + '-detail', detail, {
          x: x + 20,
          y: y + 215,
          width: 532,
          height: 26,
          fontSize: 13,
          fill: '#7c95b5',
        }),
      );
    };
    card(
      'branch',
      '01 / 分支合成',
      '源图层 → 高光分支 → 错位混合',
      44,
      124,
      group(
        'sample',
        [
          text('word', 'VMOTION', {
            x: 0,
            y: 0,
            width: 400,
            height: 110,
            fontSize: 59,
            fontWeight: 700,
            fill: '#bddaff',
          }),
        ],
        {
          x: 70,
          y: 30,
          width: 400,
          height: 100,
          effects: [
            effectGraph('components/effects/branch.json', {
              radius: 7 * s,
              offset: 5 + 7 * Math.sin(t * 2) * s,
            }),
          ],
        },
      ),
    );
    card('mask', '02 / 图层输入与遮罩', '命名输入绑定同级图层，使用其真实像素', 664, 124, [
      ...group(
        'sample',
        [
          rect('gradient', {
            width: 430,
            height: 110,
            gradient: linearGradient({ x: 0, y: 0 }, { x: 430, y: 110 }, [
              '#347ef4',
              '#a874e5',
              '#6fdbdf',
            ]),
          }),
        ],
        {
          x: 50,
          y: 20,
          width: 430,
          height: 110,
          effects: [effectGraph('components/effects/mask.json', {}, { matte: 'matte' })],
        },
      ),
      text('matte', 'HELLO GRAPH', {
        x: 50,
        y: 30,
        width: 430,
        height: 110,
        fontSize: 48,
        fontWeight: 700,
        fill: '#fff',
      }),
      rect('carrier', { opacity: 0, maskId: 'matte' }),
    ]);
    card(
      'displace',
      '03 / 可编程置换',
      '程序噪声分支 → 双通道采样 → 原始纹理',
      44,
      408,
      group(
        'sample',
        [
          rect('base', {
            width: 400,
            height: 100,
            gradient: linearGradient({ x: 0, y: 0 }, { x: 400, y: 100 }, ['#235b99', '#806cdf']),
          }),
          ...Array.from({ length: 14 }, (_, i) =>
            rect('stripe' + i, {
              x: i * 30,
              y: 0,
              width: 4,
              height: 100,
              fill: '#b7dbff',
              opacity: 0.45,
            }),
          ),
          text('word', 'MAP → PIXELS', {
            x: 24,
            y: 25,
            width: 360,
            height: 70,
            fontSize: 35,
            fontWeight: 700,
            fill: '#e8f1ff',
          }),
        ],
        {
          x: 65,
          y: 28,
          width: 400,
          height: 100,
          effects: [
            effectGraph('components/effects/warp.json', { evolution: t * 0.35, amount: 16 * s }),
          ],
        },
      ),
    );
    card(
      'nested',
      '04 / 参数连线与子图',
      '共享子图 · 独立实例参数 · 原生关键帧',
      664,
      408,
      group(
        'sample',
        [
          ellipse('ring', {
            x: 45,
            y: 8,
            width: 95,
            height: 95,
            fill: 'transparent',
            stroke: '#a9ceff',
            strokeWidth: 6,
          }),
          text('word', 'REUSE', {
            x: 150,
            y: 16,
            width: 240,
            height: 85,
            fontSize: 52,
            fontWeight: 700,
            fill: '#b4a9f4',
          }),
        ],
        {
          x: 55,
          y: 24,
          width: 420,
          height: 110,
          effects: [
            effectGraph('components/effects/nested.json', {
              opacity: 0.45 + 0.25 * Math.sin(t * 2),
              shift: 12 * s,
            }),
          ],
        },
      ),
    );
    nodes.push(
      text('footer', 'VMOTION / JSON 节点图 · 外部 Agent 编排 · 固定版本渲染', {
        x: 44,
        y: 686,
        width: 1140,
        height: 24,
        fontSize: 12,
        fill: '#6d87a6',
      }),
    );
    return nodes;
  },
});
