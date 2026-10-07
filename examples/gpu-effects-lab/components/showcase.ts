import { defineComponent, node, linearGradient, defineEffectGraph, type Node } from '@vmotion/sdk';
const matrix = [
  0.86, 0.04, 0.02, 0, 0.02, 0.012, 0.94, 0.018, 0, 0.012, 0.01, 0.03, 0.91, 0, 0.016, 0, 0, 0, 1,
  0,
];
const graph = defineEffectGraph({
  kind: 'effect-graph',
  version: 1,
  name: 'Eight-stage hardware grade',
  nodes: [
    { id: 'source', type: 'input' },
    ...Array.from({ length: 8 }, (_, i) => ({
      id: 'grade-' + i,
      type: 'colorMatrix' as const,
      input: i ? 'grade-' + (i - 1) : 'source',
      matrix,
    })),
  ],
  output: 'grade-7',
});
export default defineComponent({
  name: 'GPU effects showcase',
  parameters: {},
  render(ctx) {
    const t = ctx.seconds,
      nodes: Node[] = [
        node({
          id: 'title',
          type: 'text',
          text: 'GPU 逐像素特效',
          x: 54,
          y: 38,
          width: 1170,
          height: 70,
          fontSize: 48,
          fontWeight: 700,
          fill: '#edf4ff',
        }),
        node({
          id: 'subtitle',
          type: 'text',
          text: 'Direct3D12 · 连续节点合并 · 二进制传输 · 有界缓冲',
          x: 58,
          y: 119,
          width: 1160,
          height: 40,
          fontSize: 24,
          fill: '#96acce',
        }),
        node({
          id: 'left-panel',
          type: 'rect',
          x: 54,
          y: 182,
          width: 548,
          height: 448,
          fill: '#142239',
          radius: 18,
        }),
        node({
          id: 'right-panel',
          type: 'rect',
          x: 626,
          y: 182,
          width: 600,
          height: 448,
          fill: '#142239',
          radius: 18,
        }),
        node({
          id: 'left-title',
          type: 'text',
          text: '原始渐变与动画',
          x: 78,
          y: 201,
          width: 500,
          height: 40,
          fontSize: 25,
          fill: '#deebfd',
        }),
        node({
          id: 'right-title',
          type: 'text',
          text: '8 层颜色矩阵 · 一次 GPU dispatch',
          x: 650,
          y: 201,
          width: 550,
          height: 40,
          fontSize: 25,
          fill: '#deebfd',
        }),
        node({
          id: 'footer',
          type: 'text',
          text: '同一时钟与源码 · 透明边缘舍入修正 · CPU 保留 · 性能由实际场景决定',
          x: 57,
          y: 664,
          width: 1160,
          height: 32,
          fontSize: 21,
          fill: '#859cbb',
        }),
      ];
    for (const [i, x] of [80, 652].entries()) {
      const id = i ? 'graded' : 'source';
      nodes.push(
        node({
          id,
          type: 'group',
          x,
          y: 268,
          width: 520,
          height: 300,
          effects: i
            ? [{ id: 'gpu-graph', type: 'effectGraph', graph, params: {}, bindings: {} }]
            : [],
        }),
      );
      nodes.push(
        node({
          id: id + '-background',
          parentId: id,
          type: 'rect',
          width: 520,
          height: 300,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 520, y: 300 }, [
            '#344d93',
            '#ab7ddb',
            '#eea991',
          ]),
        }),
      );
      for (let k = 0; k < 10; k++) {
        const phase = t * 1.2 + k * 0.5;
        nodes.push(
          node({
            id: id + '-shape-' + k,
            parentId: id,
            type: k % 2 ? 'ellipse' : 'rect',
            x: 40 + k * 43 + Math.sin(phase) * 16,
            y: 100 + Math.cos(phase) * 58,
            width: 48,
            height: 62,
            originX: 24,
            originY: 31,
            rotation: Math.sin(phase) * 30,
            fill: k % 2 ? '#7ee0b4' : '#a5bdf5',
            opacity: 0.7 + k * 0.025,
            radius: 8,
          }),
        );
      }
      nodes.push(
        node({
          id: id + '-note',
          type: 'text',
          text: i ? '颜色与透明度统一求值' : '纯函数 · 可随机跳帧',
          x,
          y: 587,
          width: 520,
          height: 29,
          fontSize: 20,
          fill: '#90aac9',
        }),
      );
    }
    return nodes;
  },
});
