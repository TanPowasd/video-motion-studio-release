# 外部音频插件与实时 MIDI

Windows 10/11 x64 版本支持 VST3 乐器和效果。插件在独立原生宿主进程中扫描、加载和处理，不进入 Electron 渲染进程；二进制 PCM 传输，不把实时音频编码为 JSON/Base64。AU 使用 macOS Audio Unit API 的独立后端；Windows 上请求 AU 会返回 AUDIO_PLUGIN_PLATFORM。

当前 Windows VST3 后端经过真实加载、原生编辑器、参数/状态、MIDI、候选音频、导出、封装 stdio 和窗口验证。AU 源码及 macOS 构建入口已提供，此次没有 macOS 设备，AU 尚未经编译/实机验证，不能视为已验收的 macOS 产品。VST2 不在本次实现范围。

## 使用

1. 音乐工作区选择通道，右侧“乐器”输入 `.vst3` 文件/目录路径，或留空扫描 Windows `Common Files/VST3`；点击“扫描插件”选择乐器。效果链下也可添加 VST3/AU 效果。
2. “读取参数”显示 normalized 0–1 参数。“打开插件界面”打开插件提供的原生窗口；有些插件没有自定义窗口或需要特定宿主接口，此时返回错误并保留参数编辑方式。
3. 原生窗口编辑后点击“捕获音色状态”，将 processor/controller 状态与参数写入当前乐曲草稿，再保存。实例化插件、打开窗口不会隐式改写工程。
4. 顶部“MIDI 演奏”→“开启实时演奏”。屏幕键盘/电脑 A W S E D F T G Y H U J K 可以立即演奏；“连接 MIDI 键盘”申请本地 Web MIDI，选择已连接输入。当前应用请求 `sysex:false`，忽略系统/SysEx 消息。Chromium 可能仍将该权限标记为 midiSysex，桌面只对当前本地编辑器窗口放行。
5. “录入音符”从当前 Pattern/整曲的零时刻开始，使用 supplied timestamp、tempo map 和当前网格。支持力度、重叠音符、零力度 Note Off、延音踏板；停止后成为一次可撤销的草稿编辑。已存在音符保留。离焦、换通道、换 Pattern、关闭监听或点击 Panic 会释放音符并结束录入。
6. VST3/AU 乐器可在实时监听里打开原生窗口、捕获音色。保存、候选试听、整曲 WAV 和视频序列继续使用同一声音资源/效果/总线核心。

## 工程与 Agent

`type:"plugin"` 可用于乐器或音乐素材内效果：

```json
{
  "type": "plugin",
  "format": "vst3",
  "path": "C:/Program Files/Common Files/VST3/MySynth.vst3",
  "classId": "914A61E128FE4B22A4B63751C50BE933",
  "parameters": { "1": 0.25 },
  "release": 0
}
```

乐器有 `release`，效果不使用此字段；`name`、`fingerprint`、Base64 `state`/`controllerState` 可选。`sound_plan` 校验并记录安装二进制的 fingerprint；变更会明确拒绝，不能悄悄用新的音色替换被检查的候选。插件缓存 key 包含声音文件、采样证据、插件证据和宿主版本路径；音频效果顺序、轨道/bus/master 合成与既有内置乐器保持一致。每个插件从起点连续求值，随机范围从完整 DSP 缓存截取。

- `audio_plugins action=scan` 只扫描显式位置/默认插件目录，上限 256 个包、每个独立进程 10 秒；`inspect` 返回参数与延迟信息。
- `sound_inspect` 默认不发送 plugin state/controllerState，仅返回编码状态大小、前 16 个参数和 parameterCount/parametersMore。需要完整音色时显式 includeDocument=true 或读源文件；完整状态只出现在 document 一处。不要把参数摘要当作完整配置覆盖源文件。
- `audio_live` 管理临时 open/query/parameters/editor/state/panic/close。`state` 是显式读取，不常驻 MCP 上下文；将返回状态并入 sound_plan，再检查与准确提交。实时 PCM endpoint 面向本地音乐监听，不通过 MCP 逐块传音频。
- 默认 MCP 仍 10 个入口，147 项能力按需发现。音乐 15 项能力复用统一模块、候选与 undo。必要时只读取 `tool_schema paths`，复用 schemaHash/ifHash。
- `pack` 保留工程里的插件路径/状态，不复制商业插件安装程序、二进制或许可证。迁移到另一台电脑需安装匹配的插件，并明确更新路径/指纹；状态不保证跨插件版本通用。

## 预算与当前边界

离线每乐曲最多 32 个插件实例、4 MiB 编码状态；每次最多 4096 帧 PCM，通过持续子进程/预计算 MIDI 时间表复用状态。扫描和宿主超时/退出会给诊断并清理进程树。Windows 宿主使用静态 C runtime，便携版不要求另外安装 Visual C++ 运行库；插件自身的运行库/授权仍由其厂商提供。VST3 SDK 3.8.1 的 package UTF-8 路径问题在构建时局部修正，中文/空格目录验收通过。

实时监听使用 AudioWorklet 和 Web Audio 输出，默认 512 帧请求、有界预缓冲/欠载计数；这是交互式监听，不是 ASIO/CoreAudio 专用音频回调。没有测量硬件端到端延迟。外部乐器监听当前乐器和增益，完整效果/总线在项目试听/导出中处理；内置合成器/鼓组实时监听用 Web Audio，最终 DSP 与离线声音引擎一致性仍以导出为准。本地 sample 通道需要外部采样器才能实时演奏。

第三方插件可能非确定性、要求特定宿主接口或输出多声道。当前接受 float32 mono/stereo main bus；不支持多输出/sidechain bus 和 MPE，整数 MIDI 音符以外的扫频/单音声像返回明确诊断。离线插件声明非零 latency 时当前拒绝导出，请选择零延迟模式或先在外部冻结音频；尚无自动插件延迟补偿。插件请求 IO/latency restart 也需捕获状态并重新打开，不能静默漂移。

Windows 已安装的 XSampler 经扫描、26 参数和音频块加载验证；它的原生 createView 抛出 bad function call，属于目前未兼容的自定义界面。测试用原生 VST3 乐器/效果及窗口均通过，不能由此宣称兼容所有商业插件。此次机器没有物理 MIDI 输入设备：实际桌面 Web MIDI 权限/枚举通过（0 输入），录入通过真实屏幕/电脑事件与录音器的踏板单测验证。

构建：Windows `pwsh -File scripts/build-audio.ps1`；macOS/Linux `bash scripts/build-audio.sh`。SDK 固定 commit `3cdf9ca...`、nlohmann/json 3.12.0 固定 SHA256，第三方依赖均为 MIT 并随便携包保留 notices。原生 fixture 仅用于验收，不发布商业插件。`scripts/check-audio-plugins.mjs --packaged` 与 `check-music-studio.mjs --packaged --live` 提供真实 stdio/窗口检查。
