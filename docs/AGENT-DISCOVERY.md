# Agent 按需工具发现

默认 `vmotion mcp --project ...` 使用 compact 模式，只暴露 10 个常用入口：agent_guide、project_context、project_file_read、project_preflight、project_apply、frame_capture，以及 tools_search、tool_schema、tool_call、tools_load。140 项内置创作能力全部仍可使用；启用的项目插件增加 namespaced 能力，不增加默认入口。完整模式 `--tools all` 返回 144 个内置直接工具/发现入口及启用的插件工具，兼容原有直接调用与结果形状。

本轮上下文优化：默认 tools/list 用简短描述，`tools_search` 返回最多160字摘要（截断有标志），省略重复参数名/分类统计和完整插件元数据；`detail:true` 恢复这些字段。查询索引按不可变目录复用，插件变化生成新目录。`tool_schema` 默认给接口/分类/注解，`detail:true` 补说明/调用示例/插件信息；项目插件的身份/版本/hash仍保留，便于拒绝旧接口。detail不改变输入接口hash，`format:expanded` 仍只控制引用展开。

`tool_call` 新增 `fields:["summary.mean","samples.0.pixelHash"]`（最多32条、每条160字符）和 `media:false`。结果选择使用自身字段，禁止原型路径；非法选择在执行前拒绝，不会先写工程。返回 `resultProjection` 含 partial、实际请求路径和missing；缺失结果字段不把已经完成的写操作误报成失败。revision/baseRevision/candidateRevision/applied/valid若存在会保留。数组索引投影以索引对象返回，不重新编号。选字段只缩短传输，不减少底层渲染/检查工作；media=false关闭内联媒体，文件输出和诊断仍执行。完整结果用response=full并省略fields；原生媒体只传一次。

CLI对应 `tools-search --detail`、`tool-schema --detail`、`tool-call --fields a,b --no-media`。窗口打开时仍通过同一工程服务。`composition_edit_layers mode=plan` 返回固定候选，直接apply默认保持；没有新增独立编辑系统或额外默认工具。

`plugins_inspect/plan` 管理项目本地插件和资源贡献；`plugins_package` 只返回分页内容指纹和文件大小。`tools_search pluginId` 查询一个插件的能力，Schema/call/load/list 按清单与源码内容条件hash刷新，支持升级/禁用/撤销和外部文件更新。插件参数接口与导出一致、上下文显式、编辑仍准确候选/一次撤销。CLI工具查询可选 --project，详见 PLUGINS.md。

十八个内置模块140项能力使用统一注册表，唯一名称/处理器/版本/依赖在启动时校验；工程控制、历史恢复、缓存、画面检查及所有创作模块均通过同一注册表分发。assets_query默认24素材摘要、drawing_query默认24图层/16笔迹且点数组按需分页，component_query默认短参数/32通道，audio_timeline默认24片段、render_query默认20任务，project_diagnostics默认20条诊断/冲突定位/待修复文件。color_scopes默认省略分布数组，frame_compare/layer_impact返回短像素指标，原生图片不重复Base64。完整源码/metadata/错误/压感点显式读取，旧完整接口保持兼容。

`project_schema` 的名称来自权威资源注册表，包含声音、混音、插件、分镜与纹理等格式。默认入口数量保持不变；按需读取一个资源或operationType，避免加载全部Schema。

`effect_graph_query`默认24项节点/参数/连接/未用ID/资源/输出，选定根或子图端口后报告实际可达节点。默认参数只显示有界预览，detail读取选定完整值/该参数Schema；旧effect_graph_inspect仍保留完整结果。通过effect_graph_plan的output/outputs及target.output选择共享资源的不同视觉结果，再用render_profile graphCache=true/false核验缓存收益与像素一致性。

