# Agent 素材取证与剪辑方案

`agent_guide` 按 editing/math/animation/recovery 返回精简工具路线。制作剪辑时先用 `project_context` 查轨道与素材 ID，再取证、计划、预检、提交；无需操作编辑器。

1. `media_inspect {assetId}` 探测实际媒体，返回尺寸、音轨、时长、project FPS、exclusive sourceEnd 和 assetCheck。
2. `media_sample {assetId, frames:[0,30,90]}` 返回原生源画面接触表、每帧秒数/像素 hash 和 assetCheck。省略 frames 时默认均匀取 8 帧。MCP 返回图片，CLI 返回本地 PNG 路径；最多 24 帧、每格宽 160–640px。取证使用独立解码器与较小画布，不改变活动工程或撤销记录。
3. `sequence_plan` 将声明式来源范围转换为固定 ID 的实际 operations，并返回 candidate 和 apply 两份完整请求。计划不会保存文件。
4. 用返回的 candidate 调用 `project_preflight`，检查图片/diagnostics/candidateRevision；通过后，把返回的 apply 原样传给 `project_apply`。不要重建计划，否则随机生成的 ID 会改变候选版本。可修改取样设置，但保持 operations、assetChecks、revision 与 expectedCandidateRevision。

```json
{
  "sequenceId": "main",
  "revision": "<project_context.revision>",
  "assetChecks": [{"assetId":"shot","fingerprint":"<media_sample.fingerprint>"}],
  "items": [{
    "source": {"type":"asset","id":"shot"},
    "trackId":"video",
    "audioTrackId":"sound",
    "mode":"insert",
    "at":90,
    "sourceIn":30,
    "sourceOut":150,
    "speed":1.5,
    "name":"已检查的镜头"
  }]
}
```

时间单位为工程有理数 FPS 下的源帧，允许 sourceIn/sourceOut 为小数，不是媒体原生帧率下的索引。sourceOut 是排除端点，duration 是整数时间轴帧；默认取 `ceil((sourceOut-sourceIn)/speed)`，也可从实际时长推断。静态图片/画稿必须提供 duration 或范围。指定 duration 与 sourceOut 时必须覆盖同一段范围。最终不足一个时间轴帧的声音补静音，画面只使用选择范围内的源时间。

append 默认在目标轨道最后一个片段之后，显式 at 也不能覆盖已有片段。insert 在指定位置分割跨越该点的片段，所有受影响轨道后移，保留 source/fade windows、链接关系，并移动标记与工作区。锁定的受影响轨道拒绝修改。overwrite 只切除目标轨道该范围，保留左右部分；与其他轨道存在链接伙伴时拒绝单边覆盖。video 来源指定 audioTrackId 后，创建独立链接的音频片段并关闭视频片段声音，防止声音加倍；无音轨素材拒绝此选项。scene/sequence 来源也可编排，场景音频路由仍未实现。

计划包含最终序列的可声明素材依赖与字体取证；遇到任意 TS 组件时保守检查全部已注册素材。assetChecks 也可直接用于普通 project_preflight/project_apply。检查依据是文件大小与 mtimeMs，不是内容密码学摘要；不能发现人为保持这两者不变的内容替换。检查分别在取证/预检结束及事务队列验证后、写入前执行；外部进程仍不受文件锁约束。检查失败返回 ASSET_CHANGED，agent 应重新读取并取证，而不是去掉检查强行提交。

CLI 与 MCP 使用同一服务：

计划也把实际探测的素材 metadata 与 fingerprint 固定进候选操作。替换媒体后重新取证得到新的时长，渲染不会仍按导入时的旧时长截断；这项刷新和剪辑一起保存、一起撤销。

```powershell
node dist/cli/index.mjs agent-guide --project my-project --topic editing
node dist/cli/index.mjs media-inspect --project my-project --request inspect.json
node dist/cli/index.mjs media-sample --project my-project --request samples.json
node dist/cli/index.mjs sequence-plan --project my-project --request assembly.json
node dist/cli/index.mjs preflight --project my-project --request-file candidate.json
node dist/cli/index.mjs apply --project my-project --request-file apply.json
```

序列预检 samples 可指定 sequenceId，直接检查非活动序列，不必修改 activeSequence。计划返回的 samples 已包含目标 sequenceId。声音使用 `audio_preview`，视觉源采样不执行声音识别或语义镜头理解。
