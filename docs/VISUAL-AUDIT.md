# 跨帧画面检查

Vmotion 提供共享的画面检查器，供界面、CLI、MCP 和代码预检使用。检查读取原生文字排版、当前时间的动画、父级变换和裁剪，输出稳定对象 ID、组件路径、帧号、比例/运动指标以及带编号的实际渲染图。

界面在动画工作区点击「检查画面」。默认检查开头、当前帧前后、中间与末帧。结果弹窗区分确定问题和需要目视确认的提示；点击某项会关闭结果并定位到那一帧、选中对应原始或生成文字图层。工程更新后旧结果标明版本过期，需要重新检查。检查不修改工程文件或撤销历史。

| code | 判定 | 含义 |
| --- | --- | --- |
| TEXT_TRUNCATED | 确定问题 | 原生排版得到的部分文字行因图层高度不足未绘制 |
| FRAME_ERROR | 确定问题 | 指定帧的组件运行/场景求值失败 |
| TEXT_OUTSIDE_CANVAS | 目视提示 | 可见文字几何范围部分超出画布 |
| TEXT_CLIPPED | 目视提示 | 文字几何范围被图层或父级裁剪 |
| TEXT_OVERLAP | 目视提示 | 两个文字图层的字形包围几何重叠 |
| TEXT_COVERED | 目视提示 | 后绘制的、没有效果/遮罩的实色不透明矩形覆盖文字范围 |
| FAST_MOTION | 目视提示 | 两个采样时间点之间的节点位移速度超过阈值 |
| MOTION_JUMP | 目视提示 | 相邻检查帧的位移超过画布对角线的一定比例 |

越界与裁剪通过旋转/缩放后的多边形求交计算，镜像变换同样可用。文字采用实际文字行或文字动画单元的包围区域，减少大尺寸文字框造成的误报。父组/组件透明度会参与检查，忽略不可见或过于透明的图层。遮罩、特效与混合会标记不确定性；粒子、背景、路径和笔迹不进行普通节点的运动节奏提示。

这些规则是可解释的检查工具，不是图像理解模型。故意重叠的标题、字幕裁剪入场、跳切、图层遮挡可能是正确设计，需要查看图后判断。检查没有触发规则，只证明这些时间点未触发当前规则，不证明整个视频没有视觉问题。

主要限制：

- 只检查请求的时间点。检查突跳时应包含相邻帧，如 59、60；稀疏采样无法证明中间连续。
- 重叠/遮挡使用字形包围几何，不是文字笔画像素交集；跨行或旋转仍可能产生提示。
- 遮罩、模糊、混合、透明图片/视频的最终像素可见性不做自动证明。
- 任意图层组与可编程组件会展开；嵌套 scene 引用的内部内容暂不展开，公式也尚无专用排版检查。
- 运动以节点原点的跨帧位移估计，暂不判断旋转速度、缩放突变或粒子运动。
- 单次最多 60 个时间点，返回最多 1000 项，图像证据最多 12 帧。几何比较使用有界预算，遗漏时 summary.incomplete=true，不能视为检查通过。

MCP `visual_audit` 示例：

```json
{
  "sceneId": "intro",
  "path": [],
  "revision": "<project-revision>",
  "frames": [0, 59, 60, 90, 119],
  "width": 480,
  "maxImages": 8,
  "options": {
    "nodeIds": ["layout/truncated", "layout/overlap-a"],
    "ignoreNodeIds": [],
    "overflowRatio": 0.05,
    "overlapRatio": 0.08,
    "occlusionRatio": 0.2,
    "minOpacity": 0.1,
    "maxScreensPerSecond": 2,
    "maxStepFraction": 0.15,
    "maxFindings": 200
  }
}
```

nodeIds 限定被检查的对象，文字仍会与其他未忽略图层比较；ignoreNodeIds 完全忽略指定对象。options 可省略以使用默认阈值。images=false 只返回结构化结果。报告中的 path 是对象所在组件范围，可直接配合 composition_edit_layer 或 component_parameters_edit 修复；报告编号与证据图编号一致。

代码候选预检支持 visual=true 和 visualOptions，复用 samples 指定的 sceneId/path/time。确定的内容丢失与运行错误使预检失败；几何提示进入 warning，不自动拒绝有意构图。需要视觉检查时，samples 必须提供 sceneId；主序列画面仍可正常渲染，但目前不做跨镜头的场景几何合并。

```powershell
node dist/cli/index.mjs audit --project examples/visual-audit-lab --scene intro --frames 0,59,60,119 --output ./layout-report.png
node dist/cli/index.mjs audit --project ./my-project --scene title --no-images --options-file ./audit-options.json
```

确定问题/运行错误使 CLI 返回 2；目视提示或预算不完整只在报告中标明。原生帧渲染也失败时 diagnostics 显示具体错误。预检使用独立渲染实例，保留桌面最后有效预览。

`examples/visual-audit-lab` 展示五种问题与参数修复。fixed=false 可复现文字截断、越界、重叠、遮挡和突跳；fixed=true 在相同四个采样帧不再触发规则。示例源码仍是可编辑的 TypeScript。
