# 本地声音预览与混音检查

工程总览/剪辑工作区的播放按钮同时启动画面和声音。主时间轴支持暂停、从播放头开始、跳转、监听静音与监听音量；声音电平显示混音信号的峰值。监听设置只影响本机试听，片段音量与轨道静音仍写入工程并影响导出。

播放器按 48 kHz 采样位置读取 4 秒混音片段，提前加载后续片段。使用 Web Audio 的时间时钟驱动播放头；缓冲不足时保留当前位置等待声音。项目版本改变会重新准备当前位置的混音。暂停/跳转会停止旧声音并取消未完成的请求。后端缓存上限 32MB，单次 agent 检查最多 10 秒，不把整支长视频音轨放入内存。

声音与导出共用混音器，支持：

- 音频/视频素材片段、多音轨与轨道静音。
- 原始素材裁切、变速并保留音高。
- 嵌套序列的速度、音量和父子淡入淡出包络。
- 采样精度的范围、延迟和长度；片段中间的试听保持正确淡化位置。
- 单声道复制到左右声道；多声道通过 FFmpeg 下混至立体声。
- 混音峰值限制在 ±0.95，不对较轻声音自动增益。该保护采用逐样本限幅，专业响度/母带总线仍待实现。

变速音频先写入可复用的浮点 WAV 源缓存，后续预览和导出按采样位置读取相同结果，避免每段重新变速造成相位改变。首次试听变速片段可能等待缓存生成；过程可取消，缓存写入通过临时文件替换，不进入工程源码。当前缓存磁盘大小尚未提供自动配额，应在后续缓存管理中补齐。

当前声音由主序列的素材片段及嵌套序列提供，也支持可编辑 JSON 声音素材的合成/采样结果。独立场景/组与代码工作区使用静音画面预览；`ctx.audio` 是动画分析输入，不自动成为音轨。声音资源内部总线、均衡/压缩与音效见 [SOUND-MUSIC.md](SOUND-MUSIC.md)；序列级总线/侧链和响度增量见下文，场景内视频声音路由仍需深化。

增量：序列 mix 已接通轨道/总线/主输出、侧链 ducking 和实测响度标准化，audio_mix_plan/inspect/audit 与 audio_preview planId 提供准确候选检查；完整历史状态沿用同一缓存，子序列处理先于父级变速/淡化。详见 [PERFORMANCE-TRANSITIONS.md](PERFORMANCE-TRANSITIONS.md)。这不包含场景内部声音路由、录音/VST 或完整 DAW。

新导入的音视频记录时长、采样率、声道及画面尺寸。直接加入轨道时默认使用实际素材时长，并限制在序列范围内；也可显式设置 duration。旧素材没有 metadata 时保留默认长度，可在时间轴调整。

外部 agent 使用相同的采样级混音检查：

```powershell
node dist/cli/index.mjs audio-timeline --project examples/audio-lab --sequence main
node dist/cli/index.mjs audio-preview --project examples/audio-lab --sequence main --start-sample 96000 --samples 192000 --output ./preview.wav
```

`audio_timeline` MCP 默认分页返回24个可听片段的 sourceIn、effective speed/volume、淡化包络和 start/endSample；offset/limit继续查询，totalClips/nextOffset显示覆盖，includeAll=true请求完整时间线。静音轨道不进入混音，分页只限制返回数据。声音查询、计划、试听、MIDI、混音与质量检查现由统一vmotion.audio内置插件分发。`audio_preview` 返回 48 kHz、立体声、16 位 WAV 音频及以下诊断：

| 字段 | 含义 |
| --- | --- |
| startSample / sampleCount | 此次检查的精确位置与长度 |
| revision | 所用工程版本 |
| clipCount | 参与混音的实际片段数量 |
| metrics.rms / peak | 此范围的均方根与峰值 |
| metrics.limitedSampleRatio | 触及 ±0.95 上限的采样比例 |
| metrics.levels | 分段 RMS/峰值，可绘制波形或查找静音区间 |

```json
{
  "sequenceId": "main",
  "revision": "<project-revision>",
  "startSample": 96000,
  "sampleCount": 192000
}
```

MCP 响应包含原生 audio 块，可供支持音频的 agent 检查。它只调用本地媒体管线，不接入模型。素材变化会使音频缓存失效；混音期间变化会返回诊断。

`examples/audio-lab` 是声音/画面同步示例，使用合成节奏与代码动画验证分段播放和时间轴控制。预览需要本地 FFmpeg/FFprobe，与当前视频导出使用相同的运行时。
