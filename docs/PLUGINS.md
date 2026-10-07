# 插件与创作包

插件支持本地注册、语义版本/依赖、资源贡献、独立worker工具、动态MCP目录及桌面管理。软件仍不接入模型。`src/plugins/index.ts`统一注册十八个模块、137项能力，所有公开内置工具均由模块处理；既有工具名与工程格式保持兼容。review 模块包含颜色示波器、候选画面对比和图层临时隐藏取证，共七项工具。

可视化创作工具调用现有内置模块，图层编辑新增mode=plan候选而保留默认直接提交；节点/动作/3D/粒子/分镜/混音均走相同预检/覆盖/历史。MCP的短搜索与Schema有detail完整入口；项目插件Schema默认仍保留身份和hash，fields/media交付选项走同一严格invoke，不改变插件模式与读权限。详见VISUAL-WORKSTATION.md与AGENT-DISCOVERY.md。

注册表在启动时验证唯一模块ID/工具名/方法处理器、工具与处理器对应、所有权/版本和依赖约束与环。MCP目录与Application使用同一份已验证定义，通过方法Map分发。`BuiltinPluginHost`提供共享事务/选区/状态、素材导入/缩略图、诊断上报、候选快照和宿主renderer/audioPreview/renders/proxies/tracking资源。媒体读取释放仍由Application检查活动任务后执行，生命周期由宿主拥有；模块不另建进程。绘画服务只获得snapshot/transact以复用原发布/历史逻辑。项目worker插件不接收这些宿主写句柄，仍只返回候选。

`plugins_inspect` 返回实际 moduleTools/hostTools 计数，避免把部分迁移的组标成已完成；按id查询才返回完整能力名和依赖。该注册接口当前用于内置模块，项目插件仍按下面的manifest/worker协议运行。

| 内置模块 | 注册表工具 | 宿主工具 | 当前状态 |
| --- | ---: | ---: | --- |
| vmotion.design | 4 | 0 | module |
| vmotion.math | 2 | 0 | module |
| vmotion.effects | 14 | 0 | module |
| vmotion.media | 12 | 0 | module |
| vmotion.audio | 12 | 0 | module |
| vmotion.editing | 7 | 0 | module |
| vmotion.render | 7 | 0 | module |
| vmotion.3d | 5 | 0 | module |
| vmotion.vector | 6 | 0 | module |
| vmotion.animation | 14 | 0 | module |
| vmotion.drawing | 8 | 0 | module |
| vmotion.composition | 10 | 0 | module |
| vmotion.tracking | 4 | 0 | module |
| vmotion.core | 15 | 0 | module |
| vmotion.recovery | 3 | 0 | module |
| vmotion.cache | 3 | 0 | module |
| vmotion.review | 7 | 0 | module |
| vmotion.organization | 4 | 0 | module |

媒体模块包含导入（含PSD/ORA）、放置/缩略图、探测/代理、重链接候选与工程收集；绘画包含创建/笔迹编辑/选层发布/重新打开和原生画稿帧；合成包含图层/结构跨scope批量操作与共享场景创建/放置/检查/重置；跟踪复用同一后台worker、进度/取消、原始证据、贴附/稳定和固定候选。core复用工程服务的预检/精确提交/验证/选择/保存，recovery复用共享撤销与冲突处理。cache保留宿主活动请求/媒体/渲染保护；review提供视觉诊断、修复候选及单帧/多帧原生证据，多帧同样保留嵌套contextFrames。Application保留进程、任务、帧和缓存生命周期；模块化不代表新GPU后端或帧率提升。

`project_diagnostics`默认20条证据，可分页筛选诊断、冲突或待修复文件。完整消息/冲突双方/选定文件hash按detail读取；源代码仍通过project_file_read读取。查询只读，不触发编译或改变历史，当前仍遍历证据列表；它控制上下文大小，不是百万错误性能认证。

`assets_query`默认24条已注册素材摘要，按ids/types/query/managed筛选、offset/limit分页，省略路径和完整metadata；detail=true只返回选定完整记录。counts为全部已注册类型计数，total为过滤后计数，不自动探测文件；真实可用性/素材指纹需media_status/media_inspect。旧project_inspect仍可显式读取完整工程。

`drawing_query`默认24层/16笔迹，layerIds/strokeIds按稳定ID选择，图层与笔迹独立分页，报告pointCount但不传点数组。includePoints=true才返回每笔迹的pointOffset/pointLimit页（默认32），坐标保持图层本地像素和原压感。查询不改变画稿、发布资源或历史；drawing_get仍返回完整可编辑文档，drawing_frame提供实际像素。默认仍解析/验证整张画稿并遍历结构，分页控制响应，不代表百万点绘画或长片性能已经正式验收。

