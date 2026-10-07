# 属性表达式、布局约束与曲线路径

这一批功能使用同一属性依赖系统：先由原生核心求关键帧值，再按属性依赖求表达式/布局/路径，渲染、选框和 Agent 检查共用结果。软件不调用模型；外部 agent 可以用 TypeScript/JSON/MCP 创作，并批量预检后一次提交和撤销。

## 属性表达式

Node.expressions 将数字属性路径映射到表达式字符串，例如：

```ts
node({id:'marker',type:'rect',x:30,width:20,height:12,
  expressions:{x:'value + 40 * sin(time * Math.PI)',opacity:'clamp(time,0,1)'}});
node({id:'label',type:'text',text:'FOLLOW',width:120,height:30,
  expressions:{x:'layer("marker").x + 24',y:'layer("marker").y - 32'}});
```

frame/fps/time/seconds、width/height/duration 是当前图层图的局部时钟与画布尺寸。value 为该属性的关键帧/原始值，base 为同层未应用驱动的属性；self/parent/layer("ID") 读取最终属性依赖，scene.width/height 等读取当前逻辑画布。没有父级时 parent 使用场景尺寸。完整 ID 或组件内部稳定局部 ID 都可定位图层；不按名字猜测对象。

支持数字运算、比较、逻辑、三元条件、字面量数组索引；sin/cos/atan2/pow/sqrt/min/max/clamp/lerp/smoothstep/rad/deg 等纯函数，Math.PI 等常数。random(seed) 使用显式种子，不执行 Math.random。drivers_inspect 返回可用 symbols/functions 和语法边界。

表达式不是任意 JavaScript：赋值、循环、函数定义、异步、系统/网络/文件调用及原型访问都不执行；一般算法继续使用 TypeScript 组件。输出必须有限数字，opacity/reveal 按 0–1 钳制。跨属性依赖按需求值，self.x 驱动 x 会报循环，想沿原动画叠加应使用 value/base.x。缺失 ID、非法语法、非有限运算和循环报告所属节点/字段与恢复建议。

表达式可以驱动 params.*、effects.*、layout 数字字段和 motionPath.progress 等普通数字通道；默认字段必须存在。声明字符串/布尔参数可以用于比较条件，但输出仍为数字。组件参数类型仍在组件渲染时验证，整数参数应避免连续插值。

## 布局约束

```ts
rect('panel',{
  height:80,
  layout:{reference:'scene',width:{value:.3,unit:'fraction',min:160,max:400},
    x:{at:'end',self:'end',offset:-24},y:{at:'start',self:'start',offset:24}}
});
```

reference 可选 parent、scene 或 {nodeId:"稳定 ID"}。锚点 at/self 取 start/center/end；width/height 使用 fraction 或 pixels，支持 min/max。insets 的双边留空驱动尺寸，单边定位；aspectRatio 在一个尺寸有约束时推导另一尺寸。相同轴的锚点/留边、显式尺寸/双边留白冲突会拒绝，避免偷偷选一个规则。

布局使用声明的逻辑宽高，节点引用通过祖先矩阵换算到目标父级坐标。旋转参考层使用转换后的矩形包围框。它不是最终像素排版证明，不自动测量 glyph、裁剪或效果外溢；文字可使用已有 measureTextBlock 由 TypeScript 决定尺寸。完全退化父级无法做跨坐标换算时有明确错误。

## 曲线路径动作

```ts
node({id:'marker',type:'rect',width:20,height:12,originX:10,originY:6,
  motionPath:{nodeId:'route',autoRotate:true,anchor:'origin'},
  expressions:{'motionPath.progress':'frame / 119'}});
// 也可以 motionPath:{path:'M0 0 C0 100 100 100 100 0',progress:.5}。
```

