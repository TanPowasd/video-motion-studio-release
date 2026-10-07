import {
  defineComponent,
  scene3D,
  cubeMesh,
  mat4Compose,
  prepareCamera3D,
  text,
  rect,
  group,
  linearGradient,
  type MeshInstance3D,
} from '@vmotion/sdk';
const cube = cubeMesh(1),
  empty = { vertices: [], faces: [] },
  ground = {
    vertices: Array.from({length:121},(_,i)=>({x:-4+(i%11)*.8,y:-1.4,z:-4+Math.floor(i/11)*.8})),
    faces: Array.from({length:100},(_,i)=>{const a=Math.floor(i/10)*11+i%10;return[a,a+11,a+12,a+1];}),
  };
export default defineComponent({
  name: '矩阵驱动的三维画面',
  parameters: { spin: { type: 'number', default: 35 }, orbit: { type: 'number', default: 22 } },
  render(ctx, params) {
    const objects: MeshInstance3D[] = [
        { id: 'ground', mesh: ground, color: '#20384d' },
        {
          id: 'center',
          mesh: cube,
          transform: {
            position: { x: 0, y: 0.1, z: 0 },
            rotation: {
              x: 18 + Math.sin(ctx.seconds * 0.5) * 15,
              y: ctx.seconds * params.spin,
              z: 12,
            },
            scale: { x: 1.8, y: 1.8, z: 1.8 },
          },
          color: '#63d8c0',
        },
        {
          id: 'orbit',
          mesh: empty,
          transform: { rotation: { x: 0, y: ctx.seconds * params.orbit, z: 0 } },
        },
        ...Array.from({ length: 8 }, (_, i) => ({
          id: `satellite-${i}`,
          parentId: 'orbit',
          mesh: cube,
          color: i % 2 ? '#9b8dff' : '#6aaaff',
          transform: {
            position: {
              x: 2.7 * Math.cos((i * Math.PI) / 4),
              y: -0.65 + 0.2 * Math.sin(ctx.seconds + i),
              z: 2.7 * Math.sin((i * Math.PI) / 4),
            },
            rotation: { x: ctx.seconds * 18 + i * 13, y: ctx.seconds * 27, z: i * 15 },
            scale: { x: 0.55, y: 0.55, z: 0.55 },
          },
        })),
      ],
      camera = {
        position: { x: 5 + Math.sin(ctx.seconds * 0.4), y: 3.4, z: 7 },
        target: { x: 0, y: -0.15, z: 0 },
        width: 540,
      height: 370,
        fov: 53,
        near: 0.25,
        far: 40,
      },
      nodes = [
        rect('background', {
          width: 1280,
          height: 720,
          gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, [
            '#07111e',
            '#122039',
            '#071724',
          ]),
        }),
        text('eyebrow', 'VMOTION  /  MATRIX 3D', {
          x: 50,
          y: 24,
          width: 1180,
          height: 28,
          fontSize: 18,
          fill: '#90a8c5',
        }),
        text('title', '一条矩阵链，构建整个三维画面', {
          x: 50,
          y: 63,
          width: 1180,
          height: 66,
          fontSize: 43,
          fontWeight: 700,
          fill: '#eef5ff',
        }),
        text('chain', '顶点  →  Model  →  View  →  Projection  →  裁剪  →  屏幕', {
          x: 52,
          y: 133,
          width: 1180,
          height: 38,
          fontSize: 23,
          fill: '#91abc8',
        }),
        rect('perspective-panel', {
          x: 40,
          y: 187,
          width: 580,
          height: 434,
          radius: 16,
          fill: '#0c1828',
          stroke: '#2b425d',
          strokeWidth: 1,
        }),
        rect('orthographic-panel', {
          x: 660,
          y: 187,
          width: 580,
          height: 434,
          radius: 16,
          fill: '#0c1828',
          stroke: '#2b425d',
          strokeWidth: 1,
        }),
        text('perspective-label', '透视投影 / 距离越远，画面越小', {
          x: 64,
          y: 203,
          width: 520,
          height: 32,
          fontSize: 20,
          fill: '#c8dcf3',
        }),
        text('orthographic-label', '正交投影 / 远近保持相同尺度', {
          x: 684,
          y: 203,
          width: 520,
          height: 32,
          fontSize: 20,
          fill: '#c8dcf3',
        }),
      ];
    nodes.push(
      ...group(
        'perspective',
        scene3D('world', objects, camera, {
          light: { x: -0.4, y: 0.8, z: 1 },
          ambient: 0.28,
          stroke: '#142333',
          strokeWidth: 0.8,
        }),
        { x: 60, y: 242, width: 540, height: 370, clip:{x:0,y:0,width:540,height:370} },
      ),
      ...group(
        'orthographic',
        scene3D(
          'world',
          objects,
          { ...camera, projection: 'orthographic', orthographicHeight: 6.4 },
          { light: { x: -0.4, y: 0.8, z: 1 }, ambient: 0.28, stroke: '#142333', strokeWidth: 0.8 },
        ),
        { x: 680, y: 242, width: 540, height: 370, clip:{x:0,y:0,width:540,height:370} },
      ),
    );
    const model = mat4Compose(objects[1].transform),
      projection = prepareCamera3D(camera);
    nodes.push(
      text(
        'model',
        'M / ' +
          model
            .slice(0, 4)
            .map((v) => v.toFixed(2))
            .join('  '),
        { x: 50, y: 642, width: 590, height: 29, fontSize: 18, fill: '#6ddfc8' },
      ),
      text(
        'projection',
        'P / ' +
          projection.projection
            .slice(0, 4)
            .map((v) => v.toFixed(2))
            .join('  '),
        { x: 676, y: 642, width: 580, height: 29, fontSize: 18, fill: '#b1a3ff' },
      ),
      text(
        'footer',
        '父子矩阵 · 批量顶点 · 六面视锥裁剪 · 背面剔除 · 平面光照 · 全局深度排序 · SDK / MCP',
        { x: 50, y: 684, width: 1180, height: 27, fontSize: 17, fill: '#90a8c5' },
      ),
    );
    return nodes;
  },
});
