# Vmotion

本地可编程的视频创作工作站，Windows 10/11 x64 首发，第一方源码采用 Apache-2.0。项目以 JSON + TypeScript 保存，支持自定义 Python 渲染器、WGSL 着色器和外部 VST3。程序不调用 AI 模型。

[下载便携版](https://github.com/TanPowasd/video-motion-studio-release/releases) · [创作指南](docs/STUDIO-GUIDE.md) · [Agent 工作台](docs/AGENT-WORKBENCH.md) · [能力与边界](docs/FEATURES.md)

## 两个独立入口

| 入口 | 面向 | 使用方式 |
|---|---|---|
| Vmotion Studio | 可视化创作 | Vmotion.exe / 启动 Vmotion.cmd；动画、剪辑、音乐、绘画、素材、效果、导出 |
| Vmotion Agent Workbench | 外部 Agent / 程序化创作 | 启动 Agent 工作台.cmd / /agent/；源码、MCP/CLI、工具 Schema、准确候选、诊断与任务 |

两端分别构建 HTML/JavaScript，使用各自的 HTTP 接口；同一 ProjectService、预览/导出核心、事务、文件同步与撤销历史保证工程一致。MCP 保持 10 个默认入口，140 项能力按需发现；Agent 启动器和指南放在便携包 Agent 文件夹。

## 创作能力

中文文字与公式、矢量、关键帧、动画层、路径/表达式/约束、遮罩/混合、特效节点、粒子/时间拖尾、矩阵 3D、网格/材质、分镜/转场、多轨音视频、代理与缓存、逐帧绘画/图层资源、PSD/OpenRaster 栅格导入，以及 MP4/PNG/WAV 导出。

音乐采用独立 Pattern / Playlist / Piano roll / Channel rack / Mixer 工作区，支持内置合成器/采样、VST3、MIDI 接口、录入音符和状态保存。[音乐说明](docs/SOUND-MUSIC.md)列出当前验收范围。

## 从源码构建

需要 Node.js 22+、Rust、Windows C++ Build Tools 和 CMake。原生 SDK/运行时由固定清单下载，首次构建需要网络。

```powershell
npm ci
npm run native:build
npm run typecheck
npm test
npm run build
npx tsx scripts/package.ts
```

开发创作界面：npm run dev 和 npm run dev:ui；Agent 界面：npm run dev:agent。完整便携说明见 [PORTABLE](docs/PORTABLE.md)。

## 公开 Release

此仓库提供可构建产品源码快照和测试，SOURCE-MANIFEST.json 记录来源版本与文件哈希。便携 ZIP/校验文件位于 Releases；个人生产工程、缓存、凭据、日志和私有 Git 历史不属于公开快照。

当前为早期预览版。全场景 GPU、专业长片/4K60 完整验收、HDR、ASIO/VST2、离线插件延迟补偿仍未完成。AU/macOS 后端源码尚未实机验收；第三方插件兼容性按实际测试报告区分。

## 许可

第一方 SDK、核心、桌面创作界面和 Agent 工作台统一使用 [Apache-2.0](LICENSE)。第三方依赖保留各自许可；便携包内保留 LGPL shared FFmpeg 的许可证与对应源码、OFL 字体、MIT VST3/JSON notices。商业音频插件需另行安装和授权。
