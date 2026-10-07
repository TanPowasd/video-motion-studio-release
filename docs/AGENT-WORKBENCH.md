# Agent 工作台与工具链

双击 `启动 Agent 工作台.cmd`；命令行可用 `Vmotion.exe --agent-workbench --project "D:\视频工程"`。Web 服务的创作页是 `/`，独立工作台是 `/agent/`，两个页面使用不同 HTML、入口和构建产物。

工作台提供 MCP/CLI 配置、分页源码、TypeScript/JSON/Python/WGSL 编辑、类型/画面预检、准确候选提交、按需工具目录/Schema、原生画面/声音、planId、诊断与渲染任务。这里也不内置 AI 模型；外部 agent 使用项目文件、CLI 和 MCP。

源码草稿保留在当前标签页 sessionStorage。预检不保存；提交使用被检查的原始请求、文件 hash、工程 revision 和 expectedCandidateRevision。改变草稿或源文件后须重新检查，不能把旧候选提交到新版本上。创作端与工作台共享一次撤销、外部文件冲突和导出队列。

便携包中 `Agent/vmotion-agent.cmd` 是专用 CLI/MCP 启动器，`Agent/README.md` 提供流程。根目录 `vmotion.cmd` 仍作为兼容入口保留。

HTTP 入口：`/api/studio/rpc` 为创作端，`/api/agent/rpc` 为工作台，`/api/agent/discovery` 提供 search/schema。`/api/surfaces` 明确页面和接口。旧 `/api/rpc` 继续兼容已存在的客户端；外部 MCP 的 10 个默认入口、140 项按需能力、字段投影和媒体规则保持不变。

预览/应用等共享编辑命令复用同一 Application/ProjectService；源码读取、Agent 指南、工具调用和自动化分页诊断由 Agent 入口提供。分别阅读 [创作指南](STUDIO-GUIDE.md)、[MCP 发现](AGENT-DISCOVERY.md)、[Agent 创作流程](AGENT-WORKFLOW.md)。
