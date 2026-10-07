# 平面特效与 agent 批量创作

新效果复用普通 effects 堆栈，按顺序作用于文字、矢量、图片、视频、组和组件。预览与导出使用同一个原生合成/像素管线，程序不调用模型。

| SDK/类型 | 参数与作用 |
|---|---|
| waveWarp | amountX/Y、wavelength（局部像素）、angle（度）、phase（周期）；角度 0 的波形沿 Y 变化 |
| twirl | center、radius、amount（度），半径内渐弱旋转 |
| bulge | center、radius、amount=-1…1；正值膨胀、负值收缩 |
| rgbSplit | amountX/Y、intensity；红/蓝反向错位，透明覆盖正确合成 |
| linearWipe | progress、angle、feather；按方向揭示图层 |
| radialWipe | progress、center、feather；按圆形半径展开 |
| motionBlur | samples、shutterAngle、phase；图层真实子帧线性光平均 |
| echo | count、spacing、decay、strength、operator；历史图层叠加拖尾 |
| liquify | brushes 的 push/twirl/inflate 局部反向采样场，支持点位关键帧 |

擦除 progress=0 完全隐藏，progress=1 精确返回原画面。强度为 0、enabled=false 精确保持原图。空间采样使用预乘 Alpha，不把透明像素中的无效颜色混进边缘。原有 glow/blur/color/levels/curves/LUT/grain/displacement/pixelate 等可继续组合。

默认 space=layer，长度按图层本地像素，center 为 region 的归一化坐标。图层位移、旋转、缩放、矩阵变换与预览分辨率均进入坐标映射。默认 region 为声明的 width/height；代码组应显式声明它们。region={x,y,width,height} 可覆盖。space=canvas 使用当前画布的逻辑坐标，忽略图层变换。effects_plan 默认将新局部效果拟合当前内容边界；这份边界保存到候选，后续内容变化时可重新拟合或通过数值通道修改。

```ts
import { group, text, waveWarp, rgbSplit, linearWipe } from '@vmotion/sdk';
const layer = group('title', [text('word','VMOTION',{width:600,height:100})], {
  width:600,height:100,
  effects:[waveWarp({phase:ctx.seconds*.3,amountX:12}),rgbSplit({amountX:3})],
});
// 普通关键帧路径：effects.0.phase、effects.1.amountX、effects.N.center.x 等。
```

所有特效可带可选稳定 id 与 enabled。历史项目未带 ID 时继续运行；第一次工具编辑为该层分配并保存 ID。同层 ID 不能重复。未声明布尔字段时视为启用。

Agent 工具通过 tool_call 或按需加载 effects 类别使用：

- effects_guide：列类型、字段和单位，只给指定类型返回完整 Schema。
- effects_inspect：按图层 ID 查询堆栈、当前值、ID/index、关键帧通道和旧式 blur/color/shadow 控制。
- effects_plan：同一场景中的多图层/多组/多组件目标，生成精确候选；源码保留，内部层编辑写入覆盖。

```json
{
  "sceneId":"intro",
  "frame":90,
  "targets":[{
    "nodeId":"title",
    "actions":[
      {"type":"append","effect":{"type":"linearWipe","id":"reveal","progress":1,"feather":20}},
      {"type":"keys","target":{"id":"reveal"},"property":"progress","keys":[{"frame":0,"value":0},{"frame":90,"value":1}]}
    ]
  }]
}
```

每个目标支持 path/contextFrames/frame、fitToContent。动作按序执行：append、update、copy、move、toggle、remove、clear、keys；target 按 id 或当前 index 定位，优先使用 id。update.patch 为完整顶层字段，嵌套 center/region 应提交完整对象。copy 复制当前参数与数值通道并分配新 ID，move/remove 自动迁移或删除 effects.N.* 键；其他图层通道不变。已有数值参数修改会在请求帧更新键，keys 显式创建/更新动画。

返回 candidate.planId 与 apply.expectedCandidateRevision；project_preflight 检查样本画面/确定性后，原样 project_apply。整个多层修改共享一次撤销；无效目标、参数、重复 ID 和超出 16 项效果均拒绝。旧式 node.blur/brightness/saturation/shadow 不属于显式堆栈，不被 clear 删除。SDK editEffectStack 使用同一算法。

CPU 空间效果限定于有效像素和最大位移/半径区域；wrap 模式跨边缘仍保留正确采样。缓存继续有界。渲染检查点现在包含运行核心/SDK/原生版本指纹，更新渲染实现后不会把旧分段当作当前画面；runtime.json 可查看来源。

CLI effects-guide/effects-inspect/effects-plan 使用 --request JSON；也可用通用 tool-call。examples/effects2d-lab 是 8 秒 1280×720/30fps 可编辑对照工程，展示六个效果与当前时间检查。后续用 scripts/create-effects2d-lab.ts --render-only 导出，保留已有修改。

网格与四角变形：`meshWarp({columns, rows, points, amount, samples, region})` 使用行优先控制网格，点数必须为 `(columns+1)*(rows+1)`。`makeWarpGrid` 可按 u/v 构造控制点；x/y 是区域归一化目标位置，weight 是正的投影权重。单个 `effects.N.points.I.x/y/weight` 支持数值关键帧。网格折叠按三角形顺序由后绘制面覆盖前绘制面，不提供物理布料模拟。

`cornerPin(corners, options)` 的四角顺序为左上、右上、右下、左下；必须形成非退化凸四边形。光栅使用透视校正 UV，支持 `effects.N.corners.I.x/y` 关键帧。`amount=0`、恒等网格与禁用效果精确保留源像素，samples=1/4，默认四采样；区域外源内容保留，采样不会带入其他区域的颜色。每次使用局部 tile 缓冲及 256M 覆盖运算预算，超出返回 WARP_BUDGET，不缩小导出分辨率。

图层时间采样、解析粒子及局部笔刷场详见 [TEMPORAL-PARTICLES.md](TEMPORAL-PARTICLES.md)。尚未包括光流、交互绘制液化笔刷、完整特效节点图、流体模拟或 GPU。遮罩/合成顺序与时间效果的范围需看对应文档，视觉检查要覆盖关键时刻与相邻帧。
