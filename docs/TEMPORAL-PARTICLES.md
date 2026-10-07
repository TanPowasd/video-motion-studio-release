# 时间效果、粒子与局部变形

所有功能都在本地运行，外部 agent 通过 SDK/JSON/CLI/MCP 组合画面；程序不调用模型。预览和导出共用实现，动画必须支持随机跳转，不能依赖上次播放状态。

motionBlur({samples:8,shutterAngle:180,phase:0}) 放入普通 effects 堆栈，按子帧重新求值同一图层及其子内容。支持原生键、TypeScript 组件的 ctx 时间、内容时间、历史生成/消失的节点和遮罩。子帧以预乘 Alpha 在线性光中平均，透明边缘不会染黑；零快门/禁用精确保留原画面。phase 单位为帧，相对当前采样中心，samples=2–32。

echo({count:8,spacing:2,decay:.65,strength:.65,operator:'over'}) 从历史到当前按稳定顺序合成。spacing 默认帧，units=seconds 可按项目有理数 FPS 换算；decay 逐样本衰减，当前样本完整保留，operator 支持 over/add/screen。负时间跳过，count=1、decay/strength=0 或禁用效果精确保留源。未来不会沿用之前播放过的画面缓存作为历史。

```ts
import {node, motionBlur, echo, particleField, group} from '@vmotion/sdk';
const marker = node({id:'marker',type:'ellipse',x:ctx.frame*4,y:50,width:16,height:16,
  effects:[motionBlur({samples:8,shutterAngle:360}),echo({count:4,spacing:1})]});
const sparks = group('field',particleField('spark',ctx,{seed:7,rate:50,shape:'streak'}),{
  width:640,height:360,effects:[echo({count:3,spacing:1.5,operator:'screen'})]
});
```

效果顺序有意义：时间效果对其之前的图层图和效果重新求值，之后的效果作用于合成结果。根透明度和原遮罩在每个历史样本中只乘一次；时间效果之后的模糊/变形可以把像素扩展到原遮罩边界之外。若要最终再裁切，使用外层组/遮罩。稳定效果 ID 和一致的堆栈结构让程序化变化有明确的来源。

图层时间效果使用所属图层图的时钟；外层父级矩阵、clip 与相机采用当前画面状态。要模糊父级整体运动，把效果放到该组或组件上；相机/整个合成运动可使用已有 project.motionBlur。内部组件参数动画在非零线性速率下按附近父级时钟取样；freeze/remap 的父级参数保持当前上下文，源码 ctx 内容时钟仍正确取样。focused 组件预览通过历史 source provider 再生成内部代码，避免只移动当前快照。

每个输出帧最多 512 次历史查询、256M 查询像素、8 层时间递归；临时图层与时间累加器各有 256MiB 上限。指数嵌套会返回 TEMPORAL_BUDGET，错误后释放资源。不会偷偷降低导出分辨率。强效果先查询适当样本，使用小范围预检，再显式选择采样数。当前是 CPU 路径，不承诺实时 4K 复杂效果。

particleField 和 particleState 使用 seed 与出生 index 产生确定数据，支持 burst/continuous、point/box/disk/line 发射、均匀圆盘、方向/散布/速度、重力与指数阻力的解析解、大小/透明度/旋转/颜色随寿命变化，以及 circle/square/velocity streak。时间、start、lifetime 单位为秒，几何为局部像素，速度为像素/秒。SDK 可提供 originAt(birth,index)，使移动发射源的粒子留在出生位置，而不是整批跟随当前 origin。

所有粒子都可随机求值，返回稳定 birth ID。maxAlive 至多 2000，最多检查最近 16384 个候选；particles_inspect 明确返回 candidates/examined/truncated 和原始记录分页、保守局部边界。truncated 表示活跃数量或扫描预算截断，不能解释为完整粒子证据。建议按画面需要设置 rate/lifetime/maxAlive，避免隐藏预算截断。

解析场按当前参数重建时间函数；随时间改变 rate/seed/lifetime/velocity 会重新定义出生或轨迹，不是累积物理模拟。需要固定出生运动时，通过 TypeScript 的 originAt 和显式轨迹控制，或保持出生 schedule 参数不变。碰撞、流体、烟雾体积和粒子间物理尚未实现。

Agent 用 particles_inspect 先看参数/位置/速度/数量证据，再用 particles_plan 指定 sceneId/path/contextFrames/frame/revision、settings、可选整组件 effects。计划创建参数化 TypeScript 模块和图层，预检原生图后原样 apply，共享一次撤销；原有代码保持。后续 component_parameters/animation_edit 使用同一声明编辑 controls。发射器 plan 的默认 origin 在目标画布中下部，可显式提供 origin。

liquify({brushes:[{mode:'push',center:{x:.5,y:.5},radius:100,dx:40}]}) 使用平滑的局部反向采样场，组合 push/twirl/inflate。center 在 region 中归一化，radius/dx/dy 为局部像素，angle 为度，amount 控制方向/强度；最多 128 笔刷，字段通过 effects.N.brushes.I.radius/dx/dy/angle/amount/center.x/y 动画。图层/画布坐标和透明采样沿用其他空间效果，区域外像素精确保留。它是可编辑采样形变，不是流体/物理笔刷，不提供鼠标笔刷面板；复杂折叠使用 meshWarp 或显式控制网格。

examples/temporal-lab 包含可编辑 4 秒 1280×720/30fps 示例，展示 sharp/blur、历史轨迹、解析粒子条纹、网格与局部旋转组合。scripts/create-temporal-lab.ts --render-only 保留用户修改；重写需要 --rebuild。真实 MCP 验收为 node scripts/check-planar-motion.mjs --packaged，覆盖组件内部效果/刷键、粒子计划/参数/撤销、原生图片、随机跳转、PNG 字节一致和实际 MP4。
