# 音效与音乐制作

Vmotion 可以用可编辑 JSON 制作声音，而不只播放已有音频。软件不调用 AI 模型：外部 agent 通过 SDK、文件、CLI/MCP 编曲和设计音效，试听准确候选后再保存。

## 制作能力

| 部分 | 当前实现 |
|---|---|
| 编曲 | 多轨、音符/力度/声像、拍或秒时钟、分段 BPM、拍号、量化/转调/复制、增删音符、独奏/静音 |
| 乐器 | 正弦/三角/带限锯齿与方波、FM、确定性噪声、ADSR、扫频、Kick/Snare/Hat/Tom/Clap 鼓组 |
| 采样 | 已导入音频/视频的秒窗口、根音/变调、循环、包络；变调使用窗函数 sinc 带限插值，范围为根音上下四个八度 |
| 混音 | 轨道及总线音量/声像、线性自动化、后推子 Send、无循环总线路由、主输出 |
| 处理器 | 增益、低通/高通/峰值 EQ/高低架、失真、立体声 Delay、Chorus、算法 Reverb、软拐点 Compressor、立体声联动峰值 Limiter |
| 工程与交付 | JSON 声音素材、主时间轴放置、候选试听、一次撤销、波形/音乐驱动画面、PCM WAV/视频导出、MIDI 导入/导出 |

顶部“音乐”或素材库“新建声音”打开独立 `#/music` 工作区。参考 FL Studio 的 Pattern → Channel rack / Piano roll → Playlist → Mixer 工作流，采用 Vmotion 自有工程与界面。

- Playlist：Pattern 拖入、点击放置、移动、重复；双击片段进入钢琴卷帘。实例保持关联，修改同一个 Pattern 会更新所有实例。
- Piano roll：铅笔绘制、拖动、多选（Ctrl）、右边缘改长度、量化、复制、八度移调、力度和数值编辑；滚动/缩放，按可见范围绘制音符。
- Channel rack：16 步鼓机、一键添加 Kick/Snare/Hat，使用与卷帘相同的音符数据。
- Mixer：通道/总线/主输出音量、声像、Mute/Solo；右侧可视化编辑 ADSR/FM/采样窗口、8 类效果、路由/发送与音量/声像自动化。
- 工程设置：分段 BPM、拍号、长度、尾音、种子；高级 JSON 编辑仍保留。时钟可为拍或秒，现有音乐不隐式转换单位。
- 试听：准确候选的 10 秒范围试听，或生成整曲后通过本地 HTTP Range 流播放；完整 WAV/MIDI 可以导出未保存候选。“保存并加入轨道”同时保存乐曲和视频片段；超出序列时长时返回明确错误，需先延长视频序列。

草稿具有最多 24 步本地撤销/重做及标签页内 sessionStorage 恢复；保存走共享 preflight/apply，保存后的历史使用工程 undo/redo。外部修改同一乐曲源文件时阻止覆盖并保留草稿，复制 JSON 合并或重新载入。新建/切换不会改写已有乐曲。源文件和注册素材不能作为 WAV 导出目标。

VST3 插件和实时 MIDI 已接入，可用外接键盘、电脑键盘、屏幕键盘录入音符；AU 有 macOS 后端源码，尚未实机验收。详见 [插件与 MIDI](AUDIO-PLUGINS-MIDI.md)。尚无录音、ASIO 低延迟驱动、音频弹性编辑或专用 Pattern 试听模式；试听当前整曲编排。Mixer 主输出电平显示最近一次试听峰值，并非实时通道电平。

## 文件与 SDK

声音的权威来源为 `components/sounds/*.json`；素材声明 `type:"audio"`，`path` 与 `soundSource` 指向该文件。配置进入工程版本和历史记录，缓存 PCM 不入源码。普通音视频保持原素材文件，采样用稳定 assetId 引用；`pack` 收集采样源并保留声音 JSON，移走原素材后仍可渲染。

可选 `patterns` 保存 `{id,name,length,channels:[{trackId,events}]}`；`arrangement` 保存 `{id,patternId,at,repeats}`。Pattern 时间沿用乐曲的拍/秒单位，关联通道引用稳定 trackId；轨道自身 events 可与 Pattern 并存。所有消费者共享展开逻辑，实例 ID 确定且随机跳播稳定；展开前检查最多 20000 音符预算、引用、长度和重复 ID。旧工程未声明这两个字段时保持原有行为。SDK 导出 SoundPattern / SoundEvent / SoundTrack 与 expandSoundTracks。

```ts
import { compileSound, soundPreset } from '@vmotion/sdk';
const score = compileSound({
  kind: 'sound', version: 1, id: 'music', name: '主题旋律',
  unit: 'beats', duration: 8, tail: 1,
  tempo: [{ beat: 0, bpm: 120 }],
  tracks: [{
    id: 'lead', name: '旋律', instrument: soundPreset('bell'),
    events: [
      { id: 'c', at: 0, duration: 1, note: 'C4', velocity: .8 },
      { id: 'e', at: 2, duration: 1, note: 'E4', velocity: .7 },
      { id: 'g', at: 4, duration: 2, note: 'G4', velocity: .8 }
    ],
    effects: [{ type: 'delay', seconds: .25, mix: .2, feedback: .3 }],
    automation: [{ property: 'pan', keys: [{ at: 0, value: -.4 }, { at: 8, value: .4 }] }]
  }],
  master: { effects: [{ type: 'limiter', ceilingDb: -1 }] }
});
```

