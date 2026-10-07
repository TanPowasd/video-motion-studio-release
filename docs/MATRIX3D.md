# 用矩阵制作 3D 画面

SDK 使用统一矩阵链 `clip = Projection × View × Model × [x,y,z,1]`。相机矩阵每帧准备一次，父子世界矩阵每个物体缓存一次，批量投影顶点后生成原生场景路径。预览和导出使用相同结果。

需要准确的穿插遮挡时使用 `scene3DLayer`。它输出可保存的 `scene3d` 图层，由 Rust 逐采样点深度测试；`scene3D` 继续输出可分别编辑的矢量面。两者使用同一矩阵/裁剪/光照求值，详见 [原生深度场景](DEPTH3D.md)。

球体、圆柱、圆环、函数曲面及 OBJ 模型可通过 SDK/mesh_generate/mesh_import 创建并引用工程 JSON 资源；详见 [网格资源](MESHES.md)。

| 接口 | 用途 |
|---|---|
| mat4Identity / mat4Multiply / mat4Inverse | 16 项 4×4 矩阵及组合/求逆 |
| mat4Compose | 平移、XYZ 欧拉旋转、缩放和枢轴，T·Rz·Ry·Rx·S·T(-pivot) |
| mat4LookAt / mat4Perspective / mat4Orthographic | 视图、透视与正交投影 |
| prepareCamera3D | 复用相机矩阵；projectPoints 返回屏幕位置、深度、比例、clip 坐标和视锥可见性 |
| project3DBatch | 一次调用批量投影 |
| cubeMesh | 带一致面顶点方向的立方体 |
| scene3D / mesh3D | 层级网格、裁剪、剔除、平面光照与全局深度排序，输出稳定 ID 的原生 path 图层 |
| evaluateScene3D | 同一计算，附矩阵、面几何、数量统计和实际屏幕 bounds |

世界为右手坐标系，Y 向上；矩阵按行保存，作用于列向量。相机视图沿 -Z 看，近远裁剪面 NDC Z 为 -1/1；屏幕 Y 向下。旋转单位为度，A×B 先应用 B 再应用 A。Model 必须为仿射矩阵，投影交给相机。

```ts
import { defineComponent, cubeMesh, scene3D } from '@vmotion/sdk';
const cube = cubeMesh(2);
export default defineComponent({name:'Matrix world',parameters:{},render(ctx){
  return scene3D('world', [
    {id:'parent',mesh:{vertices:[],faces:[]},transform:{rotation:{x:0,y:ctx.seconds*30,z:0}}},
    {id:'cube',parentId:'parent',mesh:cube,color:'#69b7ff',transform:{position:{x:1,y:0,z:0}}},
  ], {
    position:{x:5,y:3,z:7},target:{x:0,y:0,z:0},
    width:ctx.width,height:ctx.height,fov:50,near:.1,far:100,
  }, {light:{x:-.4,y:.8,z:1},ambient:.3});
}});
```

面使用逆时针朝外的顶点顺序，应为凸、共面多边形；复杂面先三角化。六个齐次视锥平面裁剪多边形，跨越 near 的面保留可见部分。平面光照用世界顶点叉积计算法线，支持非均匀缩放。层级缺失/循环、错误索引、非有限矩阵和相机退化均返回错误码。面 ID 为 `world/<instance>/face-N`，可用普通组件覆盖、关键帧和截图工具操作。

旧 project3D 保留深度可见性规则；新批量投影的 visible 表示完整视锥判断。许多点应使用 prepareCamera3D/project3DBatch，避免每点重建相机。

外部 agent 使用 MCP `matrix3d {request:{operation,...}}`，或 `vmotion matrix3d --request matrix.json`（文件为内部 request）：compose 传 transform，multiply 传 a/b，inverse 传 matrix；project 传 camera/points/可选 model；scene 传 camera/instances/options，返回矩阵、stats、bounds 和分页面信息。includeGeometry 加点坐标，includeNodes 加原生路径；默认 limit=50，上限 200。

先用 `agent_guide {topic:"3d"}` 获取工作流，再编写组件，用 project_preflight 检查极端旋转、镜头运动与近裁剪帧，通过后提交同一候选。

`scene3D` 的矢量输出按 Painter 排序，不能准确处理互相穿插的多边形；`scene3DLayer` 的原生深度输出解决不透明面的穿插遮挡。目前没有贴图、PBR、阴影贴图或完整三维资产导入，不能视为完整电影级 3D 引擎。单场景预算为 100000 顶点、5000 输入面。

`examples/matrix3d-lab` 使用层级矩阵、八个环绕物体、中央旋转立方体、地面、双相机和平面光照。导出为 10 秒 1280×720/30fps 的 exports/matrix3d-demo.mp4，五帧重复渲染检查通过。exports/benchmark.json 记录 5000 点逐点/批量投影的本机测量及坐标误差；耗时不作为跨设备性能承诺。
