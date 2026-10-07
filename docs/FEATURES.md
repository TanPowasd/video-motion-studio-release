# Vmotion

本地可编程视频创作工作站。**软件不接入 AI 模型**；外部 agent 通过文件、CLI 或 MCP 操作工程。


人直接用 Studio 界面编辑；外部 AI 通过项目文件、CLI 或 MCP 操作同一工程。顶部“连接 MCP”只提供配置，程序不内置 AI 工作台或模型。底层工程服务、渲染与撤销共用。

[创作指南](STUDIO-GUIDE.md) · [Agent 工作台](AGENT-WORKBENCH.md) · [公开 Release 仓库](https://github.com/TanPowasd/video-motion-studio-release)

支持项目自定义 Python 渲染器和完整 WGSL 着色器：按帧生成 RGBA 或处理图层/节点图输入，预览与导出共用。便携包内置 Python 标准库；自定义环境可用 VMOTION_PYTHON。详见 [自定义渲染](RENDER-PROGRAMS.md)。

当前是可运行的早期版本：已建立共享工程服务、Rust 动画求值、Rust/Skia CPU 绘制及 Direct3D12 逐像素特效加速、Electron/React 编辑器、TypeScript 组件、CLI 和 stdio MCP。项目以 JSON + TypeScript 保存，可视化修改写回文件。

外部 agent 可先查询摘要与源码片段，再对候选代码/JSON 预检类型、运行错误和画面，最后原子提交；错误文件仍保留最后有效预览。详见 [agent 代码创作流程](AGENT-WORKFLOW.md)。

MCP 默认以 10 个入口提供按需发现：tools_search 搜索能力，tool_schema 读取一个接口，tool_call 调用全部 140 项内置能力及启用的项目插件，tools_load 按任务加载直接工具。写操作返回精简版本/诊断，完整源码与传统目录可显式请求。详见 [按需工具发现](AGENT-DISCOVERY.md)。

本地插件声明语义版本/依赖、组件/效果图/动作/主题/声音/模板贡献和类型化 Agent 工具。plugins_inspect/plan 管理注册与准确候选，MCP目录/Schema随升级、禁用和撤销动态刷新；工具在有界worker中复用工程快照与共享预检/提交。主题与版本模板已抽出为首个内置模块，其他内置功能继续迁移。详见 [插件系统](PLUGINS.md)，可编辑示例为 examples/plugin-lab。

十八个内置模块统一注册与分发全部140项能力，覆盖动画、合成、三维、绘画、剪辑、声音、工程恢复、缓存和画面检查。素材/画稿/组件参数、音频时间线、渲染任务与工程诊断提供按需分页查询，控制Agent上下文大小。

工作站重构后，“创作工具”提供八类专用可视化页面：节点图、动作/动画层、三维、粒子、分镜/转场、混音、画面检查和性能。属性检查器可新建表达式/布局/路径，普通关键帧支持外插；草稿使用同一固定候选与一次撤销。详见 [可视化工作站](VISUAL-WORKSTATION.md)。

MCP 搜索/Schema 默认省略重复说明，`detail:true` 显式读取完整元数据；`tool_call fields` 按结果路径选择字段并保留版本/有效性，`media:false` 关闭内联媒体传输。默认十入口保持，完整结果仍可显式请求。

原生颜色示波器、准确候选画面对比与图层临时隐藏影响分析提供有界像素证据，默认短摘要与原生图片，分布数组按需读取。检查不修改源码/历史，区分画面差异与艺术判断。详见 [像素检查](PIXEL-REVIEW.md)。

Windows 使用独立 Rust/wgpu Direct3D12 进程加速特效图中的颜色矩阵、色键/亮度键及单输入通道处理。连续节点合并为一次 dispatch，二进制传输、缓冲复用与舍入边界修正保留 CPU 画面；预览/导出共用执行器，`render_profile/render_compare` 返回设备、传输、修正与耗时证据。文字/矢量/3D 与其它效果仍走 CPU。详见 [显卡特效](GPU-EFFECTS.md)。

Agent 可用 `agent_guide` 获取精简路线，通过 `media_sample` 取证素材，再用 `sequence_plan` 返回固定版本的剪辑候选。矩阵 3D 提供批量顶点、层级、相机与剪裁；`scene3DLayer` 使用 Rust 深度缓冲绘制穿插网格，`scene3d_render` 返回彩色/深度/面 ID 图和像素对象定位。详见 [Agent 媒体](AGENT-MEDIA.md)、[矩阵 3D](MATRIX3D.md) 与 [深度 3D](DEPTH3D.md)。

3D 网格支持程序化球体、圆柱、圆锥、圆环、函数曲面与本地 OBJ 导入。mesh_generate/mesh_import 生成可复用 JSON 资源及可选放置，默认用短 planId 完成预检和原子提交。mesh_inspect 提供边界/面积/体积/拓扑与面分页，meshSource 固定到工程版本。详见 [网格与 OBJ](MESHES.md)。

原生材质支持平滑法线、GGX 金属度/粗糙度、方向光/点光、自发光、曝光和 SDR 色调映射；scene3d_materials 按实例查询/计划编辑并支持数值键。详见 [三维材质](MATERIALS3D.md)。

平面特效新增波形/旋转扭曲、膨胀、RGB 分离和线性/圆形擦除，使用图层坐标与透明边缘采样。effects_plan 按稳定 ID 批量创建/排序/复制并自动迁移关键帧，预检后一次提交。详见 [平面特效与 agent 工作流](EFFECTS2D.md)。

图层运动模糊和时间拖尾重新求值历史 TypeScript/场景内容，支持透明度、遮罩、纯函数粒子和顺序效果。liquify 提供可关键帧编辑的推移/旋转/膨胀笔刷场。particles_inspect/particles_plan 查询解析粒子证据并创建参数可编辑的发射组件；随机跳转与导出共用同一实现。详见 [时间效果与粒子](TEMPORAL-PARTICLES.md)，组合示例为 examples/temporal-lab。

effect_graph_query/inspect/plan 与 SDK 支持可编程节点图：分支、混合、遮罩、图层输入、噪声/置换、参数连接、嵌套资源和命名输出选择。新增直通RGBA通道重组与sRGB/linear颜色矩阵；Agent默认分页取证，按稳定ID短编辑，原生预检后一次提交/撤销。编译缓存检查实际子资源并提供无缓存像素/性能基线，图层实例保留参数键和组件源码。详见 [特效节点图](EFFECT-GRAPHS.md)，examples/graph-outputs-lab提供六秒合成演示。

keyer支持颜色/亮度抠像、柔和遮罩和去溢色；运行时通过严格旁路、实际alpha范围和分块内核减少图面/像素开销。render_compare给Agent同一候选的优化前后像素、实际耗时/内存与有界节点定位，保留完整配置与证据，不自动改写画面。examples/keying-lab提供可编辑抠像与背景合成演示。

动画层支持有序加法/乘法/替换、权重与局部时钟、循环/外插曲线，motion_plan可生成可继续编辑的叠层动作。原生索引缓存和受控属性传输减少重复排序/发送，Agent用nativeCache对照像素和实际开销。详见[动画层](ANIMATION-LAYERS.md)，示例examples/animation-layers-lab。

工程组织模块支持分页引用图、生成内容采样定位、选定用途的批量换源和镜头窗口查询。静态声明与动态代码覆盖范围明确，候选检查素材/窗口/锁定及文件hash，保留作者源码、稳定对象和共享撤销。详见[工程引用](PROJECT-REFERENCES.md)。

视觉构建新增七种确定性程序化纹理、带图层通道/中点/空间的贴图置换、gradientMap/bloom/radialRays。visual_templates/plan 提供九组可编辑组合模板；纹理/置换/光束区域与全画布基线像素一致，render_profile 返回实际 fieldPixels 和耗时。详见 [纹理与光效](VISUAL-FIELDS.md)，示例为 examples/visual-fields-lab。

属性表达式、布局约束和曲线路径共用一套属性依赖求值：基于动画值的联动、锚点/比例尺寸/留边/宽高比、SVG 弧长运动及自动朝向。drivers_inspect/plan 组合编辑多个场景，curve_path 提供切线/位置证据；渲染、选框和动画检查使用实际结果。详见 [属性驱动批次](PROPERTY-DRIVERS.md)，示例为 examples/drivers-lab。

通用创作与性能批次新增八种参数化场景转场、隔离合成/加法混合、声明场景依赖、按实际导入复用组件编译与有界画布池。render_profile 提供真实冷/热耗时、编码、缓存/内存和重复画面证据；transition_plan 批量创建复用合成。详见 [性能与转场](PERFORMANCE-TRANSITIONS.md)，二维数学/原生三维组合示例为 examples/workstation-lab。

分镜 JSON 支持章节、稳定镜头、来源/时长与配音绑定，storyboard_plan/inspect 复用剪辑候选和一次撤销；sequence_audit 检查片段范围及全片分层抽样画面，明确覆盖与遗漏。桌面预览使用无损 RGBA 本地传输，省去 PNG 编解码，CLI/MCP 证据仍为 PNG。详见 [分镜与预览](STORYBOARD-PREVIEW.md)，可编辑例子为 examples/storyboard-lab。

媒体工作流支持稳定 ID 重链接候选、后台无损代理生成/取消/失效、实际代理/屏幕尺寸预览解码，以及受保护文件之外的准确缓存清理计划。桌面素材库提供“媒体与缓存”，最终导出保持原素材。详见 [媒体与缓存](MEDIA-CACHE.md)。

TypeScript 组件可暴露枚举、布尔、向量、数组和嵌套对象，SDK 自动推导类型，界面与 MCP 共用验证和关键帧规则。详见 [组件参数](COMPONENT-PARAMETERS.md)，可运行示例位于 `examples/parameter-lab`。

主时间轴支持本地声音试听，按 48 kHz 采样位置分段加载，并复用导出的混音规则。MCP 可返回短音频及 RMS/峰值/波形检查数据。详见 [声音预览](AUDIO.md)，同步示例位于 `examples/audio-lab`。

声音制作支持 JSON 音符编曲、合成/FM/鼓组、长音频采样加工、自动化、总线及 EQ/Delay/Chorus/Reverb/Compressor/Limiter。sound_plan/preview 提供准确候选的原生试听和一次撤销，MIDI 导入/导出明确报告遗漏；素材库可新建/编辑声音。详见 [音效与音乐制作](SOUND-MUSIC.md)，原创演示为 examples/sound-lab。

画面检查可跨采样帧定位文字截断、越界、重叠、遮挡和运动突跳，返回对象 ID 与标注图。界面、CLI、MCP 和候选预检共用规则，几何提示仍需目视确认。详见 [画面检查](VISUAL-AUDIT.md)，示例位于 `examples/visual-audit-lab`。

`visual_repair_plan` 以明确布局意图对稳定对象 ID 生成批量修复候选：适配完整文字高度、画布/父级坐标移动和移回画布。默认保留关键帧轨迹，支持单帧姿态修改；生成内容写入覆盖，预检后一次提交/撤销。`render_start` 和 CLI `render --revision` 可确保导出刚审阅的版本。详见 [Agent 检查与修复闭环](AGENT-REVIEW.md)。

`motion_templates` 提供带参数的内置/项目动作，`motion_plan` 把入场、强调和退场组合应用到多个场景，支持单独的参数、延迟、局部时钟和冲突保护。JSON 模板与生成的原生关键帧共同进入候选，预检后一次提交/撤销；SDK 也能直接复用相同资源。详见 [参数化动作编排](MOTION-TEMPLATES.md)。

矢量图层支持布尔运算、路径裁切、虚线流动、端点/拐角与实线转轮廓。SDK、CLI 和 MCP 共用原生几何，界面可从选中图层生成保留来源的静态路径快照。详见 [矢量动画](VECTOR-ANIMATION.md)，示例位于 `examples/vector-lab`。

重复器可把同父级图层生成可编辑的线性、网格或放射图案，参数支持动画，单个副本保留稳定 ID 与覆盖。二维仿射矩阵供图层、SDK、渲染和选框共用。详见 [重复器与仿射变换](REPEATERS.md)，示例位于 `examples/repeater-lab`。

选中图层可生成共享 JSON 场景并在原位预合成；不同引用实例可独立编辑内部属性和结构，源更新同步，覆盖优先。嵌套引用的尺寸、相机、选取、CLI/MCP 操作沿用统一模型。详见 [共享场景](SHARED-SCENES.md)，示例位于 `examples/shared-scene-lab`。

剪辑支持电影与二创工作流、分割/裁切/滑移/波纹删除、多选链接、入出点范围、节拍标记和可编辑 SRT/VTT 字幕；分割保留淡化与变速声音相位。详见 [二创与电影剪辑](FILM-REMIX.md)。视觉图层的变速/冻结/循环/重映射见 [内容时间](CONTENT-TIME.md)。

界面已重构为专业工作站：可调面板、适应/缩放画布、可缩放与拖动的时间轴，以及场景/任意图层组的独立合成页。点击场景进入；图层组和代码组件可以双击或点击右侧箭头进入，组内时间轴仅显示当前内容。操作说明见 [UI 工作区](UI.md)。

## 启动

需要 Node.js 22+；视频、音频和代理功能需要 FFmpeg/FFprobe 位于 PATH。原生动画核心的构建需要 Rust；Skia 绘制使用带预编译原生绑定的 `@napi-rs/canvas`。

```powershell
npm ci
npm run native:build
npm run build
npm run desktop
```

桌面版默认进入项目首页，提供新建、打开和最近项目。新建支持空白工程与科普示例，可设置名称、保存位置、分辨率、帧率和初始时长；编辑器顶部保留新建/打开入口（Ctrl+N / Ctrl+O）。已有工程选择含 `project.vmotion.json` 的文件夹打开。科普示例只在明确选择模板时创建。在代码工作区修改组件，在动画工作区编辑参数与图层结构；绘画工作区使用独立的图层文档，完成后发布整张画稿或选定图层，再从素材库拖入画布/时间轴。详见 [绘画工作流与 agent 接口](DRAWING.md)。

`npm run package:dir` 生成 `release/Vmotion/Vmotion.exe` 自包含便携版，内置 Electron、Node、原生核心、编译器、FFmpeg/FFprobe 和中文常规/粗体字体。复制完整文件夹即可使用，设置默认保存在包内profile。`scripts/portable-zip.ps1` 生成 ZIP 和校验文件，`Vmotion-previous-*` 是历史封装备份。详见 [便携包](PORTABLE.md)。正式安装/自动升级仍未实现。

开发模式使用两个终端：

```powershell
npm run dev
npm run dev:ui
```

浏览器访问 `http://127.0.0.1:5173`。构建后的本地服务可直接访问 `http://127.0.0.1:4318`。

## 命令行

```powershell
node dist/cli/index.mjs init --project D:/Projects/MyVideo --name "我的科普视频"
node dist/cli/index.mjs init --project D:/Projects/Waves --template science --width 1280 --height 720 --fps 30 --duration 20
node dist/cli/index.mjs inspect --project D:/Projects/MyVideo
node dist/cli/index.mjs validate --project D:/Projects/MyVideo --json
node dist/cli/index.mjs frame --project D:/Projects/MyVideo --frame 90 --output frame.png
node dist/cli/index.mjs render --project D:/Projects/MyVideo --output video.mp4
node dist/cli/index.mjs render --project D:/Projects/MyVideo --format png --output frames
node dist/cli/index.mjs render --project D:/Projects/MyVideo --format wav --output audio.wav
node dist/cli/index.mjs pack --project D:/Projects/MyVideo --output D:/Portable/MyVideo
```

`init` 默认创建空白工程。`--template science` 创建波形示例；上述设置与桌面版使用同一验证和工程创建逻辑，每个工程均附带 agent 使用说明。已有非空文件夹不会被覆盖。

`render` 支持帧范围、分辨率、编码器和检查点续渲染。可用编码器来自本地 FFmpeg；可以使用 `--encoder` 显式指定。格式/检查失败、渲染失败使用不同的非零退出码。CLI 默认输出 JSON，MCP 模式 stdout 仅输出协议消息。

## 外部 agent 与 MCP

将下面的配置加入 agent 的 MCP 配置，替换安装目录与工程目录：

```json
{"mcpServers":{"vmotion":{"command":"node","args":["E:/Vmotion/dist/cli/index.mjs","mcp","--project","D:/Projects/MyVideo"]}}}
```

MCP 提供工程查询、验证、事务、撤销/重做、冲突解决、选区、组件参数定义、帧截图、渲染队列、取消、素材导入、媒体检查、波形、代理和打包。桌面打开时通过项目命名管道共享会话；未打开时启动无界面的本地工程服务。

修改前读取 revision 和对象 ID。可通过 `project_transact` 提交语义操作，也可直接编辑 JSON/TS 文件。组件参数、节点、轨道和片段等操作的 schema 位于 `schemas/`。每个创建的工程包含 `AGENTS.md`。

## 工程与组件

新版动画工具：时间/循环/错峰、物理弹簧、轨迹与点形变、整体图层合成、渐变、文字分批入场、发光/模糊/调色/阴影效果栈、种子粒子、历史残影和 2.5D 相机投影。用 `vmotion guide` 或 MCP `animation_guide` 读取接口，`vmotion sample` / `frame_sample` 检查多个时刻。完整用法见 [动画接口](ANIMATION.md)，功能边界见 [AE 能力对照](AE-CAPABILITIES.md)。可运行示例在 `examples/animation-lab`。

- `project.vmotion.json`：分辨率、有理数帧率、资源、场景和序列文件清单。
- `scenes/` 与 `sequences/`：稳定 ID、图层、关键帧、多轨片段和标记。
- `components/`：导出 `defineComponent` 的 TypeScript 组件。
- `assets/`：托管素材、绘画笔迹与导入的分层画稿。
- `.vmotion/`：编译缓存、事务日志、恢复记录和渲染检查点，不属于工程源码。

```ts
import {defineComponent, text, plot} from '@vmotion/sdk';

export default defineComponent({
  name: 'Function plot',
  parameters: {amplitude: {type: 'number', default: 1, min: 0, max: 5}},
  render(ctx, params) {
    return [
      text('label', '函数图像', {x: 20, y: 20, width: 600, fill: '#ffffff'}),
      plot('curve', x => Math.sin(x - ctx.seconds) * Number(params.amplitude), [-6, 6],
        {x: 20, y: 120, width: 800, height: 300}),
    ];
  },
});
```

SDK 包含曲线、缓动、关键帧、种子随机数、公式、坐标轴、关系图、布局辅助、贝塞尔轨迹和排序过程数据。组件在独立 Worker 执行，提供 frame/seconds/fps/尺寸/seed；应使用项目时间与种子随机数，保持同步、纯函数式帧求值。Worker 是运行隔离，**不是执行不可信代码的安全沙箱**。

自定义组件内部图形由代码生成，可视化编辑它暴露的参数；不会尝试反向改写任意 TypeScript。

## 当前能力与验收边界

已实现：中文与 Unicode 文字、自动换行与逐字显示、矢量路径与路径显示进度、公式 SVG、图表、关键帧/缓动/弹簧、父子变换、嵌套场景与序列、遮罩、混合、模糊和基础色彩调整；图片/视频图层、音频混合、WAV/MP4/PNG 导出；基础压感笔迹、洋葱皮与持帧；PSD/OpenRaster 栅格图层导入。

尚未完成原规划的专业版验收：全场景 GPU/共享纹理、1080p/30fps 参考工作站基准、两小时完整 4K/60fps 成片、完整曲线编辑器与曝光表、电影级跟踪/抠像/调色、原生插件 ABI、3D 贴图/透明材质/阴影及 HDR。基础跟踪/抠像/材质与自动代理预览已实现。PSD 文字/图层样式/特殊遮罩不重建为可编辑 Photoshop 对象，导入报告兼容性。视频解码继续使用 CPU 帧管线。

这份状态说明区分了实际可用能力与后续路线，不把接口或架构预留算作已实现的功能。

## 验证

```powershell
npm run typecheck
npm test
npm run native:test
npm run build
```

集成测试覆盖：事务回滚、撤销/重做、外部修改与冲突、格式兼容、任意帧求值、公式像素、实际带音轨 MP4、音频波形与混音、取消/检查点续渲染、素材打包、分层画稿和外部 MCP 客户端。

## 许可与分发

自研 SDK、工程格式、核心、CLI、MCP、桌面创作界面与 Agent 工作台统一使用 Apache-2.0。第三方依赖保留各自许可。

便携打包使用固定版本 LGPL shared FFmpeg/FFprobe，保留 DLL、许可证、对应 FFmpeg 源码、构建脚本与来源哈希，不复制开发机 PATH 的 GPL 构建。字体保留 SIL OFL。运行时优先包内路径，显式环境覆盖仍支持开发用途。
