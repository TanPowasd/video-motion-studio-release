# 三维网格与 OBJ 资源

网格以可编辑 JSON 保存于 `components/meshes/*.json`，格式标记 `kind:mesh3d, version:1`。同一资源可供多个场景、组件或实例引用；`meshSource` 在固定工程快照中解析，导出不会临时读取外部 OBJ 或变化中的磁盘文件。可用 project_schema 的 mesh 查询格式。

SDK 提供 sphereMesh、cylinderMesh、coneMesh、torusMesh、planeMesh、surfaceMesh、meshBounds3D、normalizeMesh、transformMesh、inspectMesh、parseOBJ。球体共享极点与接缝，圆柱/圆锥可调半径、高度和分段，圆环双向闭合，surfaceMesh 将纯函数 `y=f(x,z)` 转换为三角网格；法线按右手系/Y 向上生成。

transformMesh 烘焙反射时修正面方向；实例负缩放也保持正确的外侧剔除与光照。

```ts
import { defineComponent, scene3DLayer, sphereMesh, surfaceMesh } from '@vmotion/sdk';
const sphere = sphereMesh(1, {widthSegments:24,heightSegments:12});
export default defineComponent({name:'Geometry',parameters:{},render(ctx){
  return [scene3DLayer('world', [
    {id:'sphere',mesh:sphere,color:'#69dfc5'},
    {id:'surface',mesh:surfaceMesh((x,z)=>.3*Math.sin(x+ctx.seconds)*Math.cos(z)),color:'#e5c770'},
  ], {position:{x:5,y:3,z:7},target:{x:0,y:0,z:0},width:ctx.width,height:ctx.height})];
}});
```

复用工程资源时，实例使用 `{id:'model',meshSource:'components/meshes/model.json'}`，不同时提供 mesh。也可从 TypeScript 导入 JSON 并传 model.mesh；该导入同样固定到工程版本。源码可直接修改资源，引用实例同步采用新版本；位置/旋转/缩放等仍属于实例。

外部 agent 的三个接口均可通过 tool_call 调用：

| 工具 | 输入/作用 |
|---|---|
| mesh_generate | primitive.kind 为 box/sphere/cylinder/cone/torus/plane；生成资源候选，可选择 normalizeSize、目标 file 和 place |
| mesh_import | path 或 text 二选一，UTF-8 OBJ；对象/分组筛选、materials 颜色映射、可选 sourceHash 检查及 place |
| mesh_inspect | source.file 或 source.mesh；边界、面积、体积、拓扑和分页面数据，includeVertices 按需取顶点 |

place 支持 sceneId、path/contextFrames、frame、nodeId、instanceId、实例 transform、color、x/y、width/height、camera、ambient、samples 和 cullBackfaces。省略 camera 时按变换后的模型边界适配相机；放置可进入普通场景、图层组或代码组件，保存到普通 JSON/生成结构中。原始源码保留。

```json
{
  "name":"mesh_generate",
  "arguments":{
    "primitive":{"kind":"torus","radius":1,"tube":0.3},
    "file":"components/meshes/ring.json",
    "place":{"sceneId":"intro","nodeId":"ring-layer","color":"#ac9cff"}
  }
}
```

这两个创作工具先返回候选，不修改工程/撤销历史。默认 delivery=stored 把精确操作保存到有 SHA-256 内容检查的本地缓存，返回 `candidate:{planId}` 和 `apply:{planId,expectedCandidateRevision}`；调用 project_preflight 检查候选画面，再原样 project_apply，资源和图层共享一次撤销。不会把大量顶点反复放进 agent 上下文。delivery=inline 可返回完整 operations，供自由代码组合和修改。

planId 固定资源内容、操作、基础 revision 与素材检查；不允许覆盖这些字段。采样/分辨率/输出选项可覆盖。改变内容应生成新候选；计划内容被改动、缺失或工程版本过期时提交失败。新文件默认 expectedHash=null，覆盖已有文件必须显式提供当前 hash。缓存位于 `.vmotion/agent-plans`，不是工程源码，打包与迁移不依赖它。

OBJ 支持 v/vt/vn、正/负索引、f、o/g/usemtl、可选物体/分组筛选。凹共面简单多边形使用耳切三角化，保留轮廓缺口；自交、退化、非共面面、非法索引返回源文件/行号错误。选中顶点会压缩编号，分组与材质标签、UV/normal 角点引用留在资源中。显式 materials 映射保存面颜色；没有匹配颜色时采用实例 color。

MTL/纹理文件不自动加载，UV 当前是元数据；OBJ 法线已可用于平滑材质。材质使用 standardMaterial 或 scene3d_materials 的 GGX 金属度/粗糙度直接光照，详见 MATERIALS3D.md。贴图、IBL、阴影和世界内透明材质未实现。未支持的语句、顶点颜色和 smoothing 分组会报告。输入 OBJ 最大 16MB/100000 顶点与属性；选择后的渲染网格最多 5000 个面，资源文件最大 8MB，缓存候选最大 16MB。可通过选择对象/分组与降低分段组织较大来源。

mesh_inspect 的拓扑以顶点编号为准：boundaryEdges、nonManifoldEdges、inconsistentEdges、degenerateFaces 与 closed。重合但未焊接的顶点仍算独立边。signedVolume 只有闭合且面方向一致时可作为实体体积；开面并非实体。inline 多边形应为凸共面面，复杂轮廓先经 OBJ 三角化。面积/方向/边界提示与实际深度图一起使用。

静态 scene3d、结构新增和覆盖里的 meshSource 在保存前验证；代码动态生成的引用仍需按实际帧取样，预检不能覆盖未采样代码路径。资源 JSON/引用错误保留最后有效工程。collect/pack 会携带项目内资源，重新生成画面不需要原始 OBJ。

CLI 对应 mesh-generate、mesh-import、mesh-inspect 的 --request 文件；也可使用 tool-call。完整示例 `examples/mesh-gallery` 已导出 8 秒 1280×720/30fps，包含六种形体、矩阵动画、OBJ 缺口、原生深度证据与五帧预检。后续导出使用 `scripts/create-mesh-gallery.ts --render-only`，保留已有编辑。
