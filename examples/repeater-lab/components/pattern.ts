import {
  defineComponent,
  rect,
  ellipse,
  text,
  path,
  group,
  repeatGraph,
  repeatGrid,
  repeatRadial,
  affineMatrix,
  tween,
  progress,
  type Node,
} from '@vmotion/sdk';
export default defineComponent({
  name: '程序化重复实验室',
  parameters: { accent: { type: 'color', default: '#73e5d2', label: '主色' } },
  render(ctx, params) {
    const t = ctx.seconds,
      accent = params.accent,
      nodes: Node[] = [
        rect('background', { width: 1920, height: 1080, fill: '#0b121e' }),
        text('eyebrow', 'VMOTION / PROCEDURAL REPEAT', {
          x: 72,
          y: 45,
          width: 1700,
          height: 34,
          fontSize: 22,
          fill: '#839bb7',
        }),
        text('title', '一个图层，变成一个系统', {
          x: 72,
          y: 96,
          width: 1760,
          height: 83,
          fontSize: 62,
          fontWeight: 700,
          fill: '#f2f7ff',
        }),
        text('subtitle', '线性 · 网格 · 放射 · 斜切组合 · 可编辑的每个副本', {
          x: 76,
          y: 187,
          width: 1740,
          height: 46,
          fontSize: 28,
          fill: '#9eb6d2',
        }),
      ];
    const cards = [
      { x: 72, title: 'LINEAR / 递进阵列', color: accent },
      { x: 676, title: 'GRID / 稳定网格', color: '#f9b889' },
      { x: 1280, title: 'RADIAL / 放射运动', color: '#b7a5ff' },
    ];
    for (const [i, card] of cards.entries())
      nodes.push(
        ...group(
          `panel-${i}`,
          [
            rect('card', {
              width: 568,
              height: 468,
              radius: 20,
              fill: '#142031',
              stroke: '#2a3c52',
              strokeWidth: 1,
            }),
            text('label', card.title, {
              x: 30,
              y: 25,
              width: 508,
              height: 42,
              fontSize: 25,
              fill: card.color,
            }),
          ],
          { x: card.x, y: 269, width: 568, height: 468 },
        ),
      );
    const linear = repeatGraph(
      'linear',
      ({ index }) => [
        rect('tile', {
          width: 54,
          height: 142,
          radius: 9,
          fill: accent,
          opacity: 0.75 + 0.25 * Math.sin(t + index * 0.4),
        }),
        path('line', 'M10 20H44', { fill: 'transparent', stroke: '#edfaff', strokeWidth: 2 }),
      ],
      {
        count: 7,
        position: { x: 63, y: 0 },
        rotation: Math.sin(t * 0.8) * 1.8,
        scale: { x: 0.97, y: 0.97 },
        pivot: { x: 27, y: 71 },
        skew: Math.sin(t) * 1.8,
      },
    );
    nodes.push(...group('linear-anchor', linear, { x: 125, y: 480, width: 468, height: 230 }));
    nodes.push(
      ...group(
        'grid-anchor',
        repeatGrid(
          'grid',
          ({ index }) =>
            [
              ellipse('dot', {
                width: 36,
                height: 36,
                fill: index % 3 ? '#f9b889' : '#fff0dc',
                scaleX: 1 + 0.15 * Math.sin(t * 2 + index * 0.4),
                scaleY: 1 + 0.15 * Math.sin(t * 2 + index * 0.4),
                originX: 18,
                originY: 18,
              }),
            ] as Node[],
          { count: 25, columns: 5, gap: { x: 62, y: 57 } },
        ),
        { x: 803, y: 410, width: 325, height: 300 },
      ),
    );
    nodes.push(
      ...group(
        'radial-anchor',
        repeatRadial(
          'radial',
          [rect('petal', { x: -32, y: -10, width: 64, height: 20, radius: 10, fill: '#b7a5ff' })],
          {
            count: tween(ctx, 7, 15, { duration: 150, loop: true, yoyo: true }),
            radius: 120 + 12 * Math.sin(t * 1.5),
            angleStep: 24,
            angleStart: t * 22,
            orientation: 'radial',
            startOpacity: 0.9,
            endOpacity: 0.55,
          },
        ),
        { x: 1564, y: 545, width: 360, height: 360 },
      ),
    );
    nodes.push(
      ...group(
        'affine-panel',
        [
          rect('card', {
            width: 1776,
            height: 248,
            radius: 20,
            fill: '#142031',
            stroke: '#2a3c52',
            strokeWidth: 1,
          }),
          text('label', 'AFFINE / 非均匀缩放 + 斜切 + 旋转', {
            x: 30,
            y: 24,
            width: 1100,
            height: 45,
            fontSize: 25,
            fill: '#9cbeed',
          }),
          ...group(
            'tiles',
            repeatGraph(
              'panels',
              ({ index }) => [
                rect('shape', {
                  x: -45,
                  y: -45,
                  width: 90,
                  height: 90,
                  radius: 8,
                  fill: index % 2 ? '#7fa9f4' : accent,
                }),
                path('diagonal', 'M-30 30L30 -30', {
                  fill: 'transparent',
                  stroke: '#ecf5ff',
                  strokeWidth: 3,
                }),
              ],
              {
                count: 8,
                position: { x: 190, y: 0 },
                rotation: Math.sin(t) * 3,
                scale: { x: 0.96, y: 1 },
                skew: Math.sin(t * 0.7) * 2,
                pivot: { x: 0, y: 0 },
              },
            ),
            { x: 130, y: 148, matrix: affineMatrix({ skew: Math.sin(t * 0.7) * 12 }) },
          ),
        ],
        { x: 72, y: 775, width: 1776, height: 248 },
      ),
    );
    nodes.push(
      text('footer', '稳定副本 ID · 原生仿射矩阵 · 独立属性覆盖 · SDK / CLI / MCP', {
        x: 76,
        y: 1040,
        width: 1760,
        height: 31,
        fontSize: 20,
        fill: '#718ba9',
        opacity: progress(ctx, { duration: 15 }),
      }),
    );
    return nodes;
  },
});
