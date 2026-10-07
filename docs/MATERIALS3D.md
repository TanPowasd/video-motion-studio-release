# 平滑法线与原生材质

scene3DLayer 的实例可声明 material，使用 Rust 的逐采样点着色。standardMaterial 提供金属度/粗糙度 GGX 直接光照，unlitMaterial 提供不受光颜色。未声明材质的项目继续使用原有平面着色；预览、导出和 scene3d_render 使用同一深度/着色核心。

```ts
import { scene3DLayer, sphereMesh, standardMaterial } from '@vmotion/sdk';
const sphere = sphereMesh(1);
const layer = scene3DLayer('world', [{
  id:'sphere',mesh:sphere,
  material:standardMaterial({color:'#e3aa56',metallic:1,roughness:.25}),
}], {
  position:{x:0,y:0,z:5},target:{x:0,y:0,z:0},width:1280,height:720,
}, {
  ambient:.1,
  lights:[{type:'directional',direction:{x:.3,y:.6,z:1},intensity:3}],
  exposure:1,toneMapping:'aces',samples:4,
});
```

材质字段：model=standard/unlit，color 可覆盖资源面色，metallic=0–1，roughness=.05–1，emissive 与 emissiveIntensity=0–8，shading=flat/smooth，creaseAngle=0–180 度，doubleSided。Schema 可用 project_schema 的 material3d 查询。

smooth 默认按面积加权平均相邻面法线，creaseAngle=60 保留立方体棱边和圆柱端盖。SDK cornerNormals/smoothMesh 可预先计算，mesh.cornerNormals 也可显式声明。OBJ normal 引用供平滑材质使用，缺失角点回退到生成法线。世界法线用逆转置矩阵，覆盖非均匀缩放和镜像；裁剪后的世界位置和法线在采样点做透视校正与归一化。退化缩放退回可定义的几何面法线。

options.lights 支持最多 8 个方向光和点光。direction 表示表面朝向光源的方向；点光 position 使用世界坐标，intensity 按距离平方衰减，range 可增加有限范围淡化。没有显式 lights 时，沿用 options.light 生成默认方向光。ambient 为常量环境近似；exposure=.01–16，toneMapping=none/reinhard/aces。颜色转为线性 RGB 计算 GGX/Smith/Schlick，再转为 SDR sRGB。

该实现包含直接光 BRDF、自发光和简单环境项，没有纹理/法线贴图、IBL 环境反射、阴影贴图、世界内透明材质或 HDR 输出。光滑金属主要显示直接光高光。scene3D 的可编辑矢量面仅表示平面颜色预估，逐像素材质使用 scene3DLayer。

外部 agent 用 scene3d_materials 查询稳定实例 ID、当前求值与灯光，不加载大量顶点；同一接口可生成候选：

```json
{
  "sceneId":"intro",
  "nodeId":"model-layer",
  "frame":30,
  "updates":[{"instanceId":"model","patch":{"metallic":0.8,"roughness":0.3}}],
  "options":{"exposure":1.1}
}
```

updates/options 返回 candidate.planId、apply 和 planned 控制值；先 project_preflight 检查图像，再原样 project_apply，形成一次撤销。path/contextFrames 支持组/组件生成层。已有数值通道在请求帧更新关键帧；reset=true 移除实例材质及材质通道。替换带动画的 lights 数组需要 resetLightKeys=true，明确清除原灯光索引通道。

material.metallic/roughness/emissiveIntensity/creaseAngle、options.ambient/exposure、灯光 intensity/range/position/direction 支持 animation_edit。字段必须存在且值保持 Schema 范围；颜色变化可用 TypeScript 表达式。

scene3d_render 返回彩色/深度/面 ID 图，附材质与灯光。检查范围沿用 DEPTH3D.md。原生与回退允许 RGB 相差最多一个 8-bit 单位，深度/面 ID 一致；旧原生运行时不支持新着色协议时使用 TypeScript 回退。

examples/material-gallery 是 6 秒 1280×720/30fps 工程，比较平面/平滑法线、光滑/粗糙金属、自发光和移动点光。五帧预检与 Rust 证据已验证，后续用 scripts/create-material-gallery.ts --render-only 导出。