`render_compare`在同一工程或planId候选上运行两组配置，默认保留图与作者代码，通过像素hash与重复帧检查区分等价性和确定性，再报告实际耗时/图面/readback/scalar/scratch。节点统计最多256项、默认8个热点定位，超出容量的执行明确报告；节点计时不是独占时间。默认不传逐轮完整性能对象，detail才取匹配帧hash/时间。生成或重映射对象用composition_interactions取得path/frame/contextFrames后定位；index是作者effects数组索引，旧brightness/shadow等隐式前置效果不占该索引。比较不自动改写工程，素材元数据变化或错误配置返回诊断。

animation_layers_inspect默认8层/16通道，层/通道/键页独立，只有includeKeys才取选定键数组；samples为普通键与有序动画层的结果，在驱动前。animation_layers_plan按稳定ID跨scope批量编辑、准确候选与一次undo；motion_plan output=layers从参数化模板生成可重叠动作。普通动画设置extrapolate控制before/after循环或延续。nativeCache基线显示Rust索引编译/命中、真实IPC/定义字节和回退状态；动画资源不通过MCP自动全部注入。详见ANIMATION-LAYERS.md。

vmotion.organization的project_references/reference_sample/reference_plan/sequence_query默认24项分页，查询实际声明、静态literal hint或指定帧的生成用途，不默认读源码/展开所有镜头。全文/JSON pointer/retimed编辑locator/完整clip按detail取得。默认引用索引缓存检查实际文件文本，reference_plan不自动改写代码/pin或删素材；详情见PROJECT-REFERENCES.md。

`tool_schema` 默认使用标准本地 `$ref` 复用重复字段，提供准确约束；`format:"expanded"` 可返回原先的内联表示。保留响应 `schemaHash`，以后传 `ifHash`：接口未变化时只返回 name/hash/notModified。Hash 标识 Schema 与工具说明，不是工程版本；工程写操作仍使用 revision 与原候选。CLI 对应 `tool-schema --name NAME --if-hash HASH` 和 `--expanded`。

此前封装 MCP 实测：sound_plan 接口 JSON 从 38169 字节减到 14821（61.2%），加入程序场后的 effect_graph_plan 从 94825 减到 29295（69.1%），缓存命中仅 120–127 字节。默认 10 入口目录为 14066 字节；同一修改 compact 响应 432 字节，而完整工程读取 45764 字节。图片/音频只通过原生 media block 传送，JSON/文本不重复 Base64。字节是稳定回归指标，实际 token 按外部模型分词计算。

`scripts/check-mcp-budget.mjs --packaged` 通过真实 stdio 客户端检查目录大小、接口引用闭合、缓存命中/刷新、响应体积、错误不修改工程、媒体不重复、加载/恢复与 CLI 一致。优先通过 tool_call 调用隐藏能力，按任务查一个接口；不需要加载全部目录或反复请求完整源码。大型计划用短 planId，查询对象/音符时指定 IDs 和分页，完整数据仅在确需编辑时请求。

初始 tools/list 不必携带所有剪辑、绘画、矩阵、声音和结构操作的 Schema。加入平面特效接口后的实际测量 compact 目录约 13.6KB，完整目录约 217.2KB；这是协议 JSON 字节数，不是模型 token 计数，随接口版本变化。

建议从 project_context 定位工程，agent_guide 确定工作流，再按以下方式操作：

```json
{"name":"tools_search","arguments":{"query":"深度","category":"3d","limit":5}}
{"name":"tool_schema","arguments":{"name":"scene3d_render"}}
{"name":"tool_call","arguments":{
  "name":"scene3d_render",
  "arguments":{"source":{"sceneId":"intro","nodeId":"world","frame":90},"width":640}
}}
```

tools_search 返回名称、摘要、类别、参数字段和读写提示，不返回完整输入 Schema。搜索支持英文名称/描述和中文词，offset/limit 分页；明确工具名称匹配优先，专用词优先于大类标签。可用类别为 core、animation、effects、composition、vector、drawing、media、editing、audio、3d、math、render、recovery，类别允许交叉。

