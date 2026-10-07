# 外部 agent 动画与特效创作

用户目标是使用自有格式对标 After Effects 的创作能力。当前软件不调用 AI 模型，agent 通过源码、CLI 与 MCP 制作、检查和修正效果。

## 时间与表达式

`ctx.frame` 与 `ctx.seconds` 是唯一的动画时钟。`progress`、`tween`、`stagger`、`enter`、`wipe` 和 `localClock` 的时间参数是帧；物理粒子的 `start`、`lifetime` 是秒，速度是像素/秒。`spring` 根据质量、刚度、阻尼与初速度解析求值，跳转和倒序访问不依赖上一帧状态。

可用线性、三次缓动、回弹和物理弹簧，并可组合任意 TypeScript 数学表达式。使用 `localClock(ctx, startFrame)` 组织片段，使用 `stagger` 错开多个元素；从空间关系生成运动，而不只给所有元素叠加相同的淡入。

## 图层与特效

- `group(id, nodes, props)` 生成带稳定命名空间的图层组，保留内部父子关系与遮罩引用。
- 组透明度、混合与效果对整组结果应用，子元素重叠处不会反复叠加组透明度。
- `gradient` 支持线性和径向填充，坐标相对于当前图层；公式仍用 `fill` 着色，可对公式整层使用效果栈。
- `effects` 按声明顺序执行：`blur`、`glow`、`color`（亮度/对比度/饱和度/色相）、`shadow`。
- 发光默认以 RGB 最大通道亮度 0.55 为阈值提取亮部，`glow(color, radius, intensity, threshold)` 可修改阈值，避免暗色填充被整体染亮。
- 将发光加在粒子组上，避免为每个粒子创建独立的大画面滤镜。
- `textMotion` 按字素或词，使用原生字体测量的位置逐个入场。它与图层动画、渐变和效果栈可以组合。
- `followPath` 按折线弧长推进，可先采样贝塞尔轨迹；`morphPoints` 在相同数量的对应点之间插值。
- `trail` 在历史时刻重新调用纯函数来绘制残影；`particles` 用种子、出生时间与解析运动生成粒子。
- `project3D` 提供相机视角和近裁剪的 2.5D 投影，适合空间图形与视差；目前不提供三维网格、PBR 材质或灯光渲染。

临时效果表面限制为每帧 256MB。复杂叠层需要缩小预览分辨率或减少嵌套；此限制不代表正式 GPU 性能目标已完成。

`project.motionBlur = {samples: 4, shutterAngle: 180}` 可以开启整幅画面的时间采样运动模糊。2–16 个采样在线性光空间、预乘透明度下积分，CPU 工作量随采样数增加；不会自动生成视频素材的光流中间帧。

## 检查与迭代

矢量形状现可组合原生布尔几何与 `pathTrim`、`strokeDashOffset` 关键帧。SDK 帮助函数、CLI/MCP 查询和编辑器路径快照共用算法；使用说明与能力边界见 [矢量动画](VECTOR-ANIMATION.md)。

共享 JSON 场景可通过 `sceneRef` 复用并设置独立内部覆盖。源尺寸、相机、实例缩放与编辑路径在渲染、选取和画面检查中一致；预合成与依赖工具见 [共享场景](SHARED-SCENES.md)。

1. 用 `project_validate` 检查类型和资源引用。
2. 用 `frame_sample` 同时采样入场、中间、转场与离场，阅读接触表和帧信息。
3. 检查层级、遮挡、运动节奏、字幕区和视觉焦点，再修改 TypeScript 或图层参数。
4. 导出短预览确认动态效果，再渲染完整影片。

CLI：`vmotion guide` 读取接口说明；`vmotion sample --project . --frames 0,15,30,60,90 --output review.png` 生成多帧检查图。MCP 资源 `vmotion://animation-guide` 提供同一份接口说明。

## 能力边界

完整 AE 对标仍是一条持续实施的路线。遮罩路径工具、跟踪、抠像、位移/噪声、逐层快门控制、完整三维相机与灯光、音频驱动、时间重映射、表达式控制器和插件 ABI，按能力矩阵继续推进。当前不加载 AE 工程与插件。
