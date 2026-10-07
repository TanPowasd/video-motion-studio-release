# 实时主题与模板实例

此批把品牌主题、可复用版本、实例升级、私有副本与 Agent 接口一起交付。颜色/尺寸不需要模型或服务器。项目仍以 JSON/TypeScript 为权威来源。

## 主题

`components/themes/*.json` 的 kind 为 theme、version 为 1。Token 使用稳定点路径 ID，类型为 color/font/number/string/boolean/vec2/vec3。值与 alias 二选一；parent 引用另一份主题。父级先合并，子级覆盖相同 ID，类型保持一致，再解析 alias。缺失引用、继承/别名循环、数字约束和非法 native 颜色在保存/预检中报错。

```json
{"kind":"theme","version":1,"id":"brand","name":"品牌","tokens":[{"id":"brand.accent","type":"color","value":"#55bbcc"},{"id":"title.color","type":"color","alias":"brand.accent"},{"id":"type.heading","type":"number","value":32,"min":16,"max":64}]}
```

Node.theme 的 links 绑定属性→Token，baseline 捕获绑定时的字面值，overrides 保存显式局部值。SDK `bindTheme(node,{source,links})` 或 theme_plan 自动捕获 baseline。值在原生关键帧/表达式/布局之前求值，预览、导出、选框和参数检查共享解析。源文件改动让未覆盖的实例同步；修改普通字面属性会成为局部值，不会被下一次主题更新覆盖。局部显式 overrides 优先；数值关键帧/驱动继续控制动画。clearLocal 恢复 captured baseline 并删除显式覆盖；detach 把当前主题基础值写回普通字段，动画继续保留。

支持现有数值通道、文字/字体/字重/行高、填充/描边/渐变与阴影颜色、visible 及参数路径。数字按属性原单位使用，unit 是描述而非隐式转换。组件参数路径须存在；绑定工具可先填充声明默认值。别名类型不自动强制转换，原生颜色值以 Skia paint 解析验证，字体仍需本机/项目字体管理。

theme_inspect 默认 24 Token 分页，按 target 查询可看到 baseline、literal、effective 与值来源。theme_plan 支持精确 hash 的创建/修改/删除 Token/parent，以及跨场景 bind/update/clearLocal/detach/toggle。文档改动会提议所有场景的入/中/末帧；最多 12 个实际样本，覆盖/遗漏明确。生成内容保存到 owner 覆盖，源码不改写。主题删除或 Token 更名须同时修正引用。

## 模板版本与端口

template_plan.publish 可捕获同一编辑 scope 的兄弟根图层及后代，或明确给出 nodes；原生层级、键、遮罩和组件逻辑保留。definition 指定 id/name/version、尺寸/时长、参数定义与 ports。参数沿用 SDK 的字符串、数字、颜色、枚举、数组、对象/向量和严格默认值；端口将某个参数路径直接映射到某个稳定图层 ID 的内容/外观/组件参数路径。

发布生成 `components/templates/<id>/v<version>/manifest.json`、专属 source scene 和捕获代码目录。实际编译依赖与引用 JSON 被复制，作者原文件保持可编辑。相对 imports 保留目录关系；明确的 component/source/meshSource 字面路径改为捕获路径。无法自动固定的动态或其他项目相对引用须明确 allowSharedCode，报告 shared 引用。项目素材、共享场景、SDK/外部包与 live Node.theme 仍使用项目资源，不把任意代码宣称为独立沙箱包。

linked 实例为普通 scene 图层，templateInstance 指向 manifest 与内容 hash，params 暴露端口。源场景尺寸/相机、实例变换、局部时钟和内部独立编辑复用场景核心。被端口控制的图层字段先接收参数，再执行内部动画及实例覆盖；端口控制同一字段时不再跟随源图层该字段的主题，根实例参数本身可以绑定主题。内部层级/属性覆盖保存在普通 structure/overrides 中。

manifest 及捕获源文件/场景 hash 在 linked 实例中固定，修改发布版本不会默默改变现有视频；应修改作者源并发布新 version，再选择要升级的实例。同一 id/version 不重复覆盖。修改工程 FPS 需要明确迁移或脱离固定版本，工具不自动重写任意时间代码。

## 升级与私有副本

升级比较旧默认值、当前实例值和新默认值。未改字段采用新默认；自定义值保留并列在 keptParameters。可明确选择 defaults 或给出局部 values。旧动画、内部属性与结构覆盖保留；新类型/约束仍严格检查，不静默钳位。删除自定义参数、重复/碰撞迁移及非法新内容会拒绝候选，旧实例留在原版本。

新 manifest.migrations.parameters 支持参数路径改名，根参数动画/表达式目标、self/base 的参数引用和主题链接随之迁移；layers 支持相对图层路径改名，内部覆盖、结构顺序/移除/父级、局部 layer() 文字引用与路径/布局/遮罩引用随之转换。任意 TypeScript 逻辑及跨实例表达式不会猜测改写；作者仍负责新版本源图的正确性。removeChannels/removeOverrides 是明确删除接口，不会因新图层消失就丢弃旧覆盖。

detach 复制该实例的捕获代码和源场景，创建 mode=local 的私有 manifest。参数、动画、主题和内部覆盖继续工作；本地副本可自由修改，其他 linked 实例保持原版本。共享素材/外部场景依旧共享。版本源的可编辑副本解决局部修改需求，不解除其他 linked 实例的完整性校验。

## Agent、缓存和验证

theme_inspect/theme_plan/template_inspect/template_plan 使用精简摘要、明确局部属性路径、默认 stored planId、原样 project_preflight/project_apply 与一次撤销。CLI 使用 theme-inspect/plan/template-inspect/plan --project ... --request ...；project_schema 可分别读取 theme/themeBinding/sceneTemplate/templateAuthor。内部已有参数编辑与关键帧工具也适用于模板端口。

`tool_schema` 的可选 paths 提取属性分支，例如 `['revision','publish.definition','publish.capture']` 或 `['revision','upgrades']`，避免为一次升级读取所有内联 Node 结构。返回 projection.partial=true，执行仍验证完整接口。分支顺序规范化，schemaHash 区分不同投影，可用 ifHash；CLI tool-schema --paths 使用同一逻辑。对于未读字段，应继续查询对应分支/完整接口，不能把部分说明当作完整参数列表。

主题与模板解析缓存各限制 128 项、4/8MiB 的 key/源码估算字节。探测实际源文本/父级/捕获依赖/场景，一旦变化重新解析和校验，少量字段写入只复制相关分支，长动画数组不重复克隆。`render_profile resourceCache=false` 提供同像素不保留缓存基线，并报告实际 resolutions/prepares/portWrites；计数不等于整体 RAM/实时能力。UI 绘画/声音工作区改为按需加载，保持已实现流程。

`examples/design-lab` 为 6 秒 720p30 的可编辑版本/自定义对照。`scripts/create-design-lab.ts --render-only` 保留编辑；--rebuild 发布新版本，旧发布内容不覆盖。真实 MCP 验证脚本为 `node scripts/check-design.mjs --packaged`，覆盖主题更新、参数/内部覆盖、选择性升级、冲突、私有源编辑、Schema 分支/缓存、同像素基线、MP4 与撤销。最终结果在 WORK-STATUS.md。

此批未实现跨项目包/依赖安装、任意代码自动迁移、完整视觉编辑节点画布或正式长片/GPU验收；这些边界不影响已验证的本地模板/主题工作流。
