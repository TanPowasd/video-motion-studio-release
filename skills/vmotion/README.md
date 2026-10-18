# Vmotion Agent Skill

这是给外部 AI agent（Claude Code、Codex、Cursor 等）使用的 Vmotion 技能包，遵循 Agent Skills 格式：入口 `SKILL.md`（英文，便于模型阅读），细节按需放在 `references/`，`examples/starter/` 是一个已实际校验并渲染过的最小工程。

核心原则：**优先直接编辑工程文件**（JSX/TSX 组件、scenes/*.json、sequences/*.json），用 `vmotion` 命令行校验、看帧、导出；**MCP 是最后、也是最差的选择**，只在文件和命令行做不到时使用。原因：文件改动可 diff、可审阅、可用 Git 与 Vmotion 的变更记录/撤销回退，上下文成本低，渲染结果确定；打开的 Vmotion 窗口会监听文件并在变更记录里显示 AI 的修改。

## 安装

把整个 `skills/vmotion` 文件夹复制（或软链接）到 agent 的技能目录：

| Agent | 用户级 | 项目级 |
|---|---|---|
| Claude Code | `~/.claude/skills/vmotion/` | `<项目>/.claude/skills/vmotion/` |
| Codex CLI | `~/.codex/skills/vmotion/` | `<项目>/.codex/skills/vmotion/` |
| 其他支持 Agent Skills 的工具 | 按其文档放入 skills 目录 | — |

```bash
# macOS / Linux
mkdir -p ~/.claude/skills && cp -r skills/vmotion ~/.claude/skills/
# Windows PowerShell
Copy-Item -Recurse skills\vmotion "$env:USERPROFILE\.claude\skills\vmotion"
```

不支持技能目录的工具（如 Cursor）：把 `SKILL.md` 的内容加入项目规则（例如 `.cursor/rules/vmotion.md` 或 `AGENTS.md`），并让 agent 能读取 `references/`。

## 使用前提

- 便携版：用包内 `vmotion.cmd` 作为命令行入口；源码：在仓库根目录 `npx tsx src/cli/index.ts …`。
- 源码/沙箱环境渲染中文需设置 `VMOTION_RUNTIME` 指向含 `fonts/NotoSansSC-*.otf` 的运行时目录。
- 界面为中文（连接 MCP、预检代码、写回源码等），技能内已说明。

## 维护

`tests/agent-skill.test.ts` 检查技能中提到的命令、仓库路径、`JSX_*` 诊断码、SDK 导出和 MCP 能力名都真实存在，并校验/渲染 starter 工程。改动 CLI、SDK 或诊断码时请同步更新本技能。
