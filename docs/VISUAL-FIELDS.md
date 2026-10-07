# 程序化纹理、置换与光效

此批同时增加通用视觉构建块、可编辑组合模板和区域像素性能优化。视觉由本地代码/JSON/原生渲染生成，不调用图像/视频模型，外部 Agent 继续通过文件、SDK、CLI/MCP 创作。

## 程序化纹理与图层置换

特效节点图新增 texture 节点，保存 TextureSettings：fbm、turbulence、ridged、cellular、marble、waves、checker 七种场，固定 seed、scale/octaves、evolution/angle、warp/contrast/bias，以及最多 16 个严格递增颜色/透明度停止点。颜色表按预乘 alpha 插值，避免透明端被隐藏颜色污染；渲染使用 1024 级颜色查找表，输出仍是 RGBA8。域扭曲是确定性场，不是物理流体。

```ts
import { visualPreset, effectGraph, prepareTexture } from '@vmotion/sdk';
const material = effectGraph(visualPreset('marble'), {
  scale: 50, warp: 1, evolution: ctx.seconds * .25,
  low: '#193249', high: '#a8e9d0'
});
// 数学/布局代码也可按坐标直接查询一致的标量场。
const value = prepareTexture({ pattern: 'cellular', seed: 4, scale: 40 }).value(x, y);
```

texture/noise 节点的 space=layer/canvas、region 与既有矩阵一致。没有 region 时使用拥有图层的声明 bounds 或逻辑画布；可按参数连接 settings 的数值、颜色和结构字段。静态设置属于共享 JSON，实例 params 和关键帧继续保留可编程性。

displace 节点接收 source 与 map 图像，可选择 red/green/blue/alpha/luma 两个通道、amountX/Y、midpointX/Y（默认 .5）、mapAlpha=multiply/ignore、layer/canvas 向量空间和透明/clamp/wrap 取样。map 来源可以是 sibling 图层、媒体、代码图层或上述纹理；双方先捕获到拥有层的相同画布，再做预乘采样。默认透明 map 不产生位移；ignore 明确忽略 map alpha，可能使黑色区域也位移。RGBA8 灰色 128/255 并非精确 .5，要绝对中性可设置 midpoint=128/255。

## 光效与颜色

普通特效栈/图节点 pass 新增：

| 操作 | 行为 |
|---|---|
| gradientMap | 按亮度映射严格递增颜色停止点，intensity 混合，保留输入 alpha |
| bloom | 提取 threshold 以上亮部，按 levels 构建缩小图层和多尺度光晕，再 screen 合成；半径/颜色/强度可编辑 |
| radialRays | 从中心沿径向取样亮部，samples/decay/length 控制光束，在线性光预乘 alpha 下 screen/add 混合 |

SDK 提供 gradientMap、bloom、radialRays 构造函数；原生数字 effects.N.length/center/decay/intensity 等可加关键帧。samples/levels 为固定整数，避免把连续数值键误当合法离散采样设置。素材库/图层效果检查器也显示这些普通效果，完整图组合以代码/JSON/MCP 为主。

光束是二维采样合成，不是遮挡正确的体积光；bloom 为 SDR 多尺度辉光，没有 HDR、物理相机和 GPU 后端。超过显式预算返回错误，不降低导出尺寸/采样质量。

## Agent 组合模板

visual_templates 默认返回 9 组短摘要：texture、marble、cellular、textureDisplace、layerDisplace、inkReveal、neonBloom、radialRays、duotone。每组含参数描述、节点 ID/类型和输入槽；includeGraph=true 必须选择一个 preset，避免一次重复所有大图。

visual_plan 复用 effect_graph_plan 的候选/资源/覆盖系统。指定 preset、revision 与多个 scene/path/nodeId，params、bindings 和参数 keys；创建 components/effects/visual-PRESET.json。已存在的共享资源保持用户编辑，使用其当前内容，不重置为内置默认；不兼容旧参数需明确另建资源或普通图编辑。

```json
{"revision":"工程版本","preset":"layerDisplace","targets":[
 {"sceneId":"intro","nodeId":"film/title","path":["film"],
  "bindings":{"map":"map-layer"},"params":{"amountX":16,"amountY":4}}
]}
```

通过 project_preflight 检查原生画面/确定性/诊断，用 render_profile 看像素计算与耗时，原样 project_apply 一次提交/撤销。图层 map 必须位于相同父级；其他空间应先预合成。仍使用稳定 ID，不反向改写生成组件源码。inkReveal 使用纹理亮度、抬升和方向擦除，声明区域内 0/1 端点严格隐藏/显示；效果外溢可要求更大显式 region。

CLI 提供 visual-templates、visual-plan（--request）；更底层的 effects_guide/plan 和 effect_graph_inspect/plan 可自由组合。复杂参数连接允许命名对象 length 字段，但禁止数组 length 与原型路径，保留类型和拓扑限制。

## 区域性能与验收

texture/noise 将 region 四角经实际变换求保守像素框，只在框中求逆坐标与标量场，分配/提交区域像素块，而不是整个输出的 Uint8 数组。displace 在 mapAlpha=multiply 时只计算非零 map alpha 的保守框；输入捕获/画布保留整图，外部数据和内部缓存依旧计入原内存预算。radialRays 在 length<1 时按亮部范围和径向逆映射求保守框，长光束退回全画布。优化没有截掉被传播的像素。

render_profile fieldScan=full 选择全画布数学基线；bounded 是正常默认。两路径使用相同输入和输出维度，帧 hash 必须一致。cache.fieldPixels 计纹理/置换循环与光束标量样本，不等同全渲染读写/编码开销；每输出帧最多 256M 累计 field/ray 求值，原图面/图预算继续执行。关闭优化是显式基准选项，不是质量升级。

封装 MCP 小场景 640×360 的纹理求值为 25,359 对 230,400，热平均约 6.4 对 10.1 ms，画面相同。最终区域像素块版本的六面板720p示例求值约 350,548 对 18,432,000，单次热渲染约 369 对 1160 ms；仍达不到实时播放，不能把区域优化或抽样值作为通用 30fps/4K/两小时验收。GPU、更多效果区域读回、细粒度缓存和性能工程继续待做。

tests/visual-fields.test.ts 验证场/调色/透明端、旋转/斜切/镜像区域与全基线一致、图层 map 位移、光束范围/预算、光晕以及 reveal 端点；visual-plan.test.ts 验证参数化资源、生成覆盖、关键帧、用户编辑保留及原子撤销。scripts/check-visual-fields.mjs --packaged 使用真实外部 stdio MCP，检查摘要/Schema、native preflight、随机跳转、PNG byte parity、60 帧 MP4 与失败恢复。examples/visual-fields-lab 是4秒1280×720/30fps、120帧可编辑例子，提供接触表/性能JSON/MP4；--render-only 保留已有编辑，明确 --rebuild 才重建。
