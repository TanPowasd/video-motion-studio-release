# 共享场景、预合成与实例编辑

场景保存为独立 JSON，可以通过 `type:'scene'` 图层复用。每个实例有自己的位置、大小、效果、内部属性覆盖和结构编辑；源场景更新同步到所有实例，实例显式覆盖优先。JSON、SDK、编辑器、CLI 和 MCP 使用相同模型，软件本身不调用 AI。

## 编辑器

选中同父级相邻图层，点击“生成共享场景”，将它们和后代保存为透明背景的新场景，再在原顺序位置放入引用。原生层级、遮罩、关键帧与外部父级变换保留。创建源文件、替换图层、更新清单进入同一次原子事务，撤销可恢复原图层和源文件状态。

工具栏“引用场景…”可插入已有场景。引用图层支持缩放、旋转、透明度、效果和遮罩。双击、右侧箭头或“进入独立合成”可进入该实例，内部时间轴只显示当前内容，采用源场景坐标、尺寸和相机。直接拖动或属性修改写入实例覆盖；结构复制/编组/删除/排序写入实例结构，不改源 JSON。

“共享场景引用”属性区显示源尺寸、时长和直接引用数量。点击“打开共享源场景”可编辑共同来源；源内容变化后，未覆盖字段同步。“重置当前实例内部覆盖”移除当前拥有的内部属性和结构编辑，保留外部位置与来源，也可撤销。嵌套引用重置的是本层存储的编辑；来源本身已有的默认覆盖仍保留。

原生图层预合成可保留整段动画。对代码生成的叶图层进行预合成时，基准内容来自当前帧，返回 `captureMode:'generated-graph'`；原生关键帧与嵌套的代码/场景引用继续工作，但任意外层代码的逐帧生成逻辑不会自动搬迁到 JSON。源码保留，移除的生成 ID 记录在结构里，可撤销。

## 帧、尺寸与画面

源场景可设置 `width/height`，省略时使用工程尺寸。引用的 width/height 决定从源坐标到父级的缩放；源相机、引用变换、父级变换、透明度和剪裁在预览、选取与导出中一致。进入引用时使用源尺寸，避免把缩小实例的位置误当作原始坐标。

引用默认共享所属场景帧号，现在可以通过 timeMapping 设置变速、冻结、循环和重映射；进入独立页使用内容时间并固定祖先进入点，详见 [内容时间](CONTENT-TIME.md)。源 duration 用于独立页时间轴范围。剪辑片段的 sourceIn/speed 仍对整个场景有效。场景内声音路由尚未实现。

引用不自动裁掉所有越界内容；需要明确使用 clip/遮罩限制边界。场景背景会绘制在源尺寸内。画面检查现可展开场景引用中的文字和图层，返回实例 ID 与可编辑 path；背景遮挡和公式专用布局尚未单独分析。

## SDK

```ts
import {sceneRef} from '@vmotion/sdk';
return [sceneRef('card','shared-card',{
  x:100,y:160,width:600,height:520,
  overrides:{'heading':{text:'当前实例标题'},'ring':{stroke:'#b7a5ff'}},
})];
```

副本内部 ID 为 `card/heading`、`card/ring`。可嵌套代码组件与其他场景引用；与组件相同，结构保存在 `structure`、属性与关键帧保存在 `overrides`。SDK 场景引用仍需要项目中的源场景；未提供大小时使用普通 node 默认大小，推荐明确填写需要的实例尺寸。

## 外部 agent

MCP `scene_precompose` / CLI `precompose --project DIR --request request.json`：

```json
{
  "sceneId":"intro","path":[],"frame":30,
  "nodeIds":["title","diagram"],"sourceId":"shared-card","id":"card",
  "name":"共享信息卡","revision":"CURRENT_HASH"
}
```

默认要求选中根图层在同父级中相邻，避免改变它们与未选图层的混合顺序。`allowReorder:true` 明确允许跨越未选层，此时放在最后一个选中层的位置，返回 reordered。外部遮罩需与依赖它的图层一起选择；不允许把仍用作外部遮罩的对象直接移走。

MCP `scene_place` / CLI `scene-place --request request.json` 使用 sourceId、sceneId、path、x/y、width/height。MCP `scene_references` / CLI `scene-refs --source ID` 返回源尺寸、时长及所有声明的入向/出向引用，包括原图层、结构新增、覆盖和序列片段；TypeScript 动态生成的引用需用采样图层图检查。

用 `composition_inspect` 打开引用实例，然后通过 `composition_edit_layer(s)`、`composition_structure(_batch)`、`animation_edit` 或 `component_parameters_edit` 修改内部对象。例子：

```json
{
  "sceneId":"intro","path":["card"],"frame":30,
  "nodeId":"card/heading","patch":{"text":"实例标题"},"revision":"CURRENT_HASH"
}
```

MCP `scene_reset_instance` / CLI `scene-reset --request request.json` 使用 sceneId、path、nodeId、frame、revision，清除本实例的内部编辑；原始源图层和文件不受影响。直接编辑 `scenes/shared-card.json` 或对 source sceneId 执行事务，才会修改共同来源。

声明的缺失与循环引用在保存前验证，包括结构新增和覆盖中的 sceneId；无效事务不写文件。依赖遍历缓存已访问节点，避免共享 DAG 随实例数量指数增长。动态代码引用仍由采样预检和运行时嵌套上限验证。

## 验证示例

`examples/shared-scene-lab` 使用一个 600×520 源场景生成三个实例，分别覆盖文字/颜色/效果与新增结构。`scripts/create-shared-scene-lab.ts --render` 生成五帧检查和 8 秒 1080p/30fps 视频。测试覆盖实例隔离、源更新、坐标与相机、嵌套结构、原子预合成与撤销、循环/缺失引用、可定位的文字诊断、PNG 预览/导出一致性。