3D模块包含程序网格/OBJ导入、几何检查、材质计划和原生深度/对象证据；vector包含字形/形状算子、SVG几何、烘焙与重复器，animation包含表达式/布局/路径、关键帧、内容时钟与组件参数。generated覆盖、hideSources/选区、模板端口、源码保护和一次撤销复用原服务。`vmotion.3d`以前被插件ID规则挡住，现允许第二段以数字起始，首段仍以字母开头，保留vmotion.*命名空间。

`component_query`是新的精简参数接口：默认16个顶层参数、32个数值通道，paths可选择嵌套相对路径，offset/limit与channelOffset/channelLimit分别分页。数组/对象显示长度和最多4项预览、长字符串160字符预览，递归与总预览预算显式；fullValues/includeSchema才返回选定大值/定义。默认不生成完整参数JSON Schema；通道求值保留总数，但仅收集所需页，支持旧1000限制后的页。值来源标记theme-and-keyframes，最终表达式/布局/路径和渲染仍需drivers_inspect/画面证据。普通组件、生成组件和模板实例使用同一查询。原component_parameters保留完整字段和1000通道截断。

分页只收紧返回数据和Schema/通道数组构建，仍解析/求值当前组件全部参数；不把响应变小宣称为整个大数据求值消失或正式长片/GPU性能验收。

effects除查询外已接effect/graph/visual/motion候选、粒子查询/创建和转场。`builtinCandidate`共用stored/inline交付，保留原业务摘要、scope/contextFrames、visual/determinism选项和expectedCandidateRevision；预检与提交必须使用同一精确计划，事务/引用/生成层覆盖/撤销仍由原工程服务执行。editing模块包含分镜、序列计划/直接剪辑、字幕导入/检查和全片audit。render模块包含性能检查、固定版本导出、任务列表/状态/取消和分页查询。

`render_query`默认20条新到旧精简记录，可按ids/statuses/revision过滤，nextOffset显示分页覆盖、counts显示全部宿主任务状态计数。默认省略输出路径和完整错误文本，hasError提示需读取render_status或detail=true。没有截断实际错误记录；revision是任务使用工程版本的筛选。旧render_list继续返回原完整数组。查询只限制响应，不承诺任务历史Map已加全局配额；长期历史持久化/回收仍需继续。

## 注册和依赖

工程可选 `plugins` 数组记录 `{source,enabled,hash?,contentHash?}`；无此字段的旧工程正常打开。清单及代码/资源放在 components 下，进入固定工程快照、文件同步、事务与历史。清单 kind=vmotion-plugin、apiVersion=1，声明稳定 id/name/version、语义版本 dependencies、TypeScript entry、tools、contributions 与可选 `files:[{path,hash}]`。版本与 range 使用标准 semver；缺失/禁用/不兼容依赖、环、重复 ID、未来 API、错误路径、资源缺失或声明文件哈希不匹配会阻止候选。`vmotion.*` 内置 ID 保留。

`plugins_plan` 支持 hash 检查的 files、register/toggle/remove actions 和 component placements。pin=true 固定直接内容闭包的 `contentHash`；旧 `hash` 仍兼容只固定清单的工程。内容闭包包含清单、entry、贡献 source 和显式 `files`，复杂 TypeScript import 应将依赖列入 files。更新时可在 toggle 中明确重新 pin 或解除 pin。默认源码允许修改，工具调用和导出使用工程固定版本。无网络下载/依赖安装；项目已有第三方包遵循现有组件编译规则。

pin=false同时移除旧manifest hash和contentHash，pin未指定则保留二者；源码修改与解除pin可以在同一候选完成，一次撤销同时恢复文件和固定版本。不会因普通启用/禁用动作意外解除版本保护。

contributions 支持 component/effectGraph/motion/theme/sound/sceneTemplate，分别使用原有 TS 或 JSON 格式。组件可以由 plugins_plan 直接放置，其他贡献通过其匹配的现有工具编辑/应用，查询返回确切 source。普通组件与资源引用独立于库开关，禁用只撤下工具/可发现库；移除注册保留文件，不丢弃已创作的画面。删除文件需要明确 files delete，并走正常引用与可用性检查。

## 工具 SDK

```ts
import {definePlugin, definePluginTool, node} from '@vmotion/sdk';
export default definePlugin({name:'标题包',tools:{
  title: definePluginTool({
    parameters: {text:{type:'string',default:'标题'}},
    run(ctx,p) {
      return {
        operations:[{type:'addNode',sceneId:'intro',
          node:node({id:'title',type:'text',text:p.text,width:800})}],
        samples:[{sceneId:'intro',frame:0}],summary:{id:'title'}
      };
    }
  })
}});
```

清单 tools 的 id/parameters 要与导出相符；manifest 将 description/mode/categories/keywords/reads 保留为无需执行代码的发现元数据。参数复用 SDK 的数字、字符串、颜色、布尔、枚举、向量、数组和对象定义/默认值/约束。保存/预检会类型检查，并加载启用的工具以确认参数定义相同。保留字段 revision、expectedPluginHash、_context 不得用作业务参数。

