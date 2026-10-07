# 外部 AI 与界面共同编辑

人直接通过 Vmotion Studio 的动画、剪辑、音乐、绘画和代码工作区编辑。AI 在外部通过项目文件或 CLI/MCP 操作同一个工程，程序不调用 AI 模型。

顶部“连接 MCP”复制当前工程的本地接入配置。关闭配置框继续用 UI 编辑，不需要额外 Agent 面板或第二窗口。旧“启动 Agent 工作台.cmd”/--agent-workbench 作为兼容入口，启动普通创作界面并显示配置框。

JSON 为可视化数据来源，TypeScript/Python/WGSL 为程序逻辑来源。文件同步先验证再切换活动版本；错误保留最后可用预览，冲突保留双方内容。AI 通过 project_preflight 检查准确候选，再 project_apply 原样提交；人通过 UI 修改参数和图层，双方共享原子事务、revision、撤销和渲染。

旧 /agent/ Web 页和 /api/agent/* 保留给已有工具使用，日常不用打开。MCP 默认仍10入口，140项能力按需发现；完整信息、Schema 和源文件按需读取。参考 [外部 Agent 创作流程](AGENT-WORKFLOW.md)。
