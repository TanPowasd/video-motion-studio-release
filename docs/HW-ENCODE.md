# 硬件视频编码

MP4 导出的视频编码由 FFmpeg 完成。Vmotion 渲染出的 RGBA 帧按 5 秒分段经管道送入 FFmpeg，编码器可以是软件（libopenh264/libx264、libx265、SVT-AV1/libaom）或显卡/系统硬件编码器。渲染本身仍是原 CPU/Skia 与局部 Direct3D12 特效路径（见 [显卡特效](GPU-EFFECTS.md)），硬件编码只替换“帧 → 码流”这一步。程序不接入模型。

## 选择编码器

| `encoder` | 含义 |
|---|---|
| `auto` | 默认。按平台优先级尝试硬件编码器，**只有探测成功**才使用；全部失败时确定地使用软件编码器，并在 `fallbackReason` 写明每个候选失败原因 |
| `software` | 只用软件编码器，不探测、不启动显卡编码器 |
| `nvenc` / `qsv` / `amf` / `mediafoundation` / `videotoolbox` / `vaapi` | 必须使用该后端；FFmpeg 未内置或探测失败时任务直接报 `ENCODER_UNAVAILABLE`，不回退 |
| 其它字符串 | 原样作为 FFmpeg 编码器名（旧行为，如 `libx264`、`h264_nvenc`），只检查是否在编码器列表中 |

平台优先级：Windows `nvenc → qsv → amf → mediafoundation`（`h264_mf/hevc_mf` 使用 `-hw_encoding 1`，只接受硬件 MFT）；macOS `videotoolbox`（`-allow_sw 0`）；Linux `nvenc → vaapi → qsv`（VA-API 设备默认 `/dev/dri/renderD128`，可用 `VMOTION_VAAPI_DEVICE` 指定）。

`codec` 为 `h264`（默认）、`hevc` 或 `av1`。各后端提供：NVENC/QSV/AMF/VA-API 三种都有；Media Foundation 与 VideoToolbox 只有 H.264/HEVC，请求 AV1 返回 `ENCODER_UNSUPPORTED`。软件链：H.264 `libopenh264 → libx264 → mpeg4`（保持历史顺序；mpeg4 为最后兜底并在 `fallbackReason` 注明），HEVC `libx265`，AV1 `libsvtav1 → libaom-av1`；缺少时报 `NO_ENCODER`。注意：随包的 Windows FFmpeg 是 LGPL 构建，没有 libx264/libx265，因此 Windows 上软件 HEVC 不可用，HEVC 需要硬件编码器。

取值优先级（逐字段）：单次请求 → 工程 `project.videoExport` → 环境变量 `VMOTION_ENCODER` → `auto`。

- CLI：`vmotion render -o out.mp4 --encoder nvenc --codec hevc --crf 22 --preset quality --keyint 60 --bit-depth 10`；`--bitrate <kbps>` 优先于 `--crf`。
- CLI 探测表：`vmotion encoders --project <dir> [--codec h264 hevc av1] [--bit-depth 10]`。
- MCP：`render_start {encoder:"auto", codec:"hevc", quality:{crf:22, preset:"quality", keyframeInterval:60, bitDepth:10}}`，没有新增工具。
- 工程默认：`updateProject {patch:{videoExport:{encoder:"nvenc", codec:"hevc", quality:{crf:22}}}}`；编辑器导出对话框的“视频编码器 / 编码格式 / 速度·质量 / CRF / 10-bit”字段可“设为工程默认”，“检测硬件编码”按钮显示本机探测表。

## 探测与缓存

探测分两步：`ffmpeg -hide_banner -encoders` 判断是否编译了该编码器；再做一次**真实小样编码**——64 帧 256×256 RGBA，经与导出完全相同的 `rawvideo` 管道、像素格式和码率参数，输出到 `-f null`。只有退出码为 0 才算可用；失败时记录 FFmpeg 最先打印的根因行（例如 `Cannot load libcuda.so.1`、`No VA display found`）。