每个路径动作选择 SVG 字符串或矢量图层 nodeId；useRendered=true 使用 trim/reveal 后路径，否则使用原轮廓。进度按合并轮廓弧长，而不是曲线参数，repeat 可 clamp/loop/pingpong；autoRotate 使用切线方向，支持 rotationOffset。anchor=origin/center/topLeft 与 offsetX/Y 决定目标点。引用路径矩阵先转换到目标父级，所以非均匀缩放、父级和路径旋转会参与位置与朝向。

SVG 先按原生路径语义规范化直线/二次/三次曲线与圆弧；用自适应积分与长度表查找位置，返回位置、单位切线、角度和多轮廓跳跃提示。多轮廓之间没有自动连接线；路径断点可产生跳跃，需要 agent 根据作品决定。prepareCurvePath 的缓存数据冻结，sampleCurvePath 支持随机跳转。

布局和路径不能同时驱动 x/y；表达式对同字段具有显式最终优先级。路径动作控制的字段替代原位置键；可以给进度/offset 写键或表达式，而不是误以为原 x/y 键仍控制路径。角度按切线返回，正负 180 度等价，数值轨迹可能跨该边界；没有自动烘焙连续角度键。

## Agent 批次

drivers_inspect 指定 sceneId/path/contextFrames、nodeIds 与 frames，返回最终 pose、数字驱动值、依赖和源码摘要；animation_inspect 在有驱动时标记 sampleSource 为 keys-and-drivers，并使用实际值/数值速度。curve_path 独立查询弧长/切线，不打开工程也能计算。

drivers_plan 一次处理多个场景和生成作用域的 expressions/layout/motionPath 配置以及数字 keys。表达式字段可传 null 删除，resetExpressions 明确清空旧表达式；layout/motionPath=null 解除配置，removeChannels 显式删除对应配置键，保留其他通道。动作修改全部完成后检查最终依赖状态，所以合法的批量重连不被中间状态阻止。

```json
{
  "revision":"当前工程版本",
  "targets":[
    {"sceneId":"intro","nodeId":"film/marker","path":["film"],"motionPath":{"nodeId":"route","autoRotate":true},"expressions":{"motionPath.progress":"frame / 119"}},
    {"sceneId":"intro","nodeId":"film/label","path":["film"],"expressions":{"x":"layer(\"marker\").x + 24"}}
  ]
}
```

候选不保存活动工程，生成修改进入所属 overrides；源码保持。返回短 planId，经原生画面/确定性/视觉预检后原样 project_apply，共享一次撤销。覆盖最多 12 个图片样本，coverage.incomplete 需补样本；检查不是全帧证明。

独立组页面先在父级完整图中求值，再隔离组内画面，保留外部引用和父级尺寸。raw scene 数据仍可编辑；focused drivers_inspect 返回最终 pose，完整依赖边在父级 scope 查询。组件内部使用自己的宽高及内容时钟；图层历史效果会对驱动再次求值，当前父级矩阵限制沿用时间效果说明。

当前实现不是 AE 表达式语言兼容层，不支持跨场景任意属性引用、任意过去帧 valueAtTime、自动布局求解器/空间速度编辑器。每层最多 64 条表达式/每条 4000 字符，属性依赖深度128、当前求值200000操作；路径最多4096规范化段、自适应积分预算50000。预算失败不降级导出质量。全功能目录见 FUTURE-WORK.md。

Node.animationLayers提供关键帧后的有序叠加基础，再进入当前属性依赖系统；base/value因而包括普通键和动画层混合。weight/rate/offset用普通键或TypeScript先控制，post-stack expressions直接控制animationLayers元数据会报错，避免用已混合结果逆向修改栈。循环/外插规则也在此基础阶段执行。详见[动画层与原生索引](ANIMATION-LAYERS.md)。

examples/drivers-lab 是4秒1280×720/30fps可编辑示例。scripts/check-drivers.mjs 实际验收表达式+布局+路径跨原始/生成两场景批量候选、依赖循环恢复、原生取证、随机访问、PNG字节一致、120帧MP4和一次撤销；--packaged 使用封装运行时。
