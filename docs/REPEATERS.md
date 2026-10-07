# 可编程重复器与二维仿射变换

重复器是普通 TypeScript 组件，保存基准图层图和可动画参数；所有副本都生成原生节点，沿用组件结构与属性覆盖、稳定 ID、撤销和工程文件同步。软件不调用模型，外部 agent 可通过文件、CLI 和 MCP 创建或修改。

## 编辑器工作流

1. 选择同父级图层，点击画布工具栏“创建重复器”。图层组会携带子图层、内部遮罩和动画；界面保留并隐藏来源，整个创建操作可一次撤销。
2. 属性面板选择 linear/grid/radial，设置数量、位移、旋转、缩放、斜切、中心、网格间距或放射角度。默认数量与间距尽量适应当前画布。
3. 数值参数可加关键帧。小数数量使最后一个副本逐渐出现；透明度首末值形成渐变；“反向叠放”改变顺序而保持对象 ID。
4. 进入组件/内部组，选取某个 `copies/copy-N` 或其子图层，修改属性保存在覆盖中。数量增加或反向叠放不会重新编号，修改仍对应原副本。
5. 打开生成的 `components/repeater-*.ts`，修改基准图层或自由扩展算法。模块注释记录来源对象、工程版本和创建帧。

生成模块保存创建时的基准图层图，不自动双向同步每个原图层或代码生成结构的后续变化。基准里的原生关键帧保留；基准中引用的组件源码和素材继续正常引用。结构随时间变化的源组件内容在创建帧捕获，要保留自由程序逻辑可直接编辑重复器模块。

## SDK

```ts
import {repeatGraph,repeatGrid,repeatRadial,rect,tween} from '@vmotion/sdk';
const source = [rect('tile',{width:32,height:80,fill:'#73e5d2'})];
return repeatGraph('copies',source,{
  count:tween(ctx,2,12,{duration:90}),
  position:{x:45,y:0},rotation:3,scale:{x:.97,y:.97},
  pivot:{x:16,y:40},skew:2,startOpacity:1,endOpacity:.4,
});
```

`repeatGrid`、`repeatRadial` 使用同一规则并固定模式。三种函数均支持函数形式的基准：`repeatGraph('copies', ({index,transformIndex,count,progress}) => Node[], options)`，可按副本设置内容、颜色、种子和动画延迟；时间直接取外层 `ctx`，例如 `tween(ctx,0,1,{start:index*4,duration:20})`。函数必须无状态地生成完整闭合图层图，不能依赖上次播放结果。

第 N 个副本固定使用 `copies/copy-N`，不受 `offset`、数量和绘制顺序变化影响。`offset` 改变变换序号。每步旋转按序号线性递增，缩放按序号取幂，累积斜切限制在 ±85°。网格使用 `columns` 与 `gap`；放射使用 `radius`、`angleStart/angleStep` 和 fixed/radial/tangent 朝向。矩阵按 `T(位移) × T(中心) × R × SkewX × Scale × T(-中心)` 构造，保留斜切，不经过近似 TRS 分解。

负每步缩放可使副本交替镜像，需要整数变换序号；负缩放与小数 offset 会明确报错。零缩放在负序号下无法求逆，同样报错。每个重复器最多 512 个副本、20000 个节点；创建模块的数量上限按实际基准节点数调整。非法父级/遮罩、过深图层图、超限 ID 或溢出变换不返回错误画面作为成功结果。

## agent 工具

MCP `repeat_describe` / CLI `repeat-describe --request request.json` / SDK `describeRepeater` 在不创建工程文件的情况下计算副本矩阵、透明度和估算边界：

```json
{
  "parameters":{"mode":"grid","count":12,"columns":4,"gap":{"x":60,"y":50}},
  "indices":[0,5,11],
  "sourceBounds":{"x":0,"y":0,"width":32,"height":40}
}
```

矩阵查询最多返回 128 个副本，省略 indices 时采样首、中、末。边界是传入基准矩形的变换并集；遮罩、裁剪、滤镜和真实像素需通过 frame_capture/visual_audit 检查。

MCP `repeat_create` / CLI `repeat-create --project DIR --request request.json` 从同父级图层创建完整可编辑组件：

```json
{
  "sceneId":"intro","path":[],"frame":30,"nodeIds":["shape"],
  "id":"flower","name":"放射花瓣",
  "parameters":{"mode":"radial","count":12,"radius":150,"angleStep":30,"orientation":"radial"},
  "hideSources":true,"revision":"CURRENT_HASH"
}
```

默认 `hideSources:false`。返回组件源码路径、基准对象、节点数量和参数。外部遮罩需要与被遮罩图层一起选入；跨父级/组件作用域的来源需先整理到共同合成。创建、模块写入、来源可见性均进入同一个原子历史步骤。

用 `component_parameters` 查询 Schema 和当前值，`component_parameters_edit` 或 `animation_edit` 修改参数动画。用 `composition_inspect/composition_interactions` 定位副本和所属编辑路径，然后通过 `composition_edit_layer/composition_edit_layers` 改属性或 `composition_structure` 改结构。无需新增专用副本编辑语义。

## 仿射矩阵

所有图层新增 `matrix:[a,b,c,d,e,f]`，默认为单位矩阵；映射 `(x,y)` 为 `(a*x+c*y+e,b*x+d*y+f)`。最终局部变换为普通位置/中心/旋转/缩放的 TRS 乘上此矩阵。原生渲染、选框、遮罩和路径快照复用同一 `nodeMatrix`。

SDK `affineMatrix` 生成矩阵；界面“高级变换 · 仿射矩阵”可以直接编辑六个系数并添加 `matrix.0`–`matrix.5` 关键帧。单个副本由仿射矩阵生成，常规位置/旋转等仍作为可编辑的附加变换。包含矩阵变换的组不能直接解组，以避免丢失画面；可先还原组变换或保留组结构。

## 例子与验证

`examples/repeater-lab` 展示线性递进、函数驱动网格、数量渐变的放射图案和仿射变换。`scripts/create-repeater-lab.ts --render` 可生成五张采样图、接触表及 8 秒 1080p/30fps 视频。测试覆盖遮罩命名空间、独立副本数据、顺序和数量稳定性、镜像/小数偏移约束、随机跳帧、CPU 渲染与选取矩阵、组件覆盖、原子撤销、失败回滚和 PNG 预览/导出一致性。

当前重复的是图层图；不是 AE 的原生形状算子栈，也不含沿任意 SVG 曲线分布、专业网格变形或 GPU 实例化。这些能力仍按整体路线继续实现。
