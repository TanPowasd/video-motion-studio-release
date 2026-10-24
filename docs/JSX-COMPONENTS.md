# JSX / TSX 组件

外部 agent 最熟悉 React/JSX 的写法。Vmotion 提供自己的 JSX 运行时：`components/*.tsx` 里的 JSX 在每一帧被“降低”（lower）为现有的扁平节点列表，再由同一个 Rust/Skia 原生核心渲染。没有浏览器、没有 React DOM、没有 reconciler，也没有组件状态——每一帧都是时钟的纯函数，任意跳帧结果一致。

`.tsx` 与 `.ts` 组件可以混用、互相导入；预检、原子提交、共享撤销、变更记录和画面检查对两者完全相同。

```tsx
import { defineComponent, useClock, remap, springTo, Stage, LocalTime } from '@vmotion/sdk';

function Title({ label }: { label: string }) {
  const { frame } = useClock(); // 在 <LocalTime> 内是局部帧
  return (
    <text id="title" x={80} y={300} width={1100} height={90} fontSize={64} fontWeight={700}
      fill="#f4f7ff" opacity={remap(frame, [0, 12], [0, 1])}>
      {label}
    </text>
  );
}

export default defineComponent({
  name: '标题卡',
  parameters: { label: { type: 'string', default: '你好，JSX' } },
  render(ctx, p) {
    return (
      <Stage id="stage" background="#07090f">
        <rect id="bar" x={80} y={400} height={6} width={springTo(ctx, { from: 0, to: 600 })} fill="#7cf3ff" />
        <LocalTime start={10}>
          <Title label={p.label} />
        </LocalTime>
      </Stage>
    );
  },
});
```

`render` 可以返回 JSX、SDK 构建函数生成的节点数组，或两者混合；`defineComponent` 只在需要时降低 JSX，原有 `.ts` 组件输出保持不变。组件编译器自动为 `.tsx` 使用 `jsxImportSource: "@vmotion/sdk"`，文件里不需要写 pragma（为了让编辑器/仓库 tsc 识别，示例保留了 `/** @jsxImportSource @vmotion/sdk */`）。

## 元素

小写元素对应现有节点类型，属性就是节点属性（`x`、`y`、`width`、`height`、`rotation`、`scaleX`、`opacity`、`fill`、`gradient`、`radius`、`stroke`、`strokeWidth`、`shadow`、`blur`、`blend`、`fontSize`、`effects`、`maskId`、`clip`……），与 `rect()`/`text()` 构建函数完全一致。

| 元素 | 节点 | 说明 |
|---|---|---|
| `<group>` | group | 唯一能包含子元素的图形元素；子元素使用组的局部坐标 |
| `<rect>` `<ellipse>` | rect / ellipse | |
| `<path d="…">` | path | `d` 是 `path` 的别名 |
| `<text>…</text>` | text | 子节点只能是字符串/数字，拼接为 `text` |
| `<formula>` | formula | 子文本或 `tex` 为 TeX |
| `<image src>` `<video src>` | image / video | `src` 为工程相对路径，`asset` 为素材 ID；视频支持 `trimStart`（帧）、`playbackRate` |
| `<scene>` `<component src>` `<chart>` `<drawing>` `<scene3d>` `<program>` | 同名节点 | 嵌套场景/组件等 |
| `<node type="…">` | 任意 | 原始节点类型的兜底写法 |

便捷属性：`scale`（同时设置 scaleX/scaleY）、`origin`（`'center'`、`'top-left'`、`[x, y]`、`{x, y}`）、`skewX`/`skewY`（度，合成到 `matrix`）、`zIndex`（同级稳定排序）。`opacity` 会被限制在 0–1，避免弹簧过冲报错。

数组、Fragment（`<>…</>`）、`null`/`false`/条件表达式都可以直接作为子节点；SDK 构建函数返回的节点（如 `particles()`、`group()`）也可以放进 `<group>`，ID 自动加上父组前缀。

## 稳定 ID

