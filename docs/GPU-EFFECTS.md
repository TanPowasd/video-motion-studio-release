# Direct3D12 逐像素特效

Windows x64 的 `crates/vmotion-gpu` 使用 Rust/wgpu 和真实 Direct3D12 硬件设备，独立于动画/深度 CPU 进程。程序不接入模型。当前加速特效图中的 `colorMatrix`（sRGB/linear）、`keyer`（chroma/luma、spill/matte/invert）和同一输入的 `channels`。文字、矢量、深度 3D、模糊/光束/纹理/置换和混合等继续使用原 CPU 核心；没有实现全场景 Skia GPU、Electron 共享纹理或硬件视频编码。

| 模式 | 执行规则 |
|---|---|
| `cpu` | 保持原生 CPU 图执行，不启动 GPU |
| `auto` | 默认预览/导出设置；可合并至少两层且工作画面不少于 262144 像素时尝试 GPU；不满足或启动失败时使用 CPU并返回状态/诊断 |
| `gpu` | 要求真实硬件 GPU 初始化；支持节点可单层使用；设备缺失、初始化/执行失败时报错，其它未支持类型仍按 CPU语义执行 |

环境变量 `VMOTION_GPU=cpu|auto|gpu` 配置服务默认；CLI `render --gpu gpu`、MCP `render_start {gpu:"gpu"}` 可明确选择单次导出。`render_profile {gpu:"gpu"}` 与 `render_compare {baseline:{gpu:"cpu"},optimized:{gpu:"gpu"}}` 按调用测量，不增加工具数量。性能工具默认 `cpu`，避免基准自动启用额外变量。`VMOTION_GPU_NATIVE` 可指定本地 GPU 可执行文件。

合并仅沿单消费者、单输入的连续节点，不跨共享分支；最多64层，有界图工作预算保持。输入/输出用8字节长度头、短JSON控制、二进制RGBA，图片不进入JSON/Base64。单个进程只有一个请求执行，分片读回只复制到预分配缓冲，没有反复拼接整帧。GPU仅保留当前最大画面的input/output/readback及精度位图，尺寸不变复用分配；UHD上限约101.68MB的**显式GPU缓冲**，不是进程总内存或显存认证。层/缓存/操作系统内存仍需长片验收。

连续层之间保留8位量化以及实际宿主Skia `putImageData/getImageData` 的完整256×256通道/alpha转换表。Shader标记接近舍入半值或硬色键阈值的像素，CPU分批重算这些像素的完整链；默认修正批最多65536像素，统计 `correctedPixels`。这种混合修正用于减少f32与JS f64的边界分歧，不保证所有设备/任意系数绝对相同。参数超出可处理f32范围时保留CPU或在明确GPU调用报告不支持。GPU不存在或出错不降低分辨率。

预览、候选及导出共用图执行器。导出初始化后固定GPU设备/模式/可执行文件与宿主量化表指纹到恢复版本，执行中GPU失败会使任务失败，保留已完成检查点，避免续渲染混用设备路径。默认auto启动失败可确定地选择CPU；已启动后的错误不在同一导出中悄悄回退。手动重置/物理设备丢失有待更长压力验收；当前进程退出/缺失/错误/超时路径可测试。

`cache.gpu`（profile）和 `baseline/optimized.gpu`（compare）返回 adapter、mode/status、requests/stages/dispatches、上传/下载及IPC字节、分配/保留预算、修正/回退数和wallMs。`fullSceneGpu:false` 明确范围；旧capabilities.gpu仍表示全场景GPU，gpuEffects另报局部状态。render_status保留完成任务的GPU证据。图节点提供gpuPixels/fused与有界locator，连续节点的最后一个记录合计执行耗时，不能把这些计数当作真实独立shader时长。

对照默认使用完全相同的像素hash；显式 `pixelTolerance` 使用预乘SDR RGB与独立alpha的8位绝对差，同时报告hashMatch、最大值/MAE。容差对照最多保留32M首轮基准像素，超限报错；不降采样。`detail:true` 才返回每对完整指标。容差一致不等于字节相同，差异大小不衡量艺术质量。重复采样仍检查每个后端自身确定性。

可执行验证：

```powershell
npm run native:build
npm run native:test
npx vitest run --config vitest.config.ts tests/gpu-effects.test.ts
node scripts/check-gpu-effects.mjs --packaged
```

真实MCP脚本检验DX12硬件、720p/1080p/UHD成对性能、精度/缓冲/分支、源码候选、错误输入/预算、预检提交与一次撤销、CLI当前服务、原生图片、PNG预览/导出一致和60帧MP4。基准固定八层全画面颜色矩阵，CPU启用原ROI/分块优化；计时包含GPU native传输、等待与读回，不含工具网络/PNG/哈希。设备、图层覆盖、节点数量和负载影响收益；稀疏画面、少节点或大量舍入修正可能较慢。单设备测试不证明4K/60fps或两小时正式性能。

可编辑 `examples/gpu-effects-lab` 为六秒动画，源图与八层颜色图并排，使用固定时钟和ID。`npx tsx scripts/create-gpu-effects-lab.ts --render-only` 导出已有工程；重建需显式 `--rebuild`。构建将hash命名GPU二进制和Cargo依赖许可随原生核心打包，第三方各自许可保留。
