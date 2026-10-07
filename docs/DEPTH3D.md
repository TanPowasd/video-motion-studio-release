# 原生深度场景与 agent 画面证据

`scene3DLayer(id, instances, camera, options)` 创建普通 `scene3d` 场景图层，数据保存为 JSON，也可由 TypeScript 每帧生成。它使用上一层矩阵/视锥裁剪结果，在 Rust 中逐采样点计算不透明面遮挡，正确绘制相互穿插的网格。没有原生运行时时使用相同的 TypeScript 栅格回退；实际测试比较两条路径的像素、深度和面 ID。

```ts
import { scene3DLayer, cubeMesh } from '@vmotion/sdk';
const box = cubeMesh(2);
// 可在 component.render(ctx) 中生成这一个节点。
const layer = scene3DLayer('world', [
  {id:'a',mesh:box,color:'#69dfc5',transform:{rotation:{x:20,y:40,z:0}}},
  {id:'b',mesh:box,color:'#ae94ff',transform:{position:{x:1,y:0,z:0},rotation:{x:-20,y:-40,z:0}}},
], {position:{x:5,y:3,z:7},target:{x:0,y:0,z:0},width:1280,height:720}, {samples:4,ambient:.3});
```

options 支持 samples=1/4、cullBackfaces、light、ambient 和整层 opacity。材质为不透明 #RRGGBB 面颜色，方向光照为平面着色。外层透明度、遮罩、效果栈和混合模式由同一合成核心应用；整层 opacity 不能替代世界内半透明材质。

格式可通过 `project_schema {name:"scene3d"}` 或 schemas/scene3d.schema.json 查询。agent 可用 project_preflight/project_apply 新建或修改包含 scene3d 的节点；相机 position/target/up/fov/near/far/orthographicHeight、instances.N.transform 的 position/rotation/scale/pivot、instances.N.matrix.K、options.light/ambient 支持数值关键帧。动画字段必须存在于数据中；数组顺序变化时应同步对应数值通道，当前没有 3D 专用数组重排接口。常量网格拓扑不发送到原生关键帧求值，避免逐帧重复传输大量顶点。

预览和导出按图层在目标画面的像素密度栅格化，最大 UHD 4K。深度缓冲是 16×16 分块，每块最多四个采样点；三角形分桶与裁剪后的覆盖预算有界。采样点遵守统一边规则，接缝不会重复填充或漏像素；相同深度用稳定 face ID 次序决定。NDC 深度在屏幕坐标中插值，检查用 eye depth 按 inverse W 做透视正确插值。

`scene3d_render` MCP 或 `vmotion scene3d-render --project ... --request request.json` 可检查原始场景或现有图层：

```json
{
  "source": {
    "sceneId": "intro",
    "nodeId": "component/world",
    "path": ["component"],
    "frame": 90,
    "contextFrames": []
  },
  "revision": "<project_context.revision>",
  "width": 640,
  "picks": [{"x":300,"y":180},{"x":340,"y":180}],
  "offset":0,
  "limit":100
}
```

直接检查新场景使用 `source:{scene:<scene3d-data>,id:"world"}`。工具返回三张 PNG（MCP 直接返回图片）：color、归一化 eye-depth、face-id。输出宽最多 1280、高最多 720，保持相机比例；pick 使用返回图片像素坐标。返回 backend、visiblePixels、depthRange、统计、分页面标签、每面的可见像素数，以及 pick 的实际 depth/coverage/稳定实例与面 ID。完整标签保存为 labels.json；face-id 图中 RGB 为 `index+1` 的低/中/高字节，0 为背景。index 只对这份证据有效，长期定位使用字符串 ID。抗锯齿边缘的颜色可能来自多个面，pick 的 ID/depth 代表最近的覆盖采样点。

这项检查只渲染当前 3D 图层的本地画面，不包含外层变换、遮罩、效果及其他序列图层。最终构图仍用 frame_capture/project_preflight 检查。选框采用投影几何实际边界，视觉审计会标记 depth-raster 不确定性，不把几何覆盖误当成最终像素遮挡。

CPU 原生深度管线已覆盖不透明网格、矩阵层级、相机、裁剪、平面/平滑法线、金属度/粗糙度直接光照、抗锯齿与帧确定性。材质详见 MATERIALS3D.md；贴图、环境反射、世界内透明材质、阴影和 GPU 尚未实现。大场景可降低预览分辨率。三角形覆盖超过预算返回 RASTER3D_WORK_LIMIT，超大 IPC 请求返回 NATIVE_INPUT_LIMIT。

`examples/depth3d-lab` 包含整面排序和深度缓冲的同画面对照、穿插立方体、可编辑 speed/angle 参数。示例生成五帧图片、agent color/depth/ID 证据和 8 秒 1280×720/30fps 导出。普通 PNG 导出与同帧预览逐像素一致；乱序帧、逆序三角形、原生/回退、一点/四点抗锯齿和近裁剪均有测试。