结果在进程内缓存，键为 FFmpeg 可执行文件内容 SHA-256 + 驱动指纹（Windows 为 `nvEncodeAPI64.dll`、`nvcuda.dll`、`amfrt64.dll`、`libmfxhw64.dll`、`libvpl.dll`、`mfplat.dll` 的大小/修改时间与系统版本；Linux 为 `/proc/driver/nvidia/version` 与 `/dev/dri` 列表）。8-bit 与 10-bit 分别探测（Main10 支持因显卡而异）。单次探测超时默认 30 秒，可用 `VMOTION_ENCODER_PROBE_TIMEOUT_MS` 调整。驱动在进程运行期间更新不会被自动发现，重启服务即可重新探测。

`capabilities.videoEncode` 返回默认模式、平台优先级和本进程已探测的行；`render_status` 的 `encoder` 字段返回 `requested/mode/codec/used/hardware/bitDepth/fallbackReason/probe`，以及 `segments/encodedSegments/resumedSegments/segmentWallMs/encoderWaitMs`。`segmentWallMs` 是各编码分段从启动编码器到关闭的总时长（含为其渲染帧的时间），`encoderWaitMs` 是渲染循环因编码器背压等待及收尾冲刷的时间，后者越大说明编码器是瓶颈。

## 续渲染与失败

导出开始前解析编码器，并把 `{实际编码器, 模式, 完整参数, FFmpeg 哈希, 硬件时的驱动指纹}` 写入渲染缓存键、`encoder.json` 和每次 `checkpoint.json`。续渲染只复用身份完全相同的分段：

- 同一设备恢复后再次导出，只重渲染未完成分段，仍用原编码器。
- 若硬件已不可用，`auto` 会回退软件，但身份不同，因此使用新的检查点目录从头编码，**不会把硬件分段与软件分段拼在一起**。
- 显式硬件模式下不可用直接失败。
- 已开始的导出中途编码失败（设备丢失、驱动重置、编码器退出）时任务 `failed`，错误含编码器名、分段号和 FFmpeg 根因，已完成检查点保留；同一导出内不静默切换编码器。

HEVC 分段与最终封装使用 `-tag:v hvc1`，便于 Apple 播放器识别；H.264 封装参数不变。

## 质量参数映射

`quality` 字段：`crf`（0–51，AV1 0–63）、`bitrateKbps`（优先于 crf）、`preset`（`speed|balanced|quality`）、`keyframeInterval`（帧）、`bitDepth`（8 或 10，10-bit 只用于 HEVC/AV1）。

| 编码器 | 速度档 speed/balanced/quality | 恒定质量 | 码率 | 像素格式 8/10-bit |
|---|---|---|---|---|
| libx264 | superfast/veryfast/slow | `-crf` | `-b:v -maxrate -bufsize` | yuv420p |
| libopenh264 / mpeg4 | — | 不支持（忽略并在 notes 说明，用 20M） | `-b:v` | yuv420p |
| libx265 | superfast/veryfast/slow | `-crf` | `-b:v` | yuv420p / yuv420p10le + main10 |
| libsvtav1 | 10/8/5 | `-crf` | `-b:v` | yuv420p / yuv420p10le |
| libaom-av1 | cpu-used 8/6/4 | `-crf -b:v 0` | `-b:v` | 同上 |
| NVENC | p2/p4/p6，`-tune hq` | `-rc vbr -cq N -b:v 0` | `-rc vbr -b:v -maxrate(1.5×)` | yuv420p / p010le |
| QSV | veryfast/medium/veryslow | `-global_quality N` | `-b:v -maxrate` | nv12 / p010le |
| AMF | `-quality speed/balanced/quality`，`-usage transcoding` | `-rc cqp -qp_i/-qp_p(/-qp_b)`；AV1 为 crf×4（0–255） | `-rc vbr_peak` | nv12 / p010le |
| Media Foundation | — | `-rate_control quality -quality`（crf 线性映射到 100–0） | `-rate_control cbr` | nv12（无 10-bit） |
| VideoToolbox | — | 仅显式 crf 时 `-q:v`（Apple 芯片）；否则 `-b:v 20M` | `-b:v` | nv12 / p010le |
| VA-API | — | `-rc_mode CQP -qp`；AV1 为 crf×4 | `-rc_mode VBR` | `-vf format=nv12/p010,hwupload` |

