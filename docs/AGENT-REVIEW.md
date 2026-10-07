# Agent 检查、修复与导出

软件不调用模型。外部 agent 通过代码、CLI 和 MCP 作出构图决定；工作站提供确定性的测量、候选、画面与版本保护。先读取 `agent_guide {topic:"review"}` 或用 `tools_search` 查找“画面 修复”。

`color_scopes`、`frame_compare` 与 `layer_impact` 补充真实合成像素证据：颜色分布、准确候选前后差分、临时隐藏对象后的画面影响。它们不修改工程或增加撤销步骤，详细边界与 CLI/SDK 示例见 [PIXEL-REVIEW.md](PIXEL-REVIEW.md)。

1. `project_context` 读取 revision，`visual_audit` 指定采样帧检查画面。每项 finding 含 revision 绑定的稳定 id 和 locator（sceneId、展开 nodeId、owner path、local frame、contextFrames）。FRAME_ERROR 应先修复源码；重叠、父级裁剪和运动提示需要 agent 看图判断。
2. `visual_repair_plan` 以 sceneId/revision 和明确选定的展开对象 ID 生成候选。它重新查询原生几何，自动找出代码组件/共享场景的所属覆盖位置，不需要 agent 手写层级坐标换算。
3. `project_preflight` 读取返回的 candidate；默认检查采样画面、原生视觉诊断和确定性，返回图片。确认候选后通过 `project_apply` 原样提交返回的 apply。候选不改变当前源码和历史，提交共享一次撤销。
4. 复查 `visual_audit`，把提交后的 revision 传入 `render_start`；轮询 `render_status` 并检查成片。提交与导出之间若工程变化，会拒绝启动，避免导出另一版本。

```json
{
  "sceneId":"intro",
  "revision":"从 project_context 读取的实际版本",
  "frame":30,
  "frames":[0,30,59],
  "targets":[
    {"nodeId":"film/title","actions":[{"type":"fitText"}]},
    {"nodeId":"film/caption","actions":[{"type":"insideCanvas","padding":20}]},
    {"nodeId":"film/label","mode":"currentKey","actions":[{"type":"move","space":"canvas","delta":{"x":40,"y":10}}]}
  ]
}
```

动作按目标中的顺序执行，后一动作使用前一动作的候选几何。每个对象使用一份 action list；默认存储完整候选，只返回短 planId。delivery=inline 可显式取得原操作。

- `fitText` 使用与渲染相同的分行和字体，包括尚未 reveal 的文字，默认只增长高度并加 2px 留白。allKeys 模式按指定采样帧选择足够的高度差；可声明 growOnly=false 和 maxHeight。内容超过限制时返回 VISUAL_REPAIR_FIT，要求显式调整宽度/字号，不删改文案。
- `move` 的 delta 使用当前 scope 的画布坐标，经过父级/相机矩阵换算；space=parent 使用父级单位。相同 displacement 可以用于不同变换下的对象。
- `insideCanvas` 将当前帧内容几何移入留边区域；对象过大时拒绝，不自动缩小。保留既有父级 clip、遮罩和效果；这些仍可能产生复查提示。
- `allKeys` 是默认模式，平移已有值轨迹和静态值，保留关键帧数、时间、缓动与贝塞尔控制点。`currentKey` 修改当前局部帧的姿态：已有通道在四舍五入后的帧写键；未动画属性直接更新。

返回 before/after 的 findings 和 summary、具体 changes、精确 candidate/apply。残留确定错误会在默认 preflight 中阻止保存；几何 review 不自动决定艺术意图。检查仅覆盖所选帧，遮罩、效果和透明媒体的最终可见性仍需看原生图片。无效 ID、旧 revision、退化父级矩阵或不可能的布局会拒绝计划，当前工程不变。

CLI 使用 `visual-repair-plan --request request.json`、`preflight --request-file candidate.json`、`apply --request-file apply.json`；`render --revision HASH` 与 MCP 相同。真实外部客户端验收脚本为 `node scripts/check-agent-review.mjs --packaged`：包括组件内部修复、前后图、精确提交、源码保留、PNG 逐字节一致、60 帧 MP4 和一次撤销。