`SoundRenderer.process()` 是有状态的顺序分块 DSP；每次独立渲染都从起点创建实例。视频组件仍使用纯 `ctx` 时钟，并可将音符布局由 `compileSound` 生成，或通过已有 `audioAssetId` 读取真实合成声音分析。不能把顺序 DSP 实例当作随意跳帧的组件状态。

拍单位是四分音符拍；拍号不改变 BPM 的时间含义。`tempo` 必须从 beat=0 严格递增，映射拍↔秒后按 48 kHz 取采样位置。`event.duration` 是按键时长，release 是秒；音效尾音只能保留在显式 `document.tail` 与总时长内，不会自动延长整个视频。`endNote` 产生按秒连续扫频。采样变调会改变内容播放速度，不是保音高的时间拉伸；主时间轴已有独立 speed 处理。

轨道声像为立体声 balance，合成单声部事件使用等功率声像。效果在轨道音量/声像之前，Send 在后推子位置；总线按无循环顺序处理，最后主输出。总线反馈应使用有界 Delay/Reverb 内部状态，不能把路由连接成环。

## Agent 接口

1. `agent_guide topic=sound` 与 `sound_library` 查询乐器和工作流；`project_schema` 可按需查询 sound、soundInstrument、soundEffect。
2. `sound_inspect` 查询资源 hash、总线顺序、真实采样位置及分页稳定音符 ID。`includeDocument=true` 才返回完整 JSON。
3. `sound_plan` 支持完整资源或 `settings/upsertTrack/updateTrack/removeTrack/upsertEvents/removeEvents/transformEvents` 短修改；转换支持量化、转调、偏移、时间/力度缩放和明确复制。多资源与可选时间轴放置共享一个候选；拒绝轨道锁、范围越界和资源覆盖歧义。
4. `sound_preview {assetId,planId,...}` 试听未提交的准确候选，返回原生 audio block、峰值/RMS/波形和 fullMix 削波报告。`revision` 是当前工程基准，响应 revision 是实际候选版本。随机范围从同一完整 DSP 结果截取，保留混响/延迟/压缩器历史。
5. `project_preflight` 检查结构、类型、依赖和组件；声音质量需要单独试听和检查，不能把结构通过当成听感证明。原样 `project_apply` 保存并共享一次撤销。采样 fingerprint 变化拒绝提交。
6. `sound_export` 用 assetId 和可选 planId 导出整曲浮点 WAV（48 kHz/stereo、保留效果尾音），只返回路径、指标与播放 URL，不传 Base64。`sound_midi action=export` 也可用 planId 导出准确候选。`audio_preview` 检查视频主时间轴，`render_start` 导出序列 WAV/MP4。CLI 对应 sound-library、sound-inspect、sound-plan、sound-preview、sound-export、sound-midi，接收 `--request` JSON 文件；全部也可用通用 tool-call。

MIDI 读取 format 0/1 PPQ、音符/力度、速度变化、running status 与延音踏板；General MIDI 音色映射到本地预设。当前不还原外部插件、弯音、压力、其他控制器或拍号变化，返回具体遗漏提示。MIDI 输出 format 1 包含音符/速度/初始拍号；采样、效果、混音、扫频不进入标准 MIDI，明确报告。速度受标准整数微秒分辨率影响，不宣称浮点 BPM 完全相等。原 MIDI 不被改写。

## 验证与边界

缓存采用资源内容和采样路径/fingerprint 标识，构建期间核对采样，原子发布浮点 WAV。长采样先解码到磁盘 PCM，再每轨最多保留 8 个 4096 帧页面（256 KiB）；一次声音资源最多 30 分钟、64 轨、16 总线、20000 事件、每轨 256 同时声音、2 GB 解码磁盘银行、64 MB 效果状态和 20 亿估计工作量。超预算返回诊断，不静默降低声音质量。多段声音资源可在视频工程中编排更长内容；此上限不是长视频性能验收。

主合成及 sound_export 保留 float32 样本和超幅证据；范围试听 WAV 是 16 位 PCM，超过全幅时会报告削波，需明确降增益或加 limiter。Limiter 为无预读联动峰值保护，不是 true-peak/LUFS 认证；Reverb 为本地算法混响，没有脉冲响应卷积。音乐素材内不支持 sidechain、LUFS 标准化和空间音频；视频序列混音已有侧链与响度处理。

`tests/sound*.test.ts` 验证频谱、拍↔采样、块分割一致性、带限采样、DSP 尾音、MIDI 延音、候选/接受/时间轴试听一致、随机范围、原子撤销、长采样及打包重渲染。`scripts/check-sound.mjs --packaged` 使用真实外部 MCP、封装运行时及 WAV/带音频 MP4 检查；`check-desktop-projects.mjs --packaged --sound` 实测新建、音符编辑、草稿试听、发布和时间轴放置。

`examples/sound-lab` 为 14 秒原创配乐/音效演示（1280×720、30fps、420 帧），包含和弦、旋律、低音、鼓组、铃声采样、扫频与空间总线，提供编辑 JSON、源码、WAV 和 MP4。生成脚本仅在显式 `--rebuild` 时改写已有示例；`--render-only` 保留现有修改。
