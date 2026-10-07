# 视觉内容时间

video、component 和 scene 引用图层支持 `timeMapping`：

```json
{"mode":"linear","anchor":0,"offset":0,"rate":1,"frame":0,"repeat":"continue"}
```

线性映射为 `(父帧-anchor)*rate+offset`。0 倍冻结，负速率倒放。remap 模式使用 `timeMapping.frame`，可加普通关键帧与贝塞尔缓动；anchor、offset、rate 也可动画。来源边界支持 continue、clamp、loop、pingpong、blank。场景/导入视频长度自动读取，代码组件的有界模式需指定 duration。视频的 continue 在已知物理末帧保持画面。

图层变换、效果、组件参数按父时间求值；生成/引用的内容按源时间求值。预览、导出和交互图使用同一映射。`composition_interactions` 返回 frame、contentFrame、contextFrames，分别表示当前层求值时间、内部内容时间和祖先时钟。

进入独立编辑页后，frame 是当前内容时间。contextFrames 固定进入点的祖先时钟，保持外层参数与结构状态；路由保存该数组。MCP 普通 composition/animation/parameter 工具接受 contextFrames。内部拖动和属性关键帧放在源帧，分数帧的键放到最近整数；连续求值仍保持分数时间。

MCP time_inspect 返回映射、通道与采样帧；time_edit 提供 freeze/reverse/normal 预设、settings、remap keys 和 reset。CLI time-inspect/time-edit 使用 JSON request。SDK mapContentTime/contentTiming 共用求值。此功能控制视觉内容，音频仍按主时间轴混音，不自动跟随场景内视频重映射。

examples/time-lab 展示正常/双速/倒放/冻结/往返和停顿再倒放，已生成 8 秒 1080p 示例。测试包含真实视频颜色帧倒序、内容冻结同时父层移动、祖先上下文、源帧拖动与 PNG 预览/导出一致性。
