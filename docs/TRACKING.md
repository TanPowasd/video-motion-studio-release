# 运动跟踪、贴附与视频稳定

此批增加通用视频/电影工作流所需的稀疏运动分析，同时优化解码复制和外部 Agent 接口。软件没有模型接入。

## 分析与资源

`tracking_analyze` 的 start 请求指定注册 video asset、source-frame 的 start/end（出点排除）、分析宽度和 points。种子使用视频显示方向下的原始像素坐标；每个稳定 point ID 可以提供多帧种子用于重设。points 为空时 autoCount 检测二维纹理角点，可指定源像素 region；手动 points 模式不追加自动点。

独立 worker 使用高斯金字塔 Lucas–Kanade，结合角点强度、零均值光度/NCC、反向跟踪误差和最大位移限制。低纹理、边缘、光度变化/遮挡或双向误差失败，输出 lost/null 坐标/零 confidence，并保持失跟直到下一颗显式种子。confidence 是匹配质量启发式，不是概率或语义对象身份。

start 默认立即返回短 job；status 查询进度、帧、阶段、计数与最终 analysisId，cancel 取消任务并释放 worker/专用解码器。CLI 无桌面服务时 `tracking-analyze --project ... --request request.json` 等待任务结束后退出；连接已有服务时按 request 的 wait 选择，长任务应使用背景任务及状态查询，避免桥接超时。

完成的 analysisId 是 `.vmotion/tracking/<sha256>.json` 的内容标识，不进入项目历史。`tracking_plan` 才把轨迹保存为项目版本内的 `components/tracking/*.json`，与图层改动同一候选。JSON 记录源 asset ID、尺寸、rational FPS、原始指纹、设置、种子、逐帧坐标/匹配误差和失跟原因。外部文件修改仍经过统一格式验证与历史。

默认 portable=true 以有界流在分析前后计算完整源文件 SHA-256，确保资源随字节相同的素材复制后可继续使用。正常调用先比较 size/mtime；元数据变化时以记录的摘要确认内容，并把当前元数据检查固定到候选。portable=false 明确选择仅 size/mtime，复制后可能需要重新分析。完整文件哈希有 I/O 成本；常规元数据未改变的取证/计划不会重复哈希。此机制不承诺检测故意保持 size/mtime 的外部修改。

时间基准是工程的有理数 FPS，与预览/导出同一 VideoDecoder 均匀源帧取样。绑定按视频实际显示的 floor(sourceFrame) 取点，支持视频线性/重映射/冻结与祖先 contextFrames。SDK 可以在有效数据之间线性插值，不跨失跟区间；末帧保持到排除端点。改变工程 FPS 后须显式转换数据或重新分析。手机常见 90° 旋转元数据已按显示尺寸处理；非正交显示变换、非方形像素和复杂 VFR 媒体需要更广泛验收。

## 贴附与稳定

`tracking_plan` 可批量保存/手改样本和 bindings，使用同一 revision：

- point：一个点的位置变化贴附到任意图层，保留原有 TRS 动画。
- transform：平移、相似（平移/旋转/统一缩放）或仿射拟合，把源图像运动贴附到目标。鲁棒拟合最多 128 个确定性假设，报告被排除的点和最大残差；全点一致时只做一次拟合。
- stabilize：目标必须是分析源视频图层；反向补偿源像素运动。smoothingRadius=0 锁定，正半径保留低频移动；相似模型按展开角度/log-scale 平滑，窗口使用前缀和。strength 的相似插值保持有效缩放。zoom 为明确的中心裁边，透明边缘仍可能存在，不自动扩大质量/尺寸。
- cornerPin：四个稳定点按 TL/TR/BR/BL 顺序映射到目标矩形，产生普通角点效果键；须保持凸、非退化、不过透视地平线，目标尺寸应稳定。此操作使用四点轨迹，不等同于一般透视平面跟踪/三维相机解算。