tool_schema 返回选定能力的完整 inputSchema、语义与调用方式。tool_call 验证同一输入 Schema，调用相同工程服务与历史记录；可调用未出现在 tools/list 的能力。返回 structuredContent 与兼容文本，画面/声音作为原生 MCP media blocks 返回，不把 base64 混进结构化诊断。

需要连续使用某类直接工具时加载：

```json
{"name":"tools_load","arguments":{"categories":["animation","composition"],"mode":"add"}}
{"name":"tools_load","arguments":{"names":["matrix3d","scene3d_render"],"mode":"replace"}}
{"name":"tools_load","arguments":{"mode":"replace"}}
```

add 保留已有可选工具；replace 先恢复六个基本创作工具再加载指定项。四个发现入口始终可用。每次实际变化只发送一次 tools/list_changed；重复加载相同集合不发送额外通知。工具加载只影响本次 MCP 连接，另一 agent 与桌面会话不受影响，工程和撤销记录不改变。未知名称使整次加载失败，不部分加载。不能刷新工具列表的客户端直接使用 tool_call，无需动态加载。

compact 模式下的写操作默认只返回 revision、选区、诊断、冲突与撤销状态，保留创建对象/素材/片段等专用结果。画稿修改返回图层 ID 和笔迹数量，完整笔迹用 drawing_get 获取。素材导入明确返回 importedAsset；PSD/OpenRaster 返回 importedArtwork 的素材 ID。project_inspect 是显式全量读取，仍可通过 tool_call 调用。需要原结果时使用 `tool_call` 的 response=full；`--tools all` 的直接工具保留原有结果形状。

错误提供 code、原诊断/参数路径和对应恢复建议。REVISION_CONFLICT 重新读 context；FILE_HASH_CONFLICT 重新读文件；ASSET_CHANGED 重新取证素材；参数错误先读 tool_schema。工具路由不会绕过 revision、文件 hash、素材证据、轨道锁、冲突和原子事务。

存储候选支持 `{planId}`，自动读取内容校验的缓存操作；mesh_generate/mesh_import 默认使用该方式，参见 MESHES.md。FILE_WRITE 提供文件、系统错误和尝试数；Windows 短暂占用在有界退避后重试，持久失败应解决实际存储问题并重新读取 context。

桌面已打开时，新工程服务在命名管道返回前就压缩 agent 结果，避免把整个源码快照来回传输。连接探测使用精简 ping；旧服务缺少新接口时保留已有桥接兼容。CLI 也使用同一工具定义与调用规则：

```powershell
node dist/cli/index.mjs tools-search --query 深度 --category 3d
node dist/cli/index.mjs tool-schema --name scene3d_render
node dist/cli/index.mjs tool-call --project my-project --name sequence_edit --request edit.json
node dist/cli/index.mjs tool-call --project my-project --name project_inspect --full
node dist/cli/index.mjs mcp --project my-project --tools all
```

CLI 的 request 文件为具体能力的参数对象，不含外层 name/arguments。默认媒体返回文件路径，--inline 额外输出 media 数据。readonly/destructive/idempotent 提示用于 agent 识别能力性质，不是权限或批准机制；调用能力仍取决于工具参数与工程实际状态。软件本身不接入模型。

文字/矢量批次：graphics_inspect 分页共享几何，graphics_plan 默认短存储候选；pathText/textAnimator/shapeOperator 可单独查询 Schema。详见 TYPOGRAPHY-SHAPES.md。

电影/运动批次：tracking_analyze 是独立 worker 背景任务；tracking_inspect 返回分页质量与失跟区间，tracking_evidence 给出原始像素标注，tracking_plan 保存轨迹并一次候选烘焙贴附/稳定/四点贴图。默认短任务/候选；详见 TRACKING.md。

设计资源：theme_inspect/plan 提供实时 typed Token/别名/继承/局部覆盖；template_inspect/plan 发布固定源码版本、端口实例、选择升级与私有可编辑副本。tool_schema paths 可仅查询需要的属性分支，回复明确partial，执行仍完整验证；详见 THEMES-TEMPLATES.md。
