# 矢量路径与描边

编辑器、原生预览、导出和图层边界使用相同路径求值。SDK 运行在独立 Node 脚本进程，无需 DOM/CSS，也不接入 AI 模型。

## 可动画的图层字段

矩形、椭圆和 SVG path 支持 `pathTrim: {start: 0, end: 1, offset: 0}`。起点、终点为 0–1；偏移单位为圈，允许正负值。起点大于终点时沿路径跨越首尾，相等时为空，0→1 为完整路径。多轮廓按连接的总弧长分配，轮廓之间不增加连接线。旧 `path.reveal` 先执行，再在剩余路径上执行 `pathTrim`。裁切影响路径填充和描边，保留填充时开放轮廓仍会隐式闭合；线条书写通常使用 `fill: 'transparent'`。

描边字段：`strokeDash`（最多 32 个非负间隔，奇数项按 Canvas 规则重复，空数组为实线）、`strokeDashOffset`（像素）、`strokeCap`（butt/round/square）、`strokeJoin`（miter/round/bevel）、`strokeMiterLimit`（尖角与线宽比值）、`strokeWidth`。`fillRule` 支持 nonzero/evenodd。

可建立关键帧：`pathTrim.start/end/offset`、`strokeWidth`、`strokeDashOffset`、`strokeDash.N`、`strokeMiterLimit` 和矩形 `radius`。创建数组通道前需建立对应间隔。编辑器改变虚线数组会移除其间隔通道，保留偏移通道；裁切控件修改已有通道时更新当前帧。绘画文档的笔刷仍使用自己的描边模型。

## SDK 与原生几何

```ts
import {path, booleanPath, outlinePath, trimPath, roundPath} from '@vmotion/sdk';
const result = booleanPath([aSvg, bSvg], 'difference');
const rounded = roundPath(result, 12);
const outline = outlinePath('M0 0L200 0', {width: 8, cap: 'round'});
const wrapped = trimPath('M0 0H200', {start: .75, end: .25});
return [path('result', rounded, {fill:'#72e6d4'}),
  path('flow', curve, {fill:'transparent',stroke:'#fff',strokeWidth:6,
    strokeDash:[18,8],strokeDashOffset:-ctx.seconds*60,
    pathTrim:{start:0,end:Math.min(1,ctx.frame/90),offset:0}})];
```

`booleanPath` 支持 union/difference/intersect/xor/reverseDifference，按输入顺序左折叠。`simplifyPath` 消除自交，`roundPath` 生成圆角，`outlinePath` 将实线转为填充轮廓。所有帮助函数返回新 SVG，底层可变 Path2D 不泄漏给组件。参数须为有限数值；非法 SVG、错误操作数数量返回明确错误。

`pathGeometry` / MCP `path_geometry` / CLI `vmotion path --request request.json` 共用原生算法，返回 SVG、nonzero 填充规则、局部边界、空路径标记。JSON 每个操作数支持自己的 fillRule 和六项仿射 transform；transform 先于后续几何操作。输入最多 32 个路径，每路径最多一百万字符。此查询不写项目、不进入历史记录，也不需要桌面窗口。

```json
{
  "operation": "difference",
  "paths": [
    {"path":"M0 0H100V100H0Z"},
    {"path":"M25 25H75V75H25Z"}
  ]
}
```

## 从图层生成静态路径快照

属性面板“描边与路径”提供裁切、虚线、端点/拐角及快照操作。多选同父级矢量图层可合并/相减/交集/排除；单选可简化、圆角或实线转轮廓。第一项为选择顺序中的第一层，相减顺序明确。结果为新的稳定 ID 图层，可继续变换、加关键帧和效果；界面保留并隐藏源图层，一次撤销恢复全部操作。

MCP `vector_bake` / CLI `vector-bake --project DIR --request request.json`：

```json
{
  "sceneId":"intro", "path":["vectors"], "frame":90,
  "nodeIds":["vectors/a","vectors/b"], "operation":"difference",
  "hideSources":true, "id":"difference-result", "revision":"CURRENT_HASH"
}
```

`hideSources` 默认 false。支持代码组件内部结构与覆盖，不改组件源码。烘焙当前帧的局部变换、裁切和几何，使用第一项的纯色填充/透明度；渐变、遮罩、效果和来源动画留在原图层，不成为像素快照。描边转轮廓先于源图层变换，可保留非均匀缩放；虚线转轮廓尚未支持，会返回 VECTOR_DASH_OUTLINE，不静默变成实线。

## 验证与边界

`examples/vector-lab` 展示动态布尔运算、路径书写、多段虚线、圆角和环绕裁切。`scripts/create-vector-lab.ts --render` 可重建工程、五张采样图、原生检查接触表与 8 秒 1080p/30fps 视频。

图层边界包含裁切几何和实际端点/尖角轮廓；虚线边界取完整中心线描边的保守包围盒，空白间隔仍可能被选取。此版本没有逐轮廓独立裁切模式、鼠标贝塞尔点编辑、路径文字或实时重复器。几何操作不能替代这些能力。