ID 决定视觉编辑、变更高亮和撤销能否持续附着在同一个图层上，规则是确定的：

1. 本地名 = `id` 属性 › `key` › 自动名 `类型-序号`（如 `rect-0`，按同一作用域内同类型计数）。
2. `<group id="card">`（以及 `<Stage>`）内的子元素 ID 为 `card/子名`，与 `group()` 构建函数相同。
3. 带 `key` 的函数组件、`<LocalTime>`、`<Step>`、Fragment 会为内部 ID 加 `key/` 前缀，因此 `items.map(i => <Card key={i.id} />)` 中各卡片的 `title` 不会冲突。不带 key 的函数组件和时间容器不产生前缀。
4. 重复 ID 直接报 `JSX_DUPLICATE_ID`，指出两个位置并建议加 `id`/`key`。

自动名在增删同级元素时会移动，预检对没有 `id`/`key` 的元素给出 `JSX_AUTO_ID` 警告（不阻止提交）。需要被人手动调整的元素请写 `id`。

## 时间

| API | 作用 |
|---|---|
| `useClock()` | 当前组件的时钟 `{frame, seconds, fps, width, height, seed, audio, duration, start}`；在时间容器内为局部值。也可以直接使用 `render(ctx)` 的 `ctx` |
| `<LocalTime start duration>` | 时间平移：子元素在 `start` 帧看到 frame=0；`start` 之前和 `duration` 之后不输出 |
| `<Steps>` + `<Step duration offset>` | 顺序编排：每个 Step 在上一个结束时开始；`offset` 为负表示重叠；只有最后一个 Step 可以省略 duration |
| `<Stage background>` | 全画面图层：位于 0,0、尺寸等于组件（或父组）的 group，可选背景矩形 `stage/background` |
| `remap(value, [输入…], [输出…], {easing, clamp})` | 分段数值映射；默认两端钳制，`clamp: false` 线性外推，`'start'`/`'end'` 单侧钳制；`easing` 可用 `easings` 名称、函数或每段一个 |
| `springTo(clock, {from, to, start, mass, stiffness, damping, velocity})` | 闭式阻尼弹簧（复用 `spring()`），可随机跳帧 |
| `springSettle(fps, options)` | 弹簧收敛到阈值所需帧数，便于给 Step 定时长 |
| `beatClock(clock, bpm, {offset, beatsPerBar, decay})` | 恒定 BPM 节拍：`beat`、`index`、`phase`、`bar`、`beatInBar`、`framesPerBeat`、`pulse`、`frameOfBeat(i)`；变速曲线请用声音模块的 `tempoClock()` |
| `mixColor(a, b, t)`、`cycle(list, i)`、`toFrames(s, clock)` | 颜色插值、按节拍循环取样式、秒转帧 |

已有的 `progress`、`tween`、`stagger`、`easings`、`cubicEasing`、`random(seed)` 照常可用。

128 BPM、30 fps 时每拍 14.0625 帧，32 拍正好 450 帧（15 秒）。时间容器接受小数帧，所以按拍切分不会累积误差：

```tsx
const beats = (n: number, fps: number) => (n * fps * 60) / 128;
<Steps>
  <Step key="intro" duration={beats(8, ctx.fps)}><Intro /></Step>
  <Step key="drop"><Drop /></Step>
</Steps>
```

## 样式子集

`style` 接受常用 CSS 写法并映射到节点属性；元素上直接写的属性优先于 `style`。

