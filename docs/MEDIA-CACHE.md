# 媒体重链接、代理预览与缓存管理

本批同时补通用媒体修复、预览解码性能和工程磁盘管理，优先外部 Agent 的准确候选、短回应和真实验证。应用不调用 AI 模型。

## 素材检查与重链接

media_status 默认分页 30 个素材，返回文件状态、稳定 asset ID、注册 metadata、fingerprint 与代理状态；probe=true 读取实际图片/音视频元数据。缺失文件仍可定位，不把整个工程源码回传。

media_relink_plan 指定 assetId 和已有文件 path，保存候选而不移动或覆盖媒体。compatible 默认比较已注册尺寸、音视频流、声道及一帧容差内的时长；replace 明确替换不同内容。新文件 metadata/fingerprint 固定进候选，保存前再次核对，较短媒体不能超过已有时间轴源范围。源文件没有历史摘要时，metadata 兼容不证明文件内容相同；场景代码的美术意图仍需看候选画面。

```json
{"revision":"当前版本","items":[
  {"assetId":"camera-take","path":"E:/footage/restored-take.mkv",
   "expectedPath":"assets/take.mkv","policy":"compatible"}
]}
```

project_preflight 检查准确 planId，原样 project_apply 保存并共享一次撤销。稳定 ID、场景/片段/画稿引用保持；重链接只改清单路径与实际 metadata。撤销可以恢复已缺失的旧路径，同时保留 MISSING_ASSET 诊断与最后有效预览，redo 可重新使用恢复后的文件。JSON、代码、循环/格式错误仍阻止历史切换，普通事务的验证没有放宽。

本版重链接普通 image/video/audio；可编辑声音/绘画文档保持自己的权威资源结构，不改成普通媒体。图片/音视频文件以引用方式使用；没有新建复制、自动目录搜索或按内容猜测匹配。

## 实际代理工作流

media_proxy action=start/status/cancel/inspect 管理后台任务，最多 8 个待处理、64 条任务记录。指定视频 ID 和 128–1920 的代理宽度；不放大较小来源。任务使用固定项目有理数 FPS、BGRA 无损 FFV1 intra/MKV、不带声音，提供进度并可取消。输入 file size/mtime、帧率、配置参与缓存 ID，写完核对原文件，再原子发布；失效代理不用于预览。已完成同配置缓存可直接复用，不覆盖仍被读取的文件。

代理位于 .vmotion/proxies-v2，清单/缓存不是工程权威源码，也不影响工程 revision。自动预览检查原文件版本、FPS、代理 metadata 与输出 fingerprint；匹配时选代理，否则回退原素材。视频解码分辨率按实际屏幕变换与代理尺寸缩小，避免较小画布仍解码完整逻辑像素。

桌面默认“代理优先”，也可选“原始素材”；UI 图像读取通过既有无损 RGBA 通道，版本、播放时钟、模式与代理完成 epoch 参与过期帧过滤。代理完成会刷新当前画面。CLI/MCP 原生证据、预检和最终导出默认始终使用原素材；render_profile mediaQuality=auto/original 是明确比较选项。代理只优化视频解码，不降低程序化图形、数学/排版或导出质量。音频混音/分析沿用原音频源。

FFV1 代理是无损编码，空间缩放和 CFR 化仍改变预览细节/采样；具体剪辑/变速/VFR 素材应对照原始模式检查。当前证明覆盖本地 CFR fixture 的同尺寸像素一致、代理失效和原始导出，不宣称所有编解码/旋转元数据、4K/两小时工程性能已验收。

Windows 移动媒体前可用 media_proxy action=release 或“释放预览读取”，在空闲时关闭解码器并等待进程退出。此前管道未排空时等待 close 会挂起，现在销毁输出流并等待进程 exit，不提高超时来掩盖问题；不移动/删除原素材。活跃渲染、音频与代理任务应先结束或明确取消。

## 可审阅的缓存清理

cache_inspect 返回各可重建 group 的字节、文件、活动 lease/项目引用保护和可选文件分页。cache_plan 根据显式 maxBytes/minAgeSeconds/maxFiles 挑选最旧可用文件，返回短 hash planId、预计前后字节和 completeWithinPolicy，不立即删除。默认只清理一小时前文件，保留 1 GiB；这是一批清理计划，不是持续自动配额守护。

cache_apply 核对计划内容 hash、当前文件大小/mtime、实际路径、项目引用和 lease。新增引用或变化的文件跳过并报告，任务忙时拒绝；先释放空闲预览缓存，然后只 unlink 所列普通文件。目录链接、符号链接、越界目录拒绝/跳过，不递归移除目录。

可选择 proxies-v2、audio-mix/tempo、sound-cache/samples、audit/evidence/preview/preflight 等重建缓存。源码/素材、history/snapshots、agent-plans、renders 检查点及 compiled 工作模块不参与此清理；即使普通素材被注册在一个缓存目录中，也按项目引用保留。活动代理包的 video/record/index 一同保护。缓存可重建，清理不进入创作撤销历史。

一次最多扫描 20000 条目录/文件、列出 2000 个清理目标；分组/年龄/保护条件不足时明确报告未达到预算，而非扩大到受保护内容。未注册的任意代码硬编码缓存路径不作为素材依赖证明，应将创作素材注册到清单/声明 source；真正的项目素材不要当临时缓存使用。

## Agent 与桌面入口

media_status → media_proxy（生成/检查）或 media_relink_plan（准确候选）→ preflight/pictures → apply。cache_inspect → cache_plan → 看预计空间与保护 → cache_apply。所有能力通过 tool_call 使用，默认仍只有 10 MCP 入口；CLI 提供同名连字符命令，接收 --request JSON。

素材库“媒体与缓存”打开素材可用性/代理队列、引用重链接和磁盘计划。生成代理和移动文件之前的释放操作不改变项目源码；链接保存和其他创作共用统一候选与历史。释放读取后应按需要重新打开预览。

真实开发 MCP fixture 1280×720 原视频在640×360预览：解码像素量921600→230400（-75%），当次热平均约3.77→2.79ms。该值不包含代理生成，且不是整机FPS承诺；重复帧缓存、硬盘、codec 和场景复杂度决定实际收益。MCP重链接回应约1261字节、清理计划608字节，图像不重复进文本。

tests/media-management.test.ts、cache-management.test.ts 验证代理使用/复用/取消/失效、原图、缺失链接候选/撤销、源检查、引用/lease/目录junction/计划路径保护。scripts/check-media-cache.mjs --packaged 使用实际封装 stdio MCP，完成代理、原始证据、移位文件恢复、重做、真正回收字节、检查点保留、PNG原始导出一致与60帧MP4。桌面原始/自动预览和管理面板由实际 Electron 窗口验收。