所有编码器统一设置 `-g`（若指定关键帧间隔），H.264 硬件设置 `-profile:v high`，HEVC 设置 `main/main10`。未指定任何质量参数时，硬件默认 crf 等价值 H.264 18、HEVC 20、AV1 30。不同编码器的同名数值画质并不等价，CRF 只是统一的入口刻度。

**软件逐字节一致**：`software`（以及 `auto` 回退到软件）在未指定质量参数时使用与此前完全相同的 FFmpeg 参数（libx264 `-preset veryfast -crf 18 -pix_fmt yuv420p`，libopenh264/mpeg4 `-b:v 20M`），同一 FFmpeg 下输出 MP4 与旧版本字节相同；仅 `crf:18` 也得到相同参数。唯一差异：旧默认链在缺少 libopenh264/libx264 时会选 `h264_mf`，现在 `software` 不使用 Media Foundation，而 `auto` 会在其探测成功时使用它。

## 性能工具

`render_profile` 与 `render_compare` 默认不编码，结果与之前一致。`render_profile {encoder:"nvenc", codec:"h264", encodeFrames:300}` 会把首轮采样帧循环送入编码器（空输出），返回 `videoEncode {used, fallbackReason, frames, wallMs, framesPerSecond, backpressureMs}`；墙钟包含编码器启动。`render_compare {baseline:{encoder:"software"}, optimized:{encoder:"auto"}}` 两侧分别计时，只设一侧时另一侧默认 `software`，`difference.encode` 给出前后毫秒与加速比。编码时间与像素等价判断分开：有损码流不做哈希对照。采样帧保留上限 256MB RGBA。

## 真机验证（Windows）

本仓库在 Linux arm64 无显卡环境验证了：`auto` 探测 `h264_nvenc`（`Cannot load libcuda.so.1`）、`h264_vaapi`（无 VA 设备）失败后回退 libx264，输出与旧软件路径 SHA-256 相同；其余硬件路径（参数映射、探测缓存、显式失败、中途设备丢失、续渲染固定）由假 FFmpeg 单元/集成测试覆盖。真实硬件需要在 Windows 参考机执行：

```powershell
npm run build
node scripts/check-hw-encode.mjs                      # 使用 dist/runtime 或 PATH 中的 FFmpeg
node scripts/check-hw-encode.mjs --packaged           # 使用 release/Vmotion 随包 LGPL FFmpeg
node scripts/check-hw-encode.mjs --width 3840 --height 2160 --frames 600 --strict
npx vitest run --config vitest.config.ts tests/hw-encode.test.ts tests/hw-encode-export.test.ts
```

脚本打印探测表（8-bit 与 10-bit），对软件与每个探测成功的硬件编码器做 `render_profile` 编码计时（fps 及相对 libx264/软件 H.264 的倍数），再经真实 `vmotion render --encoder <mode> --codec <codec>` 导出并用 ffprobe 检查编码格式、profile、pix_fmt、逐帧计数和完整解码无错误，最后确认 `--encoder auto` 选中了优先级中第一个通过探测的后端。报告写入 `artifacts/hw-encode/report-*.json`；任何导出或校验失败退出码为 1，`--strict` 时没有任何硬件编码器通过探测也算失败。Windows 下假 FFmpeg 测试会跳过（脚本形式的假可执行文件需要 POSIX），真实性以本脚本为准。

CI（`.github/workflows/windows.yml`）在托管 Windows runner 上以 `--width 1280 --height 720 --frames 60 --export-frames 30` 非严格运行本脚本并上传报告：runner 无显卡，硬件行预期不可用，只验证软件导出（及可能存在的 `h264_mf` 软件 MFT）与 auto 回退；不代表硬件编码结论。

尚待真机确认：各厂商驱动下 10-bit HEVC/AV1 支持、AMF/Media Foundation 质量映射的主观效果、长片中驱动重置时的错误文本、Intel 核显 QSV 在无显示器会话下的可用性。
