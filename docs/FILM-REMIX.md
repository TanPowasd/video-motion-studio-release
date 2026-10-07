# 二创与电影剪辑工作流

剪辑工作区新增“二创 / 节拍编排”和“电影 / 镜头剪辑”模式。两者使用同一工程、媒体管线、事务与历史系统，外部 agent 可以通过 CLI/MCP 执行同样的操作。软件不调用 AI 模型；字幕识别、素材生成等可由外部工具完成，再导入项目。

## 首批操作

- 分割：选择片段后在播放头处分割，Ctrl+B；左段保留 ID，右段得到新 ID。链接的画面/声音一起分割，右侧生成独立链接组。
- 裁切入/出点：保留可用源素材位置和原淡化进度；拖动片段两端也使用相同命令。 sourceIn 支持小数，避免 1.5 倍等速率切分后丢失源时间。
- 滑移：在片段属性中移动源入点，时间轴位置和片段长度保持一致。已知素材时长参与边界检查。
- 多选与移动：Ctrl 单击添加/取消片段选择，拖动选中片段移动整组；链接的片段一同移动。可链接/解除链接。
- 波纹删除：删除所选时间区间并移动后续轨道；跨越区间的音乐/字幕/其他片段会切分并保留两侧源位置。标记和入出点范围随内容移动。锁定的受影响轨道会阻止操作。
- 轨道锁定与片段声音开关：锁定防止剪辑误操作；声音可独立关闭，保留画面。
- I/O 入出点：保存工作范围，出点按当前帧包含在范围内。编辑器导出使用该范围；CLI/render_request 可以显式指定 start/end。
- 二创 BPM 节拍：按有理数 FPS 从时间公式生成标记，不累计逐拍舍入误差。可在工作范围内生成、替换同组节拍；每次最多 5000 个标记。
- SRT/VTT 字幕：导入为可编辑 JSON cue 文件、TS 组件、透明场景和视频轨道。只生成当前 cue，使用原生文字测量计算换行高度，避免长字幕被截断。

## 淡化与变速连续性

`fadeWindow:{offset,duration}` 记录原淡化窗口。分割/裁切默认保留原窗口，既有淡入、淡出不会在切口重新从零开始。显式修改 fadeIn/fadeOut 或使用 trim.fadePolicy=reset，会改为当前片段的淡化起点。

`sourceWindow:{sourceIn,duration}` 记录变速处理的原源区间。变速切分的两段从同一个缓存读取，避免分别调用 atempo 造成相位不同。缓存按素材 fingerprint、区间、速度和采样数量固定；预览与导出使用同一混音器。1×、1.5×、0.75× 在淡化内切分的真实 PCM 样本一致性测试已建立。

## CLI / MCP

MCP `sequence_edit` / CLI `sequence-edit --request request.json`：

```json
{
  "sequenceId":"main","revision":"CURRENT_HASH",
  "actions":[
    {"type":"split","clipIds":["shot-1"],"frame":135,"linked":true},
    {"type":"rangeIn","frame":30},
    {"type":"rangeOut","frame":239}
  ]
}
```

同批全部成功后才保存，失败不留下部分剪辑，撤销恢复整批。其他动作包括 trim、slip、move、remove（ripple）、deleteRange、link/unlink、trackLock、marker/removeMarker、workflow、beatGrid、clearRange。波纹删除是整个序列的时间删除，会处理所有受影响轨道；普通 remove 仅删除片段并留下空隙。来源时长未知时仍检查非负入点；已知时长额外检查源句柄。

MCP `captions_import` / CLI `captions-import --request request.json` 支持 content 或本地 path：

```json
{
  "sequenceId":"main","format":"srt","name":"中文字幕",
  "content":"1\n00:00:01,000 --> 00:00:03,000\n第一条字幕",
  "fontSize":42,"bottom":72,"revision":"CURRENT_HASH"
}
```

`captions_inspect` 查询 cue IDs、帧时间、文本和资源 FPS。生成的 components/captions-*.json 是权威字幕数据；通过文件或 project_apply 修改，再进行类型/画面预检。重叠 cue 默认拒绝，双语/多个说话人可以放入不同字幕轨道。导入过程不做语音识别，也不请求模型。

`measureTextBlock` 是 SDK 的原生排版测量接口，与渲染/选取共用分词和换行规则，返回 lines、lineCount、width 和 height。

## 预览修复

预览改用固定 canvas：PNG 完成解码后再提交图片，替换帧时保留上一个有效画面。播放期间不逐帧改变分辨率，可在“稳定预览”选择 480–1920px。工程版本、作用域、播放时钟与返回帧号参与检查，过期/倒退的播放帧不会提交。

## 验证与继续扩展

`examples/editing-lab` 包含三个原生生成并编码成视频的城市夜景镜头、音乐和可编辑 SRT 字幕，验证真实媒体导入、镜头裁切、混音、字幕与再次导出。它是程序化城市示例，不能代替真实实拍长片验收。

专业跟踪/稳定/转描、光流、抠像边缘工具、音频总线、源监视器、镜头元数据与素材代理自动选择、完整三维/GPU/HDR、曝光表和专业笔刷仍按整体路线继续推进。本批工作不代表已完成专业电影制作的全部能力。
