import { defineComponent, node, linearGradient, type Node } from '@vmotion/sdk';
export default defineComponent({
  name: '像素检查实验室',
  parameters: {},
  render(ctx) {
    const t = ctx.seconds,
      nodes: Node[] = [
        node({
          id: 'title',
          type: 'text',
          text: '颜色 · 差分 · 图层影响',
          x: 48,
          y: 36,
          width: 1184,
          height: 60,
          fontSize: 42,
          fill: '#eef4ff',
          fontWeight: 700,
        }),
        node({
          id: 'subtitle',
          type: 'text',
          text: '原生画面证据 / 可编辑组件 / 外部 Agent 精确候选',
          x: 50,
          y: 104,
          width: 1180,
          height: 34,
          fontSize: 22,
          fill: '#8ca7c8',
        }),
        node({
          id: 'footer',
          type: 'text',
          text: '稳定时钟与 ID · 检查不写源码 · 数字描述差异，画面承载判断',
          x: 50,
          y: 662,
          width: 1180,
          height: 35,
          fontSize: 22,
          fill: '#91a6c6',
        }),
      ];
    for (let i = 0; i < 3; i++)
      nodes.push(
        node({
          id: 'panel-' + i,
          type: 'rect',
          x: 48 + i * 400,
          y: 164,
          width: 384,
          height: 466,
          fill: '#152339',
          radius: 18,
        }),
      );
    const labels = ['SDR 颜色分布', '遮罩后的合成', '纯函数动画与候选'];
    labels.forEach((text, i) =>
      nodes.push(
        node({
          id: 'label-' + i,
          type: 'text',
          text,
          x: 70 + i * 400,
          y: 187,
          width: 344,
          height: 40,
          fontSize: 25,
          fill: '#dbe8ff',
        }),
      ),
    );
    const colors = ['#df637c', '#f2c76d', '#72c6ac', '#739cfa', '#a78de0'];
    for (let i = 0; i < colors.length; i++)
      nodes.push(
        node({
          id: 'bar-' + i,
          type: 'rect',
          x: 76 + i * 64,
          y: 280,
          width: 46,
          height: 220,
          fill: colors[i],
          animations: [
            {
              property: 'height',
              keys: [
                { frame: 0, value: 55 + i * 24, easing: 'easeInOut' },
                { frame: 90, value: 180 - i * 16, easing: 'easeInOut' },
                { frame: 179, value: 55 + i * 24, easing: 'linear' },
              ],
            },
          ],
        }),
      );
    nodes.push(
      node({
        id: 'ramp',
        type: 'rect',
        x: 76,
        y: 525,
        width: 322,
        height: 46,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 322, y: 0 }, ['#070b13', '#edf2fa']),
      }),
      node({
        id: 'mask',
        type: 'ellipse',
        x: 485,
        y: 294,
        width: 280,
        height: 240,
        fill: '#ffffff',
      }),
      node({
        id: 'masked',
        type: 'rect',
        x: 470,
        y: 280,
        width: 340,
        height: 280,
        maskId: 'mask',
        gradient: linearGradient({ x: 0, y: 0 }, { x: 340, y: 280 }, [
          '#618fe8',
          '#b591e8',
          '#eac77e',
        ]),
      }),
      node({
        id: 'covered',
        type: 'rect',
        x: 500,
        y: 360,
        width: 190,
        height: 100,
        fill: '#ff697d',
      }),
      node({ id: 'cover', type: 'rect', x: 500, y: 360, width: 190, height: 100, fill: '#142f4a' }),
      node({
        id: 'cover-label',
        type: 'text',
        text: '底层被覆盖',
        x: 515,
        y: 390,
        width: 175,
        height: 36,
        fontSize: 23,
        fill: '#d3e4fb',
      }),
      node({
        id: 'moving',
        type: 'rect',
        x: 1010 + Math.sin(t * 1.5) * 50,
        y: 382 + Math.cos(t * 1.1) * 45,
        width: 90,
        height: 90,
        originX: 45,
        originY: 45,
        rotation: t * 45,
        fill: '#7bd8bb',
        radius: 12,
      }),
    );
    for (let i = 0; i < 18; i++) {
      const a = (i / 18) * Math.PI * 2 + t * 0.35;
      nodes.push(
        node({
          id: 'orbit-' + i,
          type: 'ellipse',
          x: 1040 + Math.cos(a) * 115,
          y: 415 + Math.sin(a) * 105,
          width: 8,
          height: 8,
          fill: i % 2 ? '#789ff2' : '#b592e7',
          opacity: 0.7,
        }),
      );
    }
    nodes.push(
      node({
        id: 'hint-1',
        type: 'text',
        text: '逐像素统计 / 透明度权重',
        x: 475,
        y: 581,
        width: 336,
        height: 32,
        fontSize: 19,
        fill: '#879fbe',
      }),
      node({
        id: 'hint-2',
        type: 'text',
        text: '重复同帧 / 检查状态漂移',
        x: 870,
        y: 581,
        width: 336,
        height: 32,
        fontSize: 19,
        fill: '#879fbe',
      }),
    );
    return nodes;
  },
});
