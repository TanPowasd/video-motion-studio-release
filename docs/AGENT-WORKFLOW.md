# 外部 agent 代码创作与预检

Vmotion 不接入模型。外部 agent 通过工程文件、CLI 或本地 MCP 编写 TypeScript 和场景 JSON，再用同一个原生核心检查画面。编辑器、CLI、MCP 使用相同的变更处理器与历史记录。

平面特效批量创作使用 effects_guide/inspect/plan，支持稳定 ID、排序/复制时的关键帧迁移和图层本地扭曲/擦除。详见 [平面特效](EFFECTS2D.md)。

MCP 默认只加载 10 个入口。用 tools_search/tool_schema 找到能力，再通过 tool_call 调用，或 tools_load 加载需要的直接工具；126 项内置能力保持可用。详见 [按需工具发现](AGENT-DISCOVERY.md)。需要原全量工具目录时启动 `mcp --tools all`。

建议流程：

先调用 `agent_guide` 选择 animation/editing/3d/math/recovery 工作流。3D 画面优先使用 [4×4 矩阵与网格](MATRIX3D.md)，素材编排见 [Agent 媒体工作流](AGENT-MEDIA.md)，数值运算见 [线性代数](LINEAR-ALGEBRA.md)。

3D 穿插网格使用 `scene3DLayer` 和 `scene3d_render` 的原生深度/面 ID 图，定位真实可见对象后再检查最终合成帧；详见 [深度场景](DEPTH3D.md)。mesh_generate/mesh_import 生成资源与放置候选，默认用短 planId 预检/提交，避免重复读取大量顶点；详见 [网格与 OBJ](MESHES.md)。

1. `project_context` 读取精简工程摘要、revision、稳定 ID、选区、诊断与文件 hash。使用 sceneId/sequenceId 定位工程部分，offset/limit 分页。需要完整源码时再读取文件。
2. `project_file_read` 按行读取目标文件；记录返回的完整文件 hash。需要 schema 时调用 `project_schema`，可只查询一个 operationType。
3. `project_preflight` 提交候选 operations/files 和待检查帧。它不会替换活动工程文件或改变撤销记录；临时编译、图片只进入 `.vmotion` 缓存。
4. 检查 diagnostics、samples 和返回的画面。预检包括格式、引用、TypeScript 与组件加载；运行时检查只覆盖请求的帧。`determinism: true` 会将每个采样帧渲染两次并比较像素，用来发现有状态或随机行为。
5. 用同一请求调用 `project_apply`，增加 `expectedCandidateRevision`。工程 revision 与候选 revision 都匹配且检查通过后，整个批次原子保存为一次撤销操作。

`project_context` 和 `project_apply` 不返回全部源码。旧的 `project_inspect` / `project_transact` 保留兼容。MCP 工具目录使用精简的操作描述，完整的 JSON Schema 按需读取，避免每次创作先加载所有格式定义。

大量错误优先使用 `project_diagnostics`：section可选diagnostics/conflicts/pendingFiles，默认20条、limit最高100，offset/nextOffset分页，files精确筛选。diagnostics另支持codes/severities；message默认最多240字符并明确标记截断，detail=true读取选定完整消息。conflicts默认返回index/file/path，detail才读取base/ours/theirs；每次解决后刷新索引。pendingFiles默认只有修改路径与状态，detail返回该页文件的前后hash/bytes，用project_file_read version=pending读取内容。summary始终统计全部证据，coverage明确过滤/已返回/遗漏数量。

此查询不重新加载磁盘或编译，不写历史；revision检查活动版本，外部待修复文件和冲突仍可能变化，修复时继续使用文件hash与候选检查。显式project_validate负责刷新与验证。CLI `project-diagnostics --project <directory> --request <query.json>`与MCP使用同一服务。project_schema名称由权威注册表生成，包括sound/audioMix/plugin/storyboard/textureSettings，拒绝未来未知类型。

组件支持结构化参数。调用 `component_parameters` 获取默认值、类型 Schema、当前求值和可动画路径，再使用 `component_parameters_edit` 修改嵌套字段、向量、数组项目或数字关键帧；数组插入/删除/排序自动映射项目动画。详见 [组件参数](COMPONENT-PARAMETERS.md)。