| CSS | 节点属性 |
|---|---|
| `position: 'absolute'`、`left`/`top`/`right`/`bottom`、`width`/`height`（px 数字、`'12px'`、相对父框的 `'50%'`） | x / y / width / height |
| `transform`（translate/scale/rotate/skew/matrix）、`transformOrigin` | 规范顺序 translate→rotate→scale 映射为可编辑的 x/y/rotation/scale（默认绕中心）；其他顺序精确合成到 `matrix` |
| `opacity`、`visibility`、`display: 'none'`、`zIndex` | opacity / visible / 排序 |
| `background`/`backgroundColor`/`color`/`fill`（颜色或 `linear-gradient()`/`radial-gradient()`） | fill / gradient |
| `border`、`borderWidth`、`borderColor`、`stroke`、`strokeWidth`、`borderRadius` | stroke / strokeWidth / strokeDash / radius |
| `boxShadow`、`textShadow`、`filter: blur() brightness() saturate() opacity() drop-shadow()` | shadow / blur / brightness / saturation |
| `mixBlendMode` | blend（normal、multiply、screen、overlay、darken、lighten、difference、plus-lighter） |
| `fontSize`、`fontFamily`、`fontWeight`、`textAlign`、`lineHeight`、`letterSpacing`、`textTransform` | 对应文字属性（`lineHeight: '48px'` 换算为倍数） |
| `whiteSpace`（normal、pre、pre-wrap；nowrap→pre，break-spaces→pre-wrap），也可直接写 `<text whiteSpace="pre">` | 文字节点 `whiteSpace`：`pre` 保留所有空格且只在 `\n` 换行（代码块），`pre-wrap` 保留空格并自动换行，`normal`（默认）与旧版一致：行首普通空格被去掉，NBSP 保留 |
| `overflow`/`overflowX`/`overflowY`（visible、hidden、clip）、`objectFit`（fill、contain、cover） | 裁剪框 / 图片·视频·组件适配 |
| 布局键（`display: 'flex' \| 'grid'`、gap、margin、padding 等，见下节） | taffy 布局，结果写成普通 x/y/width/height |

不支持的内容不会被静默忽略，而是给出带替代方案的诊断：

| 写法 | 诊断 | 替代 |
|---|---|---|
| `<div>`、`<span>`、`<img>`、`<svg>` 等 HTML/SVG 标签 | `JSX_HTML_ELEMENT` | `<group>`/`<rect>`/`<text>`/`<image>`/`<path>` |
| `<audio>` | `JSX_AUDIO` | 序列音频轨，或组件节点的 `audioAssetId` 驱动 `ctx.audio` |
| `onClick` 等事件、`className`、`ref` | `JSX_EVENT_HANDLER` / `JSX_CLASSNAME` / `JSX_REF` | 用帧和参数驱动；用稳定 ID 引用图层 |
| `useState`/`useEffect` 等 React hook、`import 'react'` | `JSX_REACT_HOOK` / `JSX_REACT_IMPORT` | `useClock()`、参数、模块级预计算 |
| `async`/`await`、返回 Promise | `JSX_ASYNC` | 同步渲染；数据放在工程文件或参数中 |
| `window`、`document`、`fetch`、`setTimeout`、`requestAnimationFrame` | `JSX_BROWSER_API` | 时钟与工程文件 |
| `Math.random()`、`Date.now()`、`new Date()` | `JSX_NONDETERMINISTIC` | `random(seed)`、`useClock().seconds` |
| `order`、`gridArea`/`gridTemplateAreas`、命名网格线、`inset`、`float` | `JSX_STYLE_UNSUPPORTED` | `row-reverse`、行列线编号/`span`、`left/top/right/bottom` |
| `calc()` 等表达式长度 | `JSX_STYLE_VALUE` | 在代码中算出数值（px 数字、`'12px'`、`'50%'`、`'auto'`） |
| 布局键用在无布局意义处、非 group 上 `display: 'flex'` | `JSX_LAYOUT_CONTEXT` | 见“Flex / Grid 布局” |
| `transition`/`animation` | `JSX_STYLE_UNSUPPORTED` | `remap()`/`springTo()` |

