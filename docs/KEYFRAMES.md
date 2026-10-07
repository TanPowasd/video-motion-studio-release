# 关键帧、曲线与批量动画操作

动画工作区的时间轴和检查器使用同一关键帧命令系统。数字变换、效果参数、渐变、裁剪与结构化组件参数都可编辑；生成的子图层写入所属组件的覆盖数据，TypeScript 源码保持不变。

时间轴：

- 点击菱形定位时间并选择关键帧；Ctrl 单击添加/取消多选。
- 拖动任一已选菱形，所有已选键一起平移。松开后一次保存和撤销；拖动保存使用开始时的工程版本，外部编辑不会被静默覆盖。
- Ctrl+C/V 或底部「复制关键帧」「粘贴关键帧」复制到播放头，保持键之间的时间间隔与缓动。一个源图层的键可贴到当前图层的相同数字通道；多个源图层保持各自目标图层。
- Delete 删除已选关键帧，保留图层。Esc 取消当前拖动/选择。进入另一合成后清空内部关键帧剪贴板。
- 时间轴获得焦点后 Ctrl+A 选择当前图层全部关键帧。

动画检查器：

- Ctrl 选择多个关键帧，或用「全选」，批量平移、时间缩放、复制到播放头、设置缓动或删除。
- 时间倍数 2 将所选键相对第一帧的间隔拉长为两倍；时间倍数 0.5 缩短为一半。偏移以帧为单位。
- 精确输入帧号和数值。关键帧图表可直接拖动，保持相邻键的时间顺序，且显示弹簧/贝塞尔超调范围。
- 贝塞尔缓动提供两个控制点与 x1/y1/x2/y2 数值输入，x 在 0–1，y 支持超调。普通单击只选择，实际拖动才修改；Esc 取消未提交的控制点/曲线拖动。

碰撞默认返回诊断：平移/粘贴撞上现有键，或时间缩放四舍五入后两个键落到同一帧时，不会部分保存。agent 可显式指定 collision=replace 覆盖目标键；所选键彼此压成同一帧仍被拒绝。时间变换只支持正 timeScale；时间反转与速度图编辑尚未实现。

MCP `animation_inspect` 返回动画通道、总键数、分页键值，以及指定帧的属性值和每秒速度估计。速度由相邻采样值计算，保持跳变或关键帧处可能不光滑，不应当作解析导数。properties 可限制通道；offset/limit 控制键值分页，frames 最多 120 个。

MCP `animation_edit` 批量修改一个场景内多个原始/生成图层，整个请求是一次原子事务：

```json
{
  "sceneId": "intro",
  "frame": 30,
  "revision": "<project-revision>",
  "edits": [
    {
      "nodeId": "chart",
      "path": [],
      "actions": [
        {
          "type": "transform",
          "properties": ["params.data.1.value", "params.origin.x"],
          "range": [0, 180],
          "pivotFrame": 0,
          "timeScale": 1.5,
          "timeOffset": 12,
          "valueScale": 1,
          "valueOffset": 0,
          "copy": false,
          "collision": "error"
        }
      ]
    }
  ]
}
```

动作类型：

| type | 作用 |
| --- | --- |
| upsert | 指定 property 与 keys；默认替换同帧键，可 collision=error |
| remove | 删除 properties/frames/range 选中的键；最后一个键删除后移除通道 |
| ease | 为所选键设置 easing，可传 bezier 控制点 |
| transform | 按 pivotFrame/value、scale、offset 转换时间/数值；copy=true 保留原键 |

properties、frames、range 是交集筛选，省略则匹配全部。transform 公式为 `pivot + (original - pivot) * scale + offset`。时间最后四舍五入为整数帧；负帧、非有限值、超出参数声明范围、未知通道等错误使整个事务失败。创建组件参数关键帧时自动补齐默认数据。

```powershell
node dist/cli/index.mjs animation --project examples/parameter-lab --scene intro --node chart --frames 0,30,60,90
node dist/cli/index.mjs animate --project examples/parameter-lab --request-file ./keyframes.json
```

SDK 导出 `editKeyframes(node, actions)` 和 `sampleAnimation(node, frames, fps, properties?)`，方便 agent 在组件中复用相同算法。
