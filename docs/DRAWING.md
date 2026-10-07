# 独立绘画与素材工作流

绘画工作区使用独立文档。画笔只修改当前绘画图层，不直接给动画场景或素材库增加图层。文档保存在 `drawings/*.json`，由工程清单的 `drawings` 引用；笔迹、笔压、橡皮、图层位置、透明度、混合模式和顺序都可编辑。撤销/重做与工程共享，重启后恢复。

点击「绘画」进入文档工作区。新建画稿后使用左侧「+」创建图层；B 切换画笔，E 切换橡皮，V 移动已选图层。Ctrl 单击多选图层，移动保持图层之间的位置。橡皮只擦除当前图层。Alt 或中键平移画布，Esc 取消正在进行的笔迹或位移。

完成后有两种发布方式：

- 「发布整张画稿」创建包含全部图层的一个素材。
- 「发布选定图层」创建包含所选图层的一个素材；要分别制作动画，可以逐层发布。

发布创建独立素材快照，继续修改源画稿不会改变已经放入视频的素材。发布不会自动添加场景或轨道。返回工作站后在素材库单击选择，拖入画布/场景时间轴添加绘画图层，拖入工程总览的视频轨道添加片段。也可使用「加入当前合成」和「加入主时间轴」按钮。素材库显示原生绘制的缩略图，细小笔迹会适当放大显示。

旧版本每笔绘画生成的素材继续显示和使用。选中旧素材后点击「打开画稿编辑」创建独立文档；发布的新素材保留完整图层与笔迹。当前支持基础画笔与橡皮、压感、图层混合和透明度；尚未实现 Photoshop 的全部笔刷、滤镜与选区功能。

外部 agent 可以通过 JSON、CLI 和 MCP 执行相同流程，软件不接入模型。

```powershell
node dist/cli/index.mjs drawing create --project ./my-project --name "角色画稿" --width 1920 --height 1080
node dist/cli/index.mjs drawing inspect --project ./my-project --id <document-id>
node dist/cli/index.mjs drawing edit --project ./my-project --id <document-id> --operations-file ./strokes.json
node dist/cli/index.mjs drawing frame --project ./my-project --id <document-id> --width 960 --output ./drawing.png
node dist/cli/index.mjs drawing publish --project ./my-project --id <document-id>
node dist/cli/index.mjs asset-place --project ./my-project --asset <asset-id> --sequence main --frame 0 --duration 150
```

`strokes.json` 示例：

```json
[
  {
    "type": "stroke",
    "layerId": "<layer-id>",
    "stroke": {
      "id": "outline-01",
      "tool": "brush",
      "color": "#79b6ff",
      "width": 12,
      "opacity": 1,
      "points": [
        { "x": 80, "y": 120, "pressure": 0.4 },
        { "x": 180, "y": 160, "pressure": 1 }
      ]
    }
  }
]
```

MCP 提供 `drawing_list`、`drawing_get`、`drawing_create`、`drawing_edit`、`drawing_frame`、`drawing_publish`、`drawing_open_asset`、`asset_place`、`asset_thumbnail`。`drawing_frame` 与 `asset_thumbnail` 返回可见图片。写操作接受工程 revision，使用原子保存，失败不会部分应用。Schema 位于 `schemas/drawing.schema.json` 和 `schemas/drawingOperation.schema.json`；SDK 导出绘画文档类型。

对动画图层结构的操作使用 `composition_structure` / `composition_structure_batch`，支持新增、复制、删除、编组、解组和排序。代码生成内容的结构变化写入所属组件的 `structure`；属性变化写入 `overrides`，不重写 TypeScript 源码。

## Agent 分页取证

绘画7个原工具与drawing_query统一进入vmotion.drawing模块，继续共享事务/发布/撤销。drawing_query默认24层/16笔迹，只返回外观、状态和pointCount；layerIds/strokeIds稳定选择，两个列表各自分页。includePoints=true显式读取pointOffset/pointLimit页，原压感/图层本地坐标不变。drawing_get仍完整读取，drawing_frame提供真实画面；assets_query可定位发布素材，再asset_place入合成或轨道。

默认省略点数组是上下文优化，解析画稿仍处理全文件，暂无笔迹索引缓存或百万点实时认证；错误ID/过期revision拒绝后项目保持原版本。
