# 参数化动作编排

外部 agent 使用 `motion_templates` 查询内置或工程中的动作；默认只返回参数描述、参数 Schema、兼容图层类型和通道摘要。includeTemplate=true 返回完整 normalized keys，便于定制。内置提供 fadeSlide、fadeOut、pop、pulse、wipeText；不调用模型。

`motion_plan` 将动作组合成多场景候选：cues 定义共同动作序列，targets 指定场景/图层/所属 path，bindings 针对 cue ID 修改参数，offset 错开时钟。默认帧单位；units=seconds 根据有理数 fps 对每个绝对键时刻换算并取整，避免累积舍入。所有时刻使用所选合成的局部时钟；contextFrames 与现有组件/引用工具相同。

```json
{
  "revision":"project_context 的实际版本",
  "cues":[
    {"id":"enter","template":{"builtin":"fadeSlide"},"start":0,"duration":24},
    {"id":"accent","template":{"builtin":"pulse"},"start":40,"duration":20},
    {"id":"exit","template":{"builtin":"fadeOut"},"start":80,"duration":20}
  ],
  "targets":[
    {"sceneId":"intro","nodeId":"title","bindings":{"enter":{"dy":36}}},
    {"sceneId":"next","nodeId":"film/title","path":["film"],"offset":6,"bindings":{"enter":{"dx":-48,"dy":0}}}
  ]
}
```

每个目标只出现一次。referenceFrame 指定读取原始图层/代码生成姿态的时刻；默认 basis=static 以该原始属性作为基准，避免替换旧淡入时把初始 opacity=0 当作目标透明度。basis=evaluated 则先求值已有动画，明确使用该帧姿态。新动作的同属性范围不能重叠；衔接处同帧值必须一致，后续动作的缓动控制下一段。

collision 默认 error，保护已有受控通道。replaceChannels 显式替换这些属性的整条通道，其他通道保留；merge 保留既有键，遇到同帧碰撞拒绝。插入键可能改变相邻插值，需检查画面。多个动作在不同属性上可以同时执行。

自定义资源保存于 `components/motions/*.json`，kind=motion-template、version=1、name、parameters、channels 为权威字段。参数类型复用组件声明；绑定对象按字段合并，数组整项替换，未知参数和非法值拒绝。每个 channel 使用受支持的数值 property，键的 at 在 0–1 之间；value 可以是常量，或如下受限数值表达式，不执行代码：

```json
{"base":1,"offset":0,"parameters":{"dy":1}}
```

这表示 `基准属性 × 1 + dy`。base 也可为 `{"parameter":"startScale"}`，实现相对缩放；parameters 的键可以引用 `offset.x` 等数字叶节点。时间、参数值、归一化时刻碰撞、图层类型和受支持属性均检查，整数参数动画应使用 hold。

saveTemplates 在同一 motion_plan 中保存资源并应用到多个场景，expectedHash=null 表示只创建新文件；替换须提供旧字节 hash。模板和图层共享一次提交/撤销。规划不修改活动工程；candidate 返回短 planId，先 project_preflight 看原生图片，再原样 project_apply。生成内容保存为所属 overrides，TypeScript 不改写。

应用后生成普通可编辑关键帧；模板后续更新不静默改写先前应用结果。代码可以通过 import JSON、SDK parseMotionTemplate/applyMotionCues 共享依赖；适合固定的基准图层在 render 外预编译，或在 render 中根据声明参数纯函数生成。内置模板冻结，定制时使用 structuredClone。SDK 与 MCP 使用同一编译规则。

新增output=layers与SDK applyMotionLayers，cue可作为weighted add/multiply/replace层叠加，不覆盖普通键；neutral/source基值、window和曲线before/after显式配置。同属性重叠允许，但稳定cue层ID不能重复。默认output=keys继续上述互斥/碰撞行为，使用层专用字段却选择keys会拒绝。详见[动画层](ANIMATION-LAYERS.md)。

每层至多 100000 键；poseChecks 记录端点检查数量，复杂动作最多检查 128 个分布端点并明确标记 incomplete。计划图片最多 12 帧，coverage 报告未覆盖数量，优先让不同作用域各有一帧；必须按需追加 preflight.samples 验证其他范围。采样检查不证明全部视频帧安全，也不证明遮罩/效果后的像素可见性。键超出合成末帧、零时长或重复时间、旧版本和未经授权的通道覆盖均拒绝。

CLI `motion-templates --request request.json`、`motion-plan --request request.json` 提供同一接口；project_schema name=motionTemplate 返回格式。验收脚本 `node scripts/check-agent-motion.mjs --packaged` 实际通过共享模板、两场景、生成组覆盖、额外预检、原生接触表、PNG 字节一致、4 秒 120 帧 MP4 和模板/场景一次撤销，并留下可继续编辑的示例工程。
