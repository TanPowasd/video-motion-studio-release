# 静态图片：海报、封面与缩略图

Vmotion 除了视频，也能直接制作单帧图片：活动海报、视频封面、小红书/公众号配图、方图和竖屏图。图片与视频共用同一套工程格式、图层、文字/矢量/渐变/图片素材、TypeScript 组件、事务、撤销和原生渲染器；预览与导出逐像素一致。软件本身仍不调用任何模型，外部 agent 通过 CLI/MCP 操作。

## 数据模型

- `scene.still`：可选字段，存在即表示该场景是一张图片画板（时长固定 1 帧，帧 0 即成品）。
  - `preset`：创建时使用的预设 ID（仅记录来源，尺寸以 `scene.width/height` 为准）。
  - `dpi`：36–2400，默认 72，写入 PNG（pHYs）/JPEG（JFIF 密度）元数据。
  - `bleed`：出血，画板像素，四边相同；成品（trim）框在画布边缘向内 `bleed` 像素处。
  - `safeArea`：安全区内缩，从成品框起算。
  - `transparent`：PNG/WebP 导出默认是否省略背景。
  - `variants`：最多 16 个尺寸变体 `{id, name, width, height, fit, background?, preset?}`，ID 唯一。
- `project.kind`：`'video'`（默认）或 `'still'`。图片工程首个场景即主画板，编辑器直接进入图片工作区。
- Schema：`schemas/still.schema.json`，并合并进 `scene.schema.json`、`project.schema.json` 与 `operation.schema.json`；SDK 导出 `stillPresets`、`stillTemplates`、`StillSettings`、`StillVariant` 与 image_export 结果类型。

图片画板可以超过视频的 3840×2160 上限：单边最大 **8192px**、单次渲染面最多 **48MP**（A3 300dpi 含出血 1 倍、A4 含出血 2 倍可容纳）。动画场景、序列和视频导出的限制不变。

## 尺寸预设（8 个）

| ID | 名称 | 尺寸 (px) | DPI | 出血 | 安全区 | 说明 |
| --- | --- | --- | ---: | ---: | ---: | --- |
| `poster-a4` | 海报 A4 | 2552×3580 | 300 | 36 | 59 | 210×297mm，成品 2480×3508，含 3mm 出血 |
| `poster-a3` | 海报 A3 | 3580×5033 | 300 | 36 | 59 | 297×420mm，成品 3508×4961，含 3mm 出血 |
| `xiaohongshu` | 小红书 3:4 | 1242×1660 | 72 | 0 | 60 | 笔记封面 |
| `wechat-cover` | 公众号封面 | 900×383 | 72 | 0 | 24 | 2.35:1 头图 |
| `video-cover-720` | 视频封面 720p | 1280×720 | 72 | 0 | 36 | 16:9 缩略图 |
| `video-cover-1080` | 视频封面 1080p | 1920×1080 | 72 | 0 | 54 | 16:9 高清封面 |
| `square` | 方图 | 1080×1080 | 72 | 0 | 54 | 1:1 |
| `vertical` | 竖屏 | 1080×1920 | 72 | 0 | 96 | 9:16 |

印刷预设的 36px 出血即 300dpi 下的 3mm；`trim` 导出后正好是纸张成品尺寸。

## 起始模板（4 个）

| ID | 名称 | 内容 |
| --- | --- | --- |
| `blank` | 空白画板 | 只有背景 |
| `poster` | 活动海报 | 大标题、副标题、装饰圆和信息栏 |
| `cover` | 视频封面 | 色块、粗标题和标签 |
| `card` | 图文卡片 | 浅色卡片、引言和署名 |

模板生成的都是普通原生图层（稳定 ID、可直接编辑），按画板尺寸与安全区排版。

## MCP 工具

三项工具属于发现分类 `image`（另分别归入 composition/render），默认 10 入口不变，通过 `tools_search`（如 “海报 / poster / 导出图片”）、`tool_schema`、`tool_call` 使用，或 `tools_load {categories:["image"]}` 加载。

### still_inspect（只读）

