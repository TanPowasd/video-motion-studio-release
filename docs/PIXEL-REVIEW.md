# 原生像素检查

这些工具属于 `vmotion.review`，编辑器服务、CLI 与 MCP 共用实现。软件不调用模型；外部 agent 使用指标和原生图片作出判断。默认 MCP 仍为十个入口，使用 `tools_search` 搜索“颜色 对比 影响”，然后按需读取一个 `tool_schema`。

| 工具 | 行为 | 默认响应与范围 |
|---|---|---|
| `color_scopes` | 最终合成的 RGB/亮度均值、方差、低/高端比例、直方图分位数、波形与 UV 图 | 最多十二帧，短摘要和一张原生图；`includeDistributions:true` 才返回数组 |
| `frame_compare` | 活动工程或固定候选的前后帧、差分、变化范围/比例、MAE/RMS 与重复稳定性 | 最多六对；`planId` 为右侧候选，`baselinePlanId` 为左侧候选 |
| `layer_impact` | 逐对象临时设置 `visible:false`，渲染完整场景并与原图比较 | 最多十二对象、八帧、二十四对；默认至多四组图片，返回省略数和真实 locator |

共同输入：固定 `revision`、`width`（160–3840）、可选 `height`（16–2160）、`region`（渲染后的整数像素，必须在画面内）、`images:false` 关闭图像输出、`output` 指定 PNG 路径。每次调用限制 64×1024×1024 个渲染像素，重复确定性检查也计入预算，超限返回错误，不降低分辨率。这是调用工作预算，不是全局内存承诺。

`color_scopes/frame_compare` 的 `scope` 选择场景或序列（不能同时选择）；不指定则使用活动序列。场景可带 `path/contextFrames` 指定组件、组或引用场景的局部视图。对象时钟按该作用域计算，帧必须在局部时间范围。普通组保留所在画布，组件/引用场景使用自身编辑画布。前后作用域比例不同时需显式给出共同宽高；图片展示保留渲染比例。`compareFrames/compareScope` 可有意比较不同时间或对象，须与 `frames` 同长度。

```json
{"name":"frame_compare","arguments":{"revision":"实际活动版本","planId":"实际候选哈希","scope":{"sceneId":"intro"},"frames":[0,30,59],"width":640}}
```

先读候选差分，再对同一个候选 `project_preflight`，按原 `apply` 请求提交；提交后导出固定版本。两个候选解算固定在同一活动基准，有并发修改时拒绝混用。源码候选同样在临时快照编译，不写实际源码。检查本身不生成修复候选、不写历史；临时图层隐藏通过相同稳定 ID 编辑命令定位生成/重映射内容。

颜色统计使用编码后的 SDR sRGB 及 Rec.709 加权亮度/UV，数值归一化到 0–1，不是线性光能、HDR 或 OCIO 显示变换。`alpha:"weighted"` 默认按透明度加权直 RGB；`visible` 对非透明像素等权；`black` 合成到黑底。低/高端阈值为 1/255 与 254/255，饱和色的某通道到端点不表示曝光错误。分位数是直方图箱中点，误差与 `bins` 有关。

默认 `analysis:"full"` 分析 ROI 全部像素。`sampled/maxSamples` 使用确定的光栅步长，coverage 返回真正访问数、权重和 stride；可能错过周期图案。分布规模由 bins/columns/vectorSize 限制，图片需分布数据但默认不把数组传给 agent。`images:false` 且无显式数组时跳过波形和 UV 分布分配。服务检查所有注册媒体的 size/mtime 或可编辑声音源码 hash，检查前后变化时报错；不是内容文件锁。

差分使用预乘 SDR RGB 与独立 alpha 的绝对差（8 位单位），透明像素隐藏 RGB 不产生视觉差异。tolerance 仅控制 changedPixels/Bounds，exactChangedPixels、均值和 RMS 仍保留所有差异。`determinism:true` 默认重复相同帧，不稳定时标记 `inconclusive`；抽样稳定不证明全片确定性。差分面积不代表质量提高。

图层影响不是孤立对象可见率或删除操作。遮挡、遮罩、效果、父级/相机遵循原生合成；依赖源可能按其捕获规则继续使用。`dependencySensitive` 只是静态提示，任意代码/表达式可能增加依赖。无变化可能来自离屏、覆盖、同色、透明、未激活时钟或 ROI 范围，不能自动当作错误。需要结合图片、作者意图和覆盖报告。

CLI：`vmotion color-scopes|frame-compare|layer-impact --project PATH --request request.json --json`，无须打开窗口，有窗口时通过当前服务桥接。MCP 的图片只放原生 image block，短 JSON 不含重复 Base64。`response:"full"` 保留完整服务结果形状，分布数组仍须显式请求。

SDK 可直接分析已有 RGBA 缓冲：

```ts
import { pixelEvidence, comparePixels, type PixelRegion } from '@vmotion/sdk';
const roi: PixelRegion = { x: 0, y: 0, width: 320, height: 180 };
const summary = pixelEvidence(rgba, 320, 180, { region: roi, analysis: 'full', alpha: 'weighted' });
const differences = comparePixels(before, after, 320, 180, { region: roi, tolerance: 2 });
```

可编辑演示 `examples/pixel-review-lab` 及 `scripts/create-pixel-review-lab.ts`，已存在的工程需显式 `--rebuild`；`--render-only` 保留用户编辑。真实 stdio/候选/CLI/导出验收运行 `node scripts/check-pixel-review.mjs --packaged`。当前剩余功能与正式验收要求见 [FUTURE-WORK.md](FUTURE-WORK.md) 和 [ROADMAP.md](ROADMAP.md)。
