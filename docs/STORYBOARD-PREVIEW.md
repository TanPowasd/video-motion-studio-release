# 分镜编排、全片检查和预览传输

这一批扩展通用长视频/电影/科普编排，提供明确覆盖范围的质量检查，并优化实际桌面预览路径。软件继续不调用模型，Agent 用文件/SDK/CLI/MCP 创作。

## 分镜工程

`components/storyboards/*.json` 记录 kind=storyboard/version=1、稳定文档 ID、章节、镜头和配音。镜头可引用 scene、asset 或 sequence，保存名称、sourceIn、speed、duration；声音绑定引用已导入音频/视频/声音资源，支持 offset、sourceIn、duration、volume、fadeIn/out 和可选 trackId。

时间单位为 frames 或 seconds，后者使用工程有理数 FPS。每个边界由累计时间映射到整数视频帧，而不是分别取整镜头时长；例如 29.97fps 下 10 个 0.15s 镜头总长为 45 帧，长度交替为 4/5 帧。源入点保留分数帧。必须显式给静态素材时长，零帧镜头拒绝；配音超出镜头时要求明确修改，不静默裁切。

```json
{
  "kind":"storyboard", "version":1, "id":"film", "name":"科普短片", "unit":"seconds",
  "chapters":[{"id":"intro","name":"问题"},{"id":"detail","name":"解释"}],
  "shots":[
    {"id":"opening","name":"引入","chapterId":"intro","source":{"type":"scene","id":"opening-scene"},"duration":8,
     "narration":[{"id":"voice","assetId":"opening-voice","duration":7.5}]},
    {"id":"explain","name":"解释","chapterId":"detail","source":{"type":"scene","id":"detail-scene"},"duration":12}
  ]
}
```

`storyboard_plan` 指定 videoTrackId、audioTrackId/每个 narration.trackId，返回准确存储候选，使用原有 sequence_plan 检查源时长、素材、锁、重叠和媒体版本。可附加 operations 同时创建组件/场景/声音 JSON。只替换 `sb/documentID/` 所属片段和章节标记，保留手动内容；与手动内容重叠时拒绝，不隐式覆盖/波纹修改。默认不会缩短整个序列，以保护其他轨道与已有工作范围；必要时显式调整 sequence.duration。

每个视觉/声音片段有稳定 `sb/document/shot/kind` ID，共享 `linkedGroup=sb/document/shot`；章标记为独立稳定 ID。upsertShot/updateShot/removeShots/order 是短修改，order 必须含全部镜头 ID 一次。resource expectedHash 与工程 revision 防止过期编辑。项目格式/依赖检查失败时保留原工程；文件、素材 metadata、镜头/声音和标记共享一次撤销。

`storyboard_inspect` 默认分页 30 个镜头和对应实际放置，includeDocument 返回完整权威 JSON。计划默认最多返回前 30 个镜头摘要与 source-check 数量，detail=true 取完整证据；真正的操作/checks 仍在 hash 保护的 planId 中，避免把长剧本重复回传到上下文。声源 JSON 用候选源码 SHA-256 指纹，普通媒体用 size/mtime，并保留采样依赖 checks；新声音可以在尚未写盘时参加同一候选。

## 序列质量检查

`sequence_audit` 支持指定序列或准确 planId。结构遍历检查所有访问序列/片段的源范围、序列输出范围及同轨重叠。缺失素材/读取错误返回诊断；probeMedia=false 明确使用已注册 metadata，可能过时。

默认候选时间点包含首尾、镜头开始/中点/结束及相邻帧、章/标记和均匀抽样，再按整个时间范围分层选取，默认 24、最多 120 个输出帧。嵌套序列使用 sourceIn/speed/fades 映射来源时钟。结果提供 proposed/sampled/omittedFrames、fullFrameCoverage、结构序列/片段数，未抽到的时间不会标成已验证。

原生场景展开后的文字几何错误带 sceneId、clipId、输出帧、来源帧和精确 node/path/contextFrames locator。整张输出图像由统一渲染器生成，包含遮罩、合成、效果、转场和轨道层叠，并报告 pixel hash、可见比例、平均亮度/方差；无可见片段/近似纯色只是 review，可能是作品意图。最多保留 maxFindings，遗漏也计入 incomplete。

几何定位不证明被最终上层遮住的对象仍可见，实际 composite pixels 也不自动理解艺术正确性。此版本没有全片逐像素对象分割、公式正确性证明或语音理解。音频同步/可懂度应另查 audio_preview/audio_audit，镜头绑定不代替声音证据。

## 无损桌面预览

编辑器 `/api/frame?format=rgba` 请求未压缩 RGBA8 数据，绕过原先 PNG 编码与浏览器 PNG 解码。ImageData→ImageBitmap 后仍画在固定 canvas，并沿用版本、工作区、播放时钟、倒退/过期回复过滤；最近有效 PNG 和 RGBA 分开保留，语法/素材错误不会把一种格式误当另一种。Canvas 返回后立即释放，raw buffer 长度严格等于 width×height×4。

协议带 Format/Width/Height/Revision/Frame/Stale 和 Render/Encode-Ms headers。PNG 端点保持默认，用于 CLI/MCP 原生图像、缩略图、成片与旧客户端；raw 不进入 MCP 的 JSON/Base64 文本。

本地开发实测 1280×720 小型科普场景：PNG 传输准备约 18.6 ms，RGBA 约 1.6 ms；HTTP 总时间约 22–23 ms 与 11–12 ms，两者逐像素一致。RGBA 每帧 3,686,400 字节，远大于该场景约 63 KB PNG；结果适用于本机 loopback，不承诺远程网络或所有场景均加速。浏览器绘制、显示、复杂渲染和音频准备仍需分别测量，不能据此宣称 4K/两小时实时验收。

每个活动应用最多保留最近 PNG 与 RGBA 缓冲，分辨率上限仍是 UHD；一个 RGBA 最大约 33 MB。预览请求共享原有串行绘制队列，不并发改变渲染器状态。没有新增 GPU/D3D 共享纹理或丢损编码。

`scripts/check-storyboards.mjs --packaged` 用真实外部 MCP 完成场景/声音/分镜同一候选、保存前试听/全片检查、分页/重排/hash保护、120帧带声 MP4与整批撤销。`check-preview-transport.mjs --packaged` 用实际封装 HTTP 服务比对 640/1280 的 PNG/RGBA、版本/尺寸、格式隔离回退和真实耗时。测试验证有理数累计边界、独立手动内容保留、锁、来源定位/覆盖、嵌套时钟以及透明像素。