空格说明：JSX 编译本身会去掉跨行文本两端的空白并把换行合并为一个空格，所以代码缩进请写成字符串表达式，例如 `<text whiteSpace="pre">{'  if (x) {\n    run()\n  }'}</text>`。默认 `normal` 为兼容旧工程（同样的源码渲染不变），不会自动对 JSX 文字改成 pre；`whiteSpace` 只作用于 `<text>`，不从父组继承。
| `rotateX`/`rotateY`/`perspective` | `JSX_STYLE_UNSUPPORTED` | `project3D()`/矩阵 3D，或下面的伪 3D 写法 |
| 未知属性（如 `rotate`、`color` 写在 rect 上） | `JSX_PROP`（带“did you mean”） | 对应节点属性 |
| 文字直接放在 `<group>` 里、给 `<rect>` 加子元素 | `JSX_TEXT_CHILD` / `JSX_CHILDREN` | 用 `<text>` 包裹；用 `<group>` 组合 |

静态检查在预检的 TypeScript 阶段对 `.tsx` 运行，给出文件、行、列；运行时检查覆盖动态写法（例如运行时拼出的标签名），在采样帧失败并返回同样的错误码。

伪 3D：`scaleX` 取 `cos(角度)`、加一点 `skewY`、按深度设置 `zIndex` 与透明度，例子见 `examples/jsx-lab` 的卡片阵列：

```tsx
style={{ left, top, transform: `scale(${Math.abs(Math.cos(t)) * s}, ${s}) skewY(${-Math.sin(t) * 14}deg)` }}
```

## Flex / Grid 布局

在 `<group>`（或 `<Stage>`）的 `style` 上写 `display: 'flex'` 或 `'grid'`，该子树每一帧由 taffy（编译为 wasm 并内嵌，无需原生工具链）排版，结果写回为普通的 `x/y/width/height`，所以排版后的图层与手写坐标的图层一样可选中、可覆盖、可渲染。

- 容器键（必须与 `display` 写在同一个 group 上）：`flexDirection`、`flexWrap`、`flexFlow`、`justifyContent`、`alignItems`、`alignContent`、`justifyItems`、`placeItems`、`placeContent`、`gap`、`rowGap`、`columnGap`、`gridTemplateColumns`、`gridTemplateRows`、`gridAutoColumns`、`gridAutoRows`、`gridAutoFlow`。
- 子项键（只能写在布局容器的子元素上）：`flex`、`flexGrow`、`flexShrink`、`flexBasis`、`alignSelf`、`justifySelf`、`placeSelf`、`gridColumn`、`gridRow`、`gridColumnStart/End`、`gridRowStart/End`、`margin*`（含 `auto`）。
- 盒模型键（布局内）：`padding*`、`minWidth`、`minHeight`、`maxWidth`、`maxHeight`、`aspectRatio`。
- 网格轨道：`repeat(3, 1fr)`、`'200px 1fr auto'`、`minmax(80px, auto)`、`repeat(auto-fill, …)`/`auto-fit`、数组 `[120, '1fr']` 或列数；按行列线编号、`span N` 或 `auto` 放置。
- 布局容器内的 `position: 'absolute'` 子元素相对容器用 `left/top/right/bottom` 和百分比尺寸定位（适合给 flex 内容垫背景矩形）。
- 未写尺寸的文字用真实渲染字体测量（中文、字形库均可）。布局根节点自身用 `left/top/width/height` 定位。
- 任何值都可以是帧的函数：列数、间距、宽度都能动画，每帧重新排版。

```tsx
<group id="chips" style={{ display: 'flex', gap: 18, justifyContent: 'center', left: 0, top: 420, width: 1280 }}>
  {labels.map((label, i) => (
    <group key={`chip${i}`} style={{ display: 'flex', alignItems: 'center', padding: '10px 22px' }}>
      <rect id="bg" style={{ position: 'absolute', left: 0, top: 0, width: '100%', height: '100%', borderRadius: 22 }} fill="#141b2e" />
      <text id="label" fontSize={26} fill="#e8eeff">{label}</text>
    </group>
  ))}
</group>
```

完整的按拍重排网格与 flex 文字示例见 `examples/jsx-lab/components/lab/layout.tsx`。

