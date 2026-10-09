# 可复制的 Windows 便携包

`release/Vmotion-Windows-x64-Portable.zip` 解压得到一个完整 `Vmotion` 文件夹。复制整个文件夹到 Windows 10/11 x64 的可写目录，双击 `Vmotion.exe` 或 `启动 Vmotion.cmd`。不需要安装 Node.js、Rust、FFmpeg 或编译器，编辑、预览和导出可以离线运行。此版本使用本机正常的 Windows 系统组件和显卡驱动；GPU 不可用时 auto 使用 CPU。

如果旧版目录正被桌面或外部 MCP 会话使用，可通过 `VMOTION_PACKAGE_ROOT` 在 `release` 下并排打包。打包、ZIP、发布脚本和 `npm run test:acceptance` 使用同一变量，默认路径保持不变。例如 PowerShell：

```powershell
$env:VMOTION_PACKAGE_ROOT = Join-Path $PWD 'release/v0.1.3/Vmotion'
npx tsx scripts/package.ts
npm run test:acceptance
powershell -NoProfile -ExecutionPolicy Bypass -File scripts/portable-zip.ps1
```

上例生成 `release/v0.1.3/Vmotion` 和同目录的 ZIP。原有会话继续使用旧版；结束会话后可改用新目录下的启动文件和 MCP 配置。

包内包含 Electron/Node、React 界面、自研 CPU/GPU 核心、TypeScript 编译器与 SDK、FFmpeg/FFprobe 及同目录 DLL、Noto Sans CJK SC 字体和 CPython 标准库。Python 许可保留在 runtime/licenses，下载版本和哈希记录在 runtime manifest。额外 Python 包通过 VMOTION_PYTHON 自定义环境管理，须单独迁移。项目字体优先，复现排版须收集字体；保留第三方许可、FFmpeg 对应源码和固定 LGPL shared 构建。

同时内置独立 VST3 音频宿主（静态 C runtime）和 MIDI 实时监听界面。Steinberg VST3 SDK / nlohmann-json 均使用固定 MIT 版本，notices/provenance 在 native/licenses/audio。商业 VST3 插件不随软件分发：另一台电脑需要另行安装/授权同一版本，并修改工程中的插件路径/指纹；pack 保留音色状态，不能替代插件安装。详见 [音频插件与 MIDI](AUDIO-PLUGINS-MIDI.md)。AU 后端只适用于 macOS，当前 Windows 包不提供 AU。

`portable.flag` 使桌面设置/最近项目保存在包内 `profile` 目录，首次运行自动生成。ZIP 不包含开发机 profile 或生产工程。工程可以保存在任意可写位置，更新时建议解压到新目录再复制自己的 profile；不要覆盖正在运行的程序。删除 portable.flag 后使用通常的 Windows 用户数据位置。

`vmotion.cmd` 是随包 CLI/MCP 入口，用相对路径启动内置 Node 与编译器。例如：

```powershell
.\vmotion.cmd init --project "D:\视频工程"
.\vmotion.cmd validate --project "D:\视频工程" --json
.\vmotion.cmd render --project "D:\视频工程" --output "D:\视频工程\exports\video.mp4"
.\vmotion.cmd mcp --project "D:\视频工程"
```

外部 agent 也可直接启动 Vmotion.exe，环境设置 ELECTRON_RUN_AS_NODE=1，参数为包内 `resources/app/dist/cli/index.mjs mcp --project 实际工程目录`。MCP 标准输出只有协议，运行时路径从可执行文件/模块位置自动解析，移动后需更新外部 agent 的启动配置路径。VMOTION_FFMPEG/FFPROBE/NATIVE/SDK_SOURCE/ESBUILD_BINARY_PATH 的显式覆盖仍可用于开发，不是正常便携使用所需。

**迁移已有工程时，软件和工程是两份目录。** 默认导入素材可能引用电脑外部路径，先在软件中收集素材，或执行 `vmotion.cmd pack --project 工程 --output 收集目录`，再复制收集后的整个工程。字体、第三方组件依赖和项目外部引用必须随工程保留；单独复制工程 JSON 或软件 exe 不能带走这些资源。

`portable-manifest.json` 描述入口和构建版本；`resources/runtime/manifest.json` 固定下载来源与文件哈希；ZIP旁的 `.sha256` 用于验证复制完整性。构建 `npm run package:dir` 自动准备锁定运行时，下载缓存保存在忽略的 artifacts，不入 Git。`powershell -NoProfile -ExecutionPolicy Bypass -File scripts/portable-zip.ps1` 生成 ZIP，并排除个人 profile。首次打包需要网络下载；使用者运行不需要网络。

验证：`node scripts/check-portable.mjs` 把包复制到中文/空格的新路径，只保留 Windows System32 的 PATH，并删除开发环境变量。真实 stdio 客户端检查 TS/SDK 编译、中文测量、视频尾帧、PNG预览/导出一致、带声音60帧MP4、CLI桥接和撤销。`node scripts/check-desktop-projects.mjs --packaged --isolated` 检查启动、新建/打开与重启恢复。模拟隔离环境已验证；不同实体电脑/驱动的兼容性仍随设备而异。
