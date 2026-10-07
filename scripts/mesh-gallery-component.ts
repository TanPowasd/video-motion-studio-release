import { defineComponent, scene3DLayer, text, rect, linearGradient } from '@vmotion/sdk';
const cards = [
  { id: 'sphere', label: '球体 / SPHERE', detail: '共享极点 · 连续接缝', color: '#68e0c4' },
  { id: 'torus', label: '圆环 / TORUS', detail: '双向闭合 · 参数化网格', color: '#ac9cff' },
  { id: 'cylinder', label: '圆柱 / CYLINDER', detail: '侧面与端盖 · 可调分段', color: '#6eaaff' },
  { id: 'cone', label: '圆锥 / CONE', detail: '单一顶点 · 正确面方向', color: '#ffa178' },
  {
    id: 'surface',
    label: '函数曲面 / SURFACE',
    detail: 'y = 0.35 sin(2x) cos(2z)',
    color: '#edd277',
  },
  { id: 'arch', label: 'OBJ 导入 / CONCAVE', detail: '凹轮廓三角化 · 保留空缺', color: '#f49aba' },
];
export default defineComponent({
  name: 'Mesh resources',
  parameters: { spin: { type: 'number', default: 28 } },
  render(ctx, params) {
    const nodes = [
      rect('background', {
        width: 1280,
        height: 720,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, [
          '#0b1524',
          '#121f32',
          '#0b1928',
        ]),
      }),
      text('label', 'VMOTION  /  REUSABLE MESHES', {
        x: 44,
        y: 26,
        width: 1190,
        height: 27,
        fontSize: 18,
        fill: '#91a9c7',
      }),
      text('title', '从数学形体，到可复用的三维模型', {
        x: 44,
        y: 67,
        width: 1190,
        height: 60,
        fontSize: 42,
        fontWeight: 700,
        fill: '#edf6ff',
      }),
      text('subtitle', '矩阵动画 · 本地 OBJ · 工程 JSON 资源 · 原生深度渲染 · 外部 agent', {
        x: 46,
        y: 133,
        width: 1190,
        height: 35,
        fontSize: 23,
        fill: '#97aec9',
      }),
    ];
    for (const [i, card] of cards.entries()) {
      const x = 44 + (i % 3) * 401,
        y = 185 + Math.floor(i / 3) * 241;
      nodes.push(
        rect(`panel-${card.id}`, {
          x,
          y,
          width: 389,
          height: 227,
          radius: 14,
          fill: '#111e30',
          stroke: '#2a405b',
          strokeWidth: 1,
        }),
        text(`name-${card.id}`, card.label, {
          x: x + 18,
          y: y + 14,
          width: 354,
          height: 31,
          fontSize: 21,
          fill: card.color,
        }),
        text(`detail-${card.id}`, card.detail, {
          x: x + 18,
          y: y + 190,
          width: 354,
          height: 27,
          fontSize: 16,
          fill: '#91a9c7',
        }),
      );
      const model = scene3DLayer(
        `mesh-${card.id}`,
        [
          {
            id: card.id,
            meshSource: `components/meshes/${card.id}.json`,
            color: card.color,
            transform: {
              rotation: {
                x: card.id === 'surface' ? 0 : Math.sin(ctx.seconds * 0.5) * 8,
                y: ctx.seconds * params.spin + (card.id === 'arch' ? -25 : 0),
                z: 0,
              },
            },
          },
        ],
        {
          position: { x: 3, y: 2, z: 4 },
          target: { x: 0, y: 0, z: 0 },
          width: 360,
          height: 164,
          fov: 40,
          near: 0.1,
          far: 100,
        },
        { ambient: 0.45, cullBackfaces: card.id !== 'arch' && card.id !== 'surface', samples: 4 },
      );
      model.x = x + 14;
      model.y = y + 33;
      model.clip = { x: 0, y: 0, width: 360, height: 164 };
      nodes.push(model);
    }
    nodes.push(
      text(
        'footer',
        'mesh_generate / mesh_import / mesh_inspect · 小型计划 ID · 预检 → 原子提交 → 一次撤销',
        { x: 46, y: 684, width: 1190, height: 27, fontSize: 17, fill: '#829dbd' },
      ),
    );
    return nodes;
  },
});