列出图片画板：尺寸、背景、dpi、出血/成品/安全区框、变体、像素数，以及渲染预算 `{maxSide: 8192, maxPixels: 48000000, formats}`。默认只返回 `presetIds`/`templateIds`；`presets:true`、`templates:true` 返回完整预设与模板。`sceneId` 可查询任意场景（返回 `isStill`）。

### still_plan（候选）

一次请求最多 16 个动作，返回一个准确候选：`planId`、`candidate`（交给 `project_preflight`）、`apply`（交给 `project_apply`，含 `expectedCandidateRevision`），提交后为一次撤销。可传 `revision` 防止并发修改。

- `create`：`preset` 或 `width/height`、`template`、`name`、`sceneId`、`background`、`dpi/bleed/safeArea/transparent`、`variants`。
- `update`：修改已有画板，或把任意场景标记为图片（含动画的场景会给出警告，导出使用帧 0）。
- `unmark`：取消图片标记，恢复为指定 `duration` 的动画场景。
- `variants`：整体替换尺寸变体。
- `align`：`left/hcenter/right/top/vcenter/bottom/distribute-h/distribute-v`，参照 `selection/canvas/trim/safe`（单个图层默认安全区，多个默认选区）；支持 `path` 进入嵌套范围，有关键帧的图层会整体平移所有关键帧以保持动画轨迹。

### image_export（写文件）

通过与预览相同的原生渲染器导出主画板及可选变体。

- `format`：`png`（默认，无损）/`jpeg`/`webp`；`quality` 1–100（默认 92，JPEG/WebP）。
- `scale`：0.1–4 倍，矢量与文字按目标分辨率重新渲染，不做位图放大。
- `transparent`：省略场景背景（PNG/WebP）；JPEG 无透明通道，会保留背景并给出警告。
- `trim`：裁掉出血，仅作用于主画板；无出血时给出警告。
- DPI：PNG/JPEG 写入 `dpi × scale`（或显式 `dpi`）；WebP 不含 DPI 元数据，返回警告。
- `variants`：`"all"` 或 ID 数组；`main:false` 只导出变体。适配方式：`contain` 整图居中留边（填充变体背景）、`cover` 铺满裁切、`reflow` 以变体尺寸重新排版渲染（相对画布的布局约束会自适应）。
- `revision` 固定已接受版本；`planId` 导出尚未应用的候选，导出前无需 apply。不带 planId 时，工程存在错误诊断或待修复文件会返回 `VALIDATION_FAILED`。
- `output`：单张时可为文件路径，否则为目录（默认 `exports/images/`，文件名 `名称[-变体][@2x][-trim].ext`）。
- `preview:{maxSide}`：只返回缩略图 dataUrl，不写文件（编辑器导出对话框使用）。
- 结果为每张图片的 `path/format/width/height/bytes/dpi/transparent/pixelHash`，不含 Base64。
- 超出 8192px 单边或 48MP 时返回 `RESOLUTION` 错误（附 width/height/scale），**绝不静默降低分辨率**。

典型流程：

```json
{"name":"tool_call","arguments":{"name":"still_plan","arguments":{"actions":[{"action":"create","sceneId":"poster","preset":"poster-a4","template":"poster","name":"秋季海报"}]}}}
{"name":"project_preflight","arguments":{"planId":"<planId>"}}
{"name":"project_apply","arguments":{"planId":"<planId>","expectedCandidateRevision":"<rev>"}}
{"name":"tool_call","arguments":{"name":"image_export","arguments":{"sceneId":"poster","format":"png","trim":true,"revision":"<rev>"}}}
```

## 命令行

```powershell
vmotion init --project D:/Posters/Autumn --kind still --preset poster-a4 --still-template poster --name "秋季海报"
vmotion image presets                      # 预设与模板，无需工程
vmotion image inspect -p D:/Posters/Autumn [--scene poster]
vmotion image new -p D:/Posters/Autumn --preset video-cover-1080 --template cover --name "封面" [--id cover] [--dry-run]
vmotion image export -p D:/Posters/Autumn --scene poster --format png --scale 2 --trim
vmotion image export -p D:/Posters/Autumn --format jpeg --quality 85 --variants all -o D:/out
```