已知不支持：`order`（改用 `row-reverse`/调整子元素顺序）、命名网格区域与命名线（`gridArea`、`gridTemplateAreas`，改用行列线编号或 `span`）、`calc()`（报 `JSX_STYLE_VALUE`，在代码里算出数值）、`inset`/`float`（改用 `left/top/right/bottom`）。布局键写在没有布局意义的位置（容器键所在 group 没有 `display: flex/grid`、子项键不在布局容器内、非 group 上写 `display: 'flex'`）会报 `JSX_LAYOUT_CONTEXT`。

## 可视编辑与写回源码

JSX 生成的图层与 `.ts` 组件的生成图层相同：在界面中选中并拖动、改色等操作写入组件图层的稳定 ID `overrides`/`structure`，源码保持不变，撤销与变更高亮照常工作。因此请给可能被手动调整的元素写 `id`。

可选的写回：`planJsxWriteBack(snapshot, sceneId, componentNodeId)`（`src/core/jsx-writeback.ts`）把字面量覆盖写回 `.tsx`——属性原本是字面量（`x={120}`、`fill="#fff"`）或缺省时改写/插入；属性是表达式（`x={remap(...)}`）时保留为 override 并在报告中标为 `computed`。它返回普通的 files + operations 候选，经 `project_preflight`/`project_apply` 提交，画面像素不变、一次撤销。入口：检查器的“写回源码”区、MCP `jsx_writeback_plan`、CLI `vmotion jsx-writeback --project . --scene <场景> --node <组件图层> [--apply]`。

检查器里的“写回源码”区：选中组件图层本身、进入组件后的任意子图层，或在根画布上直接选中组件生成的子图层（深选）时都会出现；选中子图层时标题为“写回源码 · <组件名>”，列表只含该子图层及其后代的覆盖（子图层自己没有覆盖时列出整个组件）。点击后先重新生成写回计划，再直接 `project_apply`——apply 本身会执行与 preflight 相同的类型检查、组件校验、确定性和视觉采样，不再额外跑一次 `project_preflight`；按钮显示当前阶段（“检查覆盖…”/“写入并验证…”）和已用秒数，完成后保留“已写入 N 项到 <文件>”。同一进程内类型检查结果按工程根目录、SDK 声明和源码全文共享（仍逐文件核对），预检后的 apply 不再重复构建 TypeScript 程序。

写回范围：只改写组件图层引用的主 `.tsx` 文件中带字面量 `id` 的元素；从其他文件导入的子组件里的元素报告为 `no-target` 并保留为 override。表达式属性不做写回（保留 override，标为 `computed`），由 flex/grid 排版决定的几何保留 override，标为 `layout`。

## 如果你熟悉 React 视频库

| 通用概念 | Vmotion |
|---|---|
| 读取当前帧的 hook | `useClock().frame`（或 `render(ctx)` 的 `ctx.frame`） |
| 视频配置（fps/尺寸） | `useClock()` 的 `fps`、`width`、`height` |
| 带钳制的数值插值 | `remap(value, input, output, { clamp, easing })`（默认钳制） |
| 物理弹簧 | `springTo(clock, { from, to, stiffness, damping, mass })` |
| 铺满画面的容器 | `<Stage background>` |
| 延迟/截取一段时间的容器 | `<LocalTime start duration>` |
| 依次播放的序列 | `<Steps>` + `<Step duration offset>` |
| 图片 / 视频元素 | `<image src>` / `<video src trimStart playbackRate>` |
| 音频元素 | 序列音频轨（组件内不能发声） |
| div + CSS 布局 | `<group style={{ display: 'flex' \| 'grid', … }}>`（taffy），或 `<group>` + 绝对坐标 |
| 组合（Composition）注册 | `defineComponent({ name, parameters, render })` + 场景 JSON 中的 component 节点 |
| 随机数 | `random(seed)`（不要用 `Math.random()`） |

## 后续计划

- 更多 CSS 布局映射：`order`、命名网格区域/线、`calc()`。
- 写回扩展：导入的子组件文件、表达式属性的参数化写回。
- 编辑器对 `.tsx` 的语法高亮与 JSX 自动补全。