`animation_inspect` 可查询通道分页、指定帧的数值与速度估计；`animation_edit` 对多图层执行关键帧复制、平移、时间/数值缩放、删除和缓动设置，保留生成图层源码。默认拒绝时间碰撞，整个批次共享一次撤销。详见 [关键帧接口](KEYFRAMES.md)。

声音检查使用 `audio_timeline` 的采样位置与嵌套包络，再调用 `audio_preview` 检查短片段的原生音频、RMS、峰值和波形数据。预览与导出复用本地混音器，详见 [声音工具](AUDIO.md)。

画面检查使用 `visual_audit`，跨多个帧返回文字截断、越界、重叠、遮挡和运动突跳提示，附稳定 ID/组件路径与标注图片。候选代码预检可指定 visual=true；确定问题使预检失败，几何提示仅作为 warning。提示需要目视判断，范围与限制见 [画面检查](VISUAL-AUDIT.md)。

文件编辑有三种形式：

```json
{
  "revision": "<project-revision>",
  "files": [
    {
      "type": "text",
      "path": "components/wave.ts",
      "expectedHash": "<file-hash>",
      "replacements": [
        { "before": "strokeWidth: 5", "after": "strokeWidth: 7" }
      ]
    }
  ],
  "samples": [
    { "sceneId": "intro", "frame": 0 },
    { "sceneId": "intro", "frame": 90 },
    { "sceneId": "intro", "frame": 180 }
  ],
  "width": 320,
  "determinism": true
}
```

- `text` 使用精确文本替换，匹配内容必须只出现一次；有歧义时扩大上下文，工具不会猜测要改哪里。
- `replace` 提交整份文件。新增文件时 expectedHash 为 null，已有文件使用当前 hash。
- `delete` 删除文件，并要求当前 hash；如果删除的文件仍被组件导入或被清单引用，验证会失败。

可编辑文件范围为 `project.vmotion.json` 以及 components、scenes、sequences、drawings 下的 JSON/TypeScript。新增场景、序列和画稿 JSON 必须在同一批次更新清单引用。相同文件在一个批次只能出现一次，不同时进行文件修改和语义修改，避免丢失其中一组变化。assets 大型资源继续通过导入、绘画发布等专用工具创建。

TypeScript 的新增模块与删除模块都按候选工程版本查找，预检不会使用磁盘上已被候选删除的旧源码来掩盖错误。TypeScript/运行错误提供文件、行、列；JSON schema 错误提供文件与属性路径。不同请求的编译和渲染使用独立的检查核心，保留编辑器最后可用画面。

外部文件改坏时，`project_context.pendingFiles` 为 true。先用 `project_file_read` 的 `version: "pending"` 读取待修复内容和 hash，再在 preflight/apply 请求中指定 `version: "pending"`。修复后的整个候选必须有效才能替换活动工程。`version: "active"` 可检查最后有效版本。未来格式工程仍拒绝自动覆盖。

CLI 使用同一接口：

```powershell
node dist/cli/index.mjs context --project ./my-project --scene intro --limit 50
node dist/cli/index.mjs read --project ./my-project --file components/wave.ts --start-line 1 --line-count 100
node dist/cli/index.mjs schema --project ./my-project --name operation --operation updateNode
node dist/cli/index.mjs preflight --project ./my-project --request-file ./candidate.json
node dist/cli/index.mjs apply --project ./my-project --request-file ./approved-candidate.json
```

`approved-candidate.json` 使用相同文件/操作，并包含预检返回的 expectedCandidateRevision。预检未通过时 CLI 返回退出码 2，失败提交返回非零退出码。

界面的代码工作区提供「预检代码」，可检查当前合成的开头、当前帧、中间和末帧，查看画面并点击诊断定位。保存组件也会进行这些检查，使用最初读取的文件 hash 防止覆盖别人的新源码。

代码工作区切换文件或刷新时保留未保存草稿。草稿属于当前编辑页面，不自动写入工程；重新提交时仍检查原文件 hash，外部改动不会被草稿静默覆盖。
