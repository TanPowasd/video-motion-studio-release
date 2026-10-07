# 类型与模块边界

重构保持 formatVersion=1、RPC 字符串名称和原生画面语义。MCP 结果投影保留同级字段、数组索引与版本字段；字段投影不会修改原结果。

工具定义声明完整 categories、keywords、annotations。内置注册表拒绝缺失元数据，Discovery 直接消费定义，不再维护工具名分类、关键词或权限补充表。类别词汇仅用于搜索别名。旧项目插件继续使用原有 Schema 默认值，诊断 PLUGIN_METADATA_DEFAULTS 提醒作者补齐声明，不修改源码。

hash、json、safePath、atomicWrite 位于 platform/project-files；service/project 的兼容转出保留，core 和 media 的通用文件操作直接依赖 platform。原子写仍保留 Windows 文件占用重试、原文件和错误诊断，事务 journal/history 留在工程服务。

运行 npm run typecheck、npm test、npm run build；MCP 发布前使用 node scripts/check-mcp-budget.mjs --packaged 核验真实 stdio、错误请求、准确候选、撤销和传输字节。

## RPC 与编辑器状态

内置方法各自声明 defineRpcHandler(Schema, handler)，RpcMethodMap 从处理器推导输入/输出。Application.dispatch 保留字符串动态入口，未知方法和项目插件结果是 unknown；已知方法返回具体结果，dispatchTyped/rpcTyped 收紧内部入参。内置 dispatch 也使用 unknown 并在方法边界解析，MCP 的公开 Schema 和响应形状保持兼容。多分支返回和可选数据由调用方显式判断，不默认断言存在。

编辑器入口只处理首页/工作区路由。reducer/store 管理 project、route、selection、preview、panels、code、drawing、assets、tasks、diagnostics；effects/controller 执行 RPC、SSE、媒体请求和草稿保存。useSyncExternalStore 按 selector 订阅，reducer 保留未修改切片引用。控制器命令使用稳定身份和当前闭包，素材/属性面板用 memo 防止不相关状态刷新触发渲染；画布、时间轴和现有 inspector 的交互与工程写入仍沿用共享事务。工作区销毁会关闭订阅、取消预览并释放 ImageBitmap。

## 节点渲染管线

NodeRendererRegistry 注册每个支持的 Node.type，重复注册/缺失处理器明确报错。各内容处理器依赖注入的 RenderServices，不依赖 ProjectService 或 UI，也不创建自己的共享缓存。NodeCompositor 统一处理变换、样式、裁剪、隔离、混合、有序效果和历史采样；返回 skipChildren 保留旧实现的空/不在时域内容语义。RenderMediaResources 统一拥有有界图像缓存、解码器和缓存租约。

Renderer 保留 render、inspectComposition、inspectInteractions、textGeometry 等公共入口与原有预算/诊断，几何检查继续使用同一个文字、路径与场景求值核心。CPU/GPU 分工没有扩大。迁移前用 check-renderer-parity.ts --baseline 保存六个完整工程的首/中/末帧（倒序采样），迁移后比较 18 帧的 RGBA 哈希、尺寸、透明度、选框、诊断和工程 revision；基线文件留在 artifacts，不上传。全部对照一致后移除旧节点分支。

## 验证与反馈

npm test 保留全量，test:fast/test:integration 使用 test-groups.json 分组并验证无遗漏/重复。test:acceptance 顺序运行真实 stdio、selector 隔离、便携迁移和桌面；VMOTION_TEST_GPU=1 增加真实硬件验收，未启用时明确报告遗漏。运行器每 30 秒输出当前用例、PID、无输出时间；超时保存完整日志、打印命令/子进程，退出码 124 并终止所属子进程树。VMOTION_TEST_TIMEOUT_MS 可调整分组上限；单用例预算维持 30 秒，真实多编译模板用例单独允许 60 秒。

test:coverage 提供快速组的 V8 覆盖率与 JSON 摘要。首个基线语句约 35%、分支约 26%，仅是快速组覆盖，不是全量质量评级；完整覆盖可运行 node scripts/test-runner.mjs all --coverage。报告、缓存和日志都保存在 ignored artifacts，CI 不上传工程或媒体。Windows workflow 安装运行时、验证类型/fast/integration/all/build；手动 portable 发布候选执行完整打包验收，实际硬件 GPU 在参考设备验证。

字体改为 FontFace 运行时加载，HTTP URL 保持一致，Vite 开发代理包括 /runtime。页面 load 完成后才请求字体，避免阻塞 Electron 的项目切换；加载失败回退系统字体。构建不再报告字体 URL 无法解析，桌面验收检查两个真实字体响应和已加载 FontFace。