ctx 默认只含工程尺寸/时基/名称/版本及空场景、序列、素材、文件集合；_context 显式选择 sceneIds/sequenceIds/files，须在清单 reads 中声明。reads.assets=true 才提供素材列表。最大 16 场景、8 序列、64 文件，总序列化上下文最多 8MiB，超预算报错而非暗中截断。

query 返回任意 JSON 数据，最大 256KiB；作者应分页/过滤。plan 返回 operations/files/assetChecks/samples/summary，函数使用相同输入求值两次，变化则拒绝。候选结果最大 8MiB，summary 最大16KiB；默认磁盘 planId，不重复传图层数组/源码。统一 project_preflight 检查类型、引用、素材证据、实际图片与确定性，project_apply 原样提交，一次撤销。供应的资产检查保存在候选，实际可用性仍由原服务验证。两次求值是错误证据检查，不是任意代码确定性的数学证明。

复用 ComponentHost 的编译依赖/SDK 指纹缓存、独立 worker、5 秒调用超时、128MiB JS 堆限制，组件与插件总共最多 12 个模块 worker。源码/import 改动失效，插件/普通组件使用不同缓存键。堆限制不等于整机 RAM；本地 TS 作为用户信任的代码执行，Node API 没有安全沙箱限制。受支持的创作协议返回候选，宿主不向函数传服务写句柄；这不阻止自定义代码使用文件系统。

超时或 worker 退出会淘汰死亡模块；并发重试复用一个新编译，旧 worker 的退出事件不会删除新实例。真实故障流程用无限循环触发5秒超时，随后同源码正常输入恢复，工程版保持不变。源码候选修改还会推导场景入/中/末帧，最多12实际样本并报告coverage；可通过显式samples审阅其它范围。

项目插件清单/参数/内容解析缓存使用128项、8MiB估算字节LRU。每次先比对实际文件字符串探针，未改变的源码不再重复做SHA和JSON解析；任一声明文件/entry/贡献源变化重新校验，依赖与pin仍每次检查。cache.contentDigests与accountedBytes提供工作与空间证据；预算0提供无缓存基线。缓存统计不是进程RAM、所有TS依赖的自动闭包或渲染帧缓存。

声音的library/inspect/plan/preview/MIDI、timeline/preview/waveform/analyze、mix inspect/plan与audit共用audio内置模块；试听/检查复用宿主候选和媒体任务保护，PCM与导出使用同一混音核心。`audio_timeline`默认只返回24个可听片段，offset/limit继续读取、totalClips/nextOffset显示覆盖，includeAll=true请求完整列表。分页不改变源裁切、嵌套速度、淡入淡出或有理数采样位置。

## MCP、CLI 和桌面

插件工具名为 `plugin.<id>.<tool>`。默认仍只有 10 个 MCP 入口；tools_search 可按 pluginId 查询，tool_schema 支持分支/ifHash，tool_call 执行隐藏能力，tools_load 仅加载本连接需要的工具。`plugins_package` 只返回分页文件元数据、字节数和 hash，不把源码重复放进上下文；选定范围使用 project_file_read。清单变化按 catalogHash 条件刷新，禁用/升级/撤销即时影响发现；tools/list 自身也刷新，支持外部有效文件修改。一次目录变化合并为一次 list_changed。命名管道连接打开的桌面服务时同样走此流程。

```text
vmotion plugins-inspect --project . --request inspect.json
vmotion plugins-plan --project . --request plan.json
vmotion tools-search --project . --plugin example.creative
vmotion tool-schema --project . --name plugin.example.creative.compose --paths title,accent
vmotion tool-call --project . --name plugin.example.creative.compose --request arguments.json
```

不指定 --project 的 tools-search/tool-schema 仍查询内置接口。桌面“插件”面板按需加载，支持本地路径注册、贡献来源、启用/禁用/移除和共享撤销。核心/工具 Schema、SDK 声明及新工程 AGENTS.md 同步。

`examples/plugin-lab` 包含实际组件、主题、效果图和两个工具；6秒720p30示例由插件生成，保持可编辑参数和普通关键帧。作者脚本必须显式 --rebuild，--render-only 保留编辑；便携包包含源码资源。`check-plugins.mjs --packaged` 使用真实外部 stdio MCP，覆盖注册、短目录/候选、图片、类型/旧hash/上下文拒绝、升级、禁用后像素保持、撤销、60帧MP4和连接当前服务的CLI。

尚未交付原生像素/声音处理 ABI、自定义 UI 运行时、插件市场/安装和依赖自动打包。当前插件协议可扩展代码组件、资源与 Agent 工作流；后续在同一注册/版本/候选模型上继续扩展。