- `init --kind still`：`--preset` 决定尺寸（未给时 1080×1080，可用 `--width/--height` 覆盖），`--still-template` 默认 `poster`。
- `image new` 内部执行 still_plan → preflight → apply（一次撤销）；`--dry-run` 只规划与预检，预检失败退出码 2。
- `image export` 选项：`--format png|jpeg|jpg|webp`、`--quality`、`--scale`、`--transparent`/`--opaque`、`--trim`、`--variants all|a,b`、`--no-main`、`--dpi`、`--revision`、`-o`。

## 编辑器

- 项目主页「新建图片」（**Ctrl+Shift+N**）：按 印刷/社交/视频/通用 分组选择预设或自定义尺寸，再选起始模板，创建 `kind: still` 工程。工程内也可通过 Ctrl+K「新建图片…」添加画板。
- 图片工作区：打开图片场景时隐藏时间线、播放控制、关键帧和音频面板。画板工具栏提供：添加文字/形状/椭圆；左/水平居中/右/上/垂直居中/下对齐与水平/垂直分布，并可选择对齐参照（选区/画布/成品/安全区）；吸附、标尺、出血与成品线、安全区、中心线开关。
- 吸附：拖动图层时吸附到画板边缘/中心、成品与安全区框以及其他图层的边缘/中心，并显示参考线；按住 Ctrl 暂停吸附，Shift 锁定方向，Alt 平移视图。
- 检查器：未选图层时显示画板属性（尺寸、预设、背景、透明、出血、安全区、DPI、尺寸变体及适配方式、取消图片标记）。
- 「导出图片」对话框（顶部导出按钮或 Ctrl+K「导出图片…」）：PNG/JPEG/WebP、质量、1x/2x/3x、透明、裁切出血、变体缩略图预览，完成后显示文件路径与尺寸。
- 对齐/分布同样出现在 Ctrl+K 命令面板中；样式只使用主题 token（`src/editor/still/still.css`）。

## 限制

- 单边 8192px、48MP 渲染预算；超出返回 `RESOLUTION`，不会自动缩小。A3 300dpi 只能 1 倍导出，A4 300dpi 最多约 2 倍。
- 颜色输出为 sRGB 8 位；不支持 CMYK、专色、ICC 嵌入或 PDF/SVG 矢量导出，印刷前请在专业软件中转换。
- WebP 不写 DPI；JPEG/WebP 为有损格式，像素精确输出请使用 PNG。
- `trim` 只裁主画板；变体使用自身尺寸，`contain/cover` 为整图缩放，只有 `reflow` 会重新排版。
- 中文文字需要运行时提供 CJK 字体（便携包内置；开发/沙箱环境可设置 `VMOTION_RUNTIME` 指向含 Noto Sans SC 的运行时目录）。
- 图片画板仍是单帧场景：动画关键帧会保留，但导出只取帧 0；`unmark` 可恢复为动画。

## 验证

- `tests/stills.test.ts`：预设/参考框/预算与对齐吸附几何，图片工程创建，印刷尺寸画板计划/应用/撤销，标记/取消标记，安全区与选区对齐，PNG 与预览像素一致、倍率、透明、DPI，裁切出血、尺寸变体与超预算拒绝。
- `node scripts/check-stills.mjs [--dev|--packaged]`：真实外部 stdio MCP 客户端，确认默认 10 入口不含图片工具、`tools_search category=image` 与 `tool_schema ifHash`、`agent_guide topic=image`；A4 海报裁切导出 2480×3508@300dpi，JPEG 0.5 倍 150dpi，WebP 透明；`still_plan` 候选经 planId 导出主图与 cover/reflow 变体而不应用；preflight/apply、对齐、按 revision 导出及撤销；超预算 `RESOLUTION`、过期 revision 与缺失场景不修改工程。结果写入 `artifacts/stills-mcp.json`。
