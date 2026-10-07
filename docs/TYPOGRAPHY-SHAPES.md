# 文字与形状创作批次

文字、矢量、共享几何缓存和外部 Agent 操作一起交付，保持通用视频创作的广度。没有模型调用。

## 创作数据

- `text.pathText` 保存 SVG、像素弧长 `offset`、`normalOffset`、`tracking`、start/center/end 对齐、reverse/tangent，以及 hide/clamp/loop 溢出行为。文字基线沿路径切线放置；换行在路径模式转换为空格，多轮廓会在轮廓之间跳转。
- `text.textAnimators[]` 保存稳定 ID、enabled、selector 和 values。selector 支持 grapheme/word/line、percent/index 范围、offset、square/rampUp/rampDown/triangle/smooth 权重及 amount。index 用单位中心 `i+0.5`，percent 用 `(i+0.5)/count*100`；范围外和空范围权重为零。word 排除空白/标点，grapheme 包括行内空白、不包括换行。关闭的动画不参与粒度选择。
- values 支持 x/y、rotation、scaleX/scaleY、opacity、tracking 和 fill；位移/旋转/字距累加，缩放/透明度相乘。fill 在权重达到 0.5 后离散切换，数值通道可以用现有表达式/关键帧驱动。x/y 在图层坐标轴上作用。
- 新动画基于完整文字固定换行；reveal 不重排布局。旧 `textMotion` 无新字段时保留现有行为；路径/范围动画可叠加旧进场。
- 混合选择器采用需要的最细粒度；路径和字距使用字素。字素模式会拆开复杂语言连写/ligature，当前验收是中文、英语、组合字符及 emoji，不能视为完整复杂脚本 shaping。

`rect/ellipse/path.shapeOperators[]` 有序支持 trim、round、dash、outline、transform、boolean、offset。每项必须有稳定 ID，可以单独关闭。顺序是 primitive → operators → 旧 path.reveal → 图层 pathTrim。boolean 使用内联 SVG 及可选仿射变换，不做动态同级图层引用。dash 是 on/off/phase 双段间隔，先 dash 后 outline 可生成真正可编辑的虚线轮廓。

offset 为封闭填充边界向外/向内扩张：使用双倍距离描边和布尔 union/difference，保持孔洞，支持 join/miterLimit。开放轮廓须先 outline，否则明确报 `VECTOR_OFFSET_OPEN`；amount=0 不改形状。trim 使用总轮廓弧长，保留原有环绕语义。

## SDK 与 Agent

SDK `node/text` 接受上述输入默认值。`layoutAnimatedText(ctx,node,frame)` 返回文字单位位置/盒子和布局指标；`textSelectorWeight` 是纯范围求值，`applyShapeOperators` 克隆原生路径再处理；`editGraphicsStack` 共用稳定 ID 操作及通道映射。

`graphics_inspect` 按 sceneId/path/nodeId/frame 获取最终求值的共享几何，默认只返回 16 个文字单位、短算子摘要；offset/limit 分页；默认坐标保留四位小数并省略 poseDefaults 声明的默认值，detail 返回完整原始精度，includePath 显式获取 SVG。返回局部 bounds 和 world matrix，文字基线/多边形同画布选框。隐藏的路径溢出另计 overflowUnits，普通直排高度截断检查不会误报路径文字。

`graphics_plan` 以一个 revision 批量处理 targets 的 pathText、textActions、shapeActions 与 keys。append/update/copy/move/toggle/remove/clear/keys 按 ID 或 index 操作，嵌套 patch 保留兄弟字段，复制包含关键帧/表达式目标。重排时键与表达式目标跟随稳定 ID；表达式字符串中的显式索引引用须先自行改写，工具会拒绝可能改变含义的拓扑操作。禁用 pathText 前须显式删除关联通道。

默认返回磁盘固定的 planId，保持短候选；project_preflight/project_apply 使用原样 candidate/apply，一次撤销恢复整个批次，代码生成内容写入 owner overrides，不修改 TypeScript。自动去重采样当前帧和数值键端点，最多 12 个 scope/time，sampleCoverage 明确报告遗漏；额外中间帧需主动预检。CLI `graphics-inspect/graphics-plan --project ... --request request.json` 使用同一服务。`project_schema` 可分别请求 pathText/textAnimator/shapeOperator，无需读完整 node Schema。

```json
{"sceneId":"intro","revision":"CURRENT_REVISION","targets":[{"nodeId":"title","textActions":[{"type":"append","item":{"id":"rise","selector":{"unit":"grapheme","shape":"smooth"},"values":{"y":20}}}],"keys":[{"property":"textAnimators.0.selector.offset","keys":[{"frame":0,"value":-100},{"frame":90,"value":100}]}]}]}
```

## 性能与验收

静态排版、单位度量与最终路径都有 LRU 限制：每个缓存最多 128 项，文字布局和几何各 8MiB，旧换行缓存 2MiB。accountedBytes 只计算键/序列化数据，不表示原生 Skia RAM。过大条目不驻留；高级文字每层最多 4096 字素、65536 UTF-16 单位，超预算明确失败。字体注册使排版缓存失效；动态位置/范围与时间不加入静态排版签名。路径结果始终返回副本，不泄漏可变缓存。缓存不保存渲染帧，随机跳帧/有状态代码检查不被遮蔽。

`render_profile` 报告缓存命中/未命中/淘汰/预算。`graphicsCache=false` 关闭两类缓存，提供实际同像素性能基线。不能以此替代全局内存、GPU、长片/4K/实时验收。

`examples/typography-lab` 是可修改的 6 秒 1280×720/30fps 工程。`scripts/create-typography-lab.ts --render-only` 保留已有编辑；重建必须显式 `--rebuild`。实际外部 stdio MCP 验证脚本为 `node scripts/check-graphics.mjs --packaged`，覆盖发现、Schema/hash、分页、生成内容、失败请求、候选/撤销、随机帧、缓存像素基线和 MP4 导出。最终验证证据补录在 WORK-STATUS.md。
