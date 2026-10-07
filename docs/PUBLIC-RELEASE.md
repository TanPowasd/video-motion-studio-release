# 独立公开 Release 仓库

公开地址：<https://github.com/TanPowasd/video-motion-studio-release>。

公开仓库发布可构建源码快照（v0.1.1 起默认统一窗口）、Apache-2.0 许可、SDK/Schema、测试、演示工程和 Windows 便携包。源码快照以独立 Git 历史记录发布，manifest 记录原版本与逐文件 SHA256。便携 ZIP 与校验文件放在 GitHub Releases，不放进 Git；依赖/原生目标/缓存/运行时从固定清单构建。

导出采用显式产品目录 allowlist。个人 productions、运行日志、缓存、profile、用户配置、Git 凭据、依赖、构建和历史 release 目录不属于公开源码快照。可编辑演示例子只复制已跟踪文件，生成脚本仍有 --rebuild 保护。

仓库的第一方核心与桌面与 Agent 面板都按 Apache-2.0 开源，第三方依赖保留各自许可。FFmpeg 使用固定 LGPL shared 构建并保留对应源码、字体保留 OFL、VST3/JSON 依赖保留 MIT notices。公开仓库的代码和发布包不含商业 VST 插件。

`scripts/export-public-release.ts` 生成可检查的源码快照；`scripts/publish-public-release.mjs` 创建/更新独立公开仓库和 GitHub Release，使用本机 Git Credential Manager，凭据只在进程内使用。发布前验证源码 allowlist/文件哈希、类型/测试/构建、便携包和真实 MCP/窗口流程；发布后验证仓库公开性、Apache 许可、source commit、tag、Release asset digest 和 ZIP SHA256。