源视频的 letterbox、变换、目标父级/TRS 和相机坐标共用实际场景求值。来源必须是同一编辑 scope 内对应 asset 的未扭曲视频；像素效果需要先渲染为新素材再分析。奇异变换、矩阵依赖表达式、动态消失 ID、非法角点和不覆盖的时间范围都有诊断。

默认 loss=error，失跟或低于 minConfidence 阻止绑定；loss=hold 是显式保持前一有效坐标，并报告 heldSamples。手改 null 标记失跟，手改坐标产生 manual 样本/种子；手改不会暗中重算后续轨迹，应使用更新的 seeds 重新分析来传播修正。

输出为普通 matrix.0..5 或 effects.N.corners.I.x/y 键，TypeScript 不改写，其他动画保持可编辑，整个候选可以一次撤销。已有矩阵通道默认保护，replaceChannels=true 会烘焙/组合当前矩阵。重复绑定会叠加当前矩阵；更新既有绑定应先撤销那次烘焙。暂未提供自动保持引用的实时绑定/重烘焙管理。

## Agent 接口与性能

`tracking_inspect` 默认 8 点分页，报告有效/失跟计数与区间；只有显式 frames 才返回位置，detail 才返回完整光度/双向证据。`tracking_evidence` 返回指定原始帧上的点标注和 lost 计数，PNG 作为原生媒体块，文本/metadata 不重复 Base64。`tracking_plan` 默认只返回磁盘 planId、短报告、candidate/apply。project_preflight/project_apply 应使用未修改的候选，素材检查在提交前再次执行。采样覆盖与遗漏明确，少量画面不证明整段质量。

```json
{"action":"start","request":{"assetId":"footage","start":0,"end":120,"width":640,"points":[{"id":"anchor","seeds":[{"frame":0,"x":240,"y":160}]}]}}
```

SDK `prepareTracking` 在 render 外准备资源；`sampleTrackedPoint`、`trackingMotion`、`fitTrackingMotion`、`blendTrackingMotion` 和 `smoothTrackingMotion` 都支持确定性、随机跳帧的代码编排。CLI tracking-analyze/inspect/plan/evidence 共用服务。project_schema tracking/trackingSettings 提供独立 Schema。

每个分析最多 3600 源帧、32 点、1280×1280 分析图，worker 192MiB 堆上限，队列最多 4 个任务，完成记录最多 32 个，分析资源最多 16MiB。只有当前/上一帧金字塔驻留；metrics.peakBufferBytes 仅计特定 typed buffers，不等于整进程 RAM。VideoDecoder 的帧缓存仍受 8 帧/48MiB 限制。资源与证据可通过缓存工具清理，已写入工程/候选的源码不会作为缓存删除。

原始视频解码新增 direct framing：流片段直接写入独立帧缓冲，帧数据只复制一次；保留 concat 作为显式性能基线。`render_profile mediaFraming=direct/concat` 返回相同像素及实际 copiedBytes/concatenations/cachedBytes，不改变分辨率。该计数覆盖 JS 帧装配，不包含 FFmpeg 内部解码复制或所有 IPC/图形分配。

## 验收与边界

`examples/tracking-lab` 是 6 秒 1280×720/30fps 的可编辑跟踪/稳定对照；源视频是本地脚本生成的素材。`scripts/create-tracking-lab.ts --render-only` 保留工程编辑，重建需 `--rebuild`。`node scripts/check-tracking.mjs --packaged` 使用真实 stdio 客户端验证背景任务、分页、标注、代码生成贴附/四点贴图、准确候选/撤销、稳定/平滑、随机帧、MP4、CLI 和错误请求。最终结果在 WORK-STATUS.md。

尚未实现透视平面/相机解算、密集光流、自动遮挡后重识别、GPU 跟踪或完整转描。当前单任务覆盖不代替两小时电影、所有 codec/旋转/变帧率与复杂场景性能验收。
