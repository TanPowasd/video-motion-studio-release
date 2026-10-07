# 可编程特效节点图

节点图是版本化 JSON 资源，也可通过 TypeScript 生成内联定义。SDK、CLI 和 MCP 共用参数连接、拓扑检查、原生空间效果与同一渲染管线。软件不调用模型；外部 agent 决定画面和编写节点。

当前节点支持 input、pass、blend、mask、transform、displace、noise、texture、solid、channels、colorMatrix、subgraph。一个输入可以被多个分支复用，节点按依赖顺序求值，使用完的临时画面及时释放。output指定默认最终节点；outputs可声明最多32个命名输出，所属effect或subgraph节点的output选择一个端口。未连接到选定输出的节点不渲染，unused明确报告；定义与未使用分支仍完整验证。

| 节点 | 用法 |
|---|---|
| input | source 是当前堆栈的输入；其他 slot 通过所属 effect.bindings 绑定同级图层 |
| pass | 调用已有空间/颜色效果，如 blur、glow、curves、LUT、warp、liquify，和普通堆栈共用实现 |
| blend | foreground/background 两分支，支持透明度和 source-over/screen/multiply/overlay/difference/lighter/darken/lighten |
| mask | 输入及 matte 分支，支持 alpha/luma、反向和羽化 |
| transform | 六项仿射矩阵，可选择 layer 或 canvas 坐标 |
| displace | 以 map 的通道控制 X/Y 采样偏移，透明 map 为中性；使用预乘 Alpha 双线性采样 |
| noise | 可重复的分形噪声，seed/scale/octaves/evolution、颜色和局部 region |
| solid | 固定颜色/透明度/区域的图像发生器 |
| subgraph | 引用 components/effects/*.json，通过 inputs 连接父图节点，params 设置子图参数 |
| channels | red/green/blue/alpha各取0–1常数，或{input,channel}，通道可选red/green/blue/alpha/luma；可重组RGB、提取透明遮罩和复用外部输入 |
| colorMatrix | input经过四行、每行RGBA系数加bias的20项矩阵；colorSpace选择srgb或linear，alpha始终线性，最终钳制为SDR |
| keyer | 颜色UV距离或亮度阈值抠像，softness控制smoothstep边缘，spill抑制键色主通道，invert反转覆盖，view选择color/matte；乘原alpha一次 |

命名输出在图根部声明`outputs:{color:'graded',matte:'mask'}`，默认`output:'graded'`继续兼容。SDK第四参`effectGraph(source,params,bindings,'matte')`、`compileEffectGraph(graph,params,resolver,'matte')`及子图节点`output:'matte'`选择相同端口。每个subgraph实例选择一个输出；多实例可引用同一资源，当前分别展开/渲染，未承诺一次求值返回所有输出。删除端口仍有引用时，候选预检拒绝保存，保留原工程。短动作`{type:'outputs',outputs:{...}}`替换端口表，空表移除命名输出。

channels使用直通的非预乘SDR数值，不自动把颜色乘输入alpha；显式把alpha接到源alpha可保持透明边缘。luma沿用现有sRGB加权亮度，未伪装成物理线性亮度。colorMatrix的4×5矩阵按行排列，bias为规范化值，例如alpha行`[0,0,0,-1,1]`反转透明度。linear模式先解码sRGB颜色，再算矩阵，最后编码回sRGB；alpha不做伽马转换。这是局部SDR调色，完整线性合成/HDR/OCIO仍待实现。常数alpha或矩阵alpha bias可影响整个工作画布，需遮罩/预合成显式限定范围。部分透明色经过原生8位预乘存储可能有1级量化差异；identity与默认源输出有像素回归。

```ts
import {defineEffectGraph,effectGraph,node} from '@vmotion/sdk';
const graph = defineEffectGraph({
  kind:'effect-graph',version:1,name:'高光分支',
  parameters:{radius:{type:'number',default:8,min:0,max:50}},
  nodes:[
    {id:'src',type:'input'},
    {id:'glow',type:'pass',input:'src',effect:{type:'glow',color:'#8abfff',radius:8}},
    {id:'out',type:'blend',background:'src',foreground:'glow',mode:'screen',opacity:.7}
  ],
  links:[{nodeId:'glow',property:'effect.radius',parameter:'radius'}],
  output:'out'
});
const title = node({id:'title',type:'text',text:'Vmotion',width:500,height:100,
  effects:[effectGraph(graph,{radius:12})]});
// 也可使用 effectGraph('components/effects/brand.json',{radius:12})。
```

参数声明复用组件的 number/color/boolean/enum/vec2/vec3/array/object 类型。links 连接参数叶字段或结构化值到节点字段；数字可设置 scale/offset，mode=number 明确只接数字，默认 direct 可接颜色、布尔、枚举或数组/对象。连接后重新验证节点字段的类型和范围；ID、节点类型和输入拓扑不通过参数静默改变。子图参数先读取资源默认值，因此可直接连接到子图的 params.radius 等字段。

图层上的 effect.params 可以独立设置不同实例，数值路径 effects.N.params.radius 或 effects.N.params.offset.x 支持原生关键帧。MCP plan 会物化默认参数，让关键帧路径存在；代码生成图层的效果/键保存到所属 overrides，不改 TypeScript。字符串/枚举/布尔通过实例参数或 TypeScript 切换，不伪装成数字键。

命名输入绑定同一图层图中、与所属层共享 parent 的图层。可提供完整 ID，SDK 内部也可使用局部 sibling ID；渲染解析生成命名空间。源层包括其真实内容、效果和遮罩，独立捕获时忽略外部混合模式。跨父级需要先预合成或使用一个同级组，以保证坐标与外部合成顺序明确。绑定不会自动隐藏素材层；需要时使用普通遮罩源、单独组或显式结构操作。禁止输入反向依赖所属层输出。

transform 在完整图层/相机矩阵下换算 layer 单位；canvas 模式忽略图层局部变换。map 通道中 .5 为中性，正值向正坐标采样；amount 使用局部像素，经图层矩阵变换到实际画面。noise/solid 默认生成于所属层声明的区域，canvas 模式默认整张逻辑画布；可明确设置 region。透明边缘使用预乘 Alpha；mask 的 luma 与已有遮罩管线一致，blend 延用原生 Canvas 合成行为。

Agent 接口：

1. 先使用effect_graph_query：section选择nodes/parameters/links/unused/resources/outputs，默认24项、最高100，ids筛选本节稳定ID，offset/nextOffset分页，counts与coverage明确遗漏。默认值最多2层/4项、字符串160字符，省略完整参数定义/Schema；detail才读选定节点值或完整参数/该参数Schema，资源节提供hash而不传源码。output选择待检查端口，revision过期和无效ID拒绝，不改变历史。仍解析/验证完整定义，分页不代表编译只做24节点。
2. effect_graph_inspect保留完整接口，查询资源或所属图层/帧中的graph effect。返回参数schema/当前值、连接、拓扑、输入、资源hash、unused和图面存活数量估算；output可选择命名端口。估算不含所属堆栈、外部图层捕获和效果内部临时图；实际分配继续受渲染预算限制。nodeIds筛选节点，includeValues取具体字段；includeGraph明确取完整定义。
3. effect_graph_plan 创建/替换资源并对多个场景、组和生成内容附加或更新 graph effect。也可只保存可复用资源。resources 可在同一事务中保存子图；每个文件使用 expectedHash，null 表示只创建新文件。
4. 通过actions执行短的稳定ID操作：add/update/replace/remove/output/outputs/links/parameters/name。update深合并字段，数组完整替换，不能改ID/type；replace改类型但保留ID。全部动作后验证最终图，删除仍引用的节点/端口会拒绝。
5. target.action=update需现有effectId；参数、输入绑定与输出选择默认保留。target.output指定命名端口，null显式恢复默认输出。resetParams/resetKeys升级旧参数/通道，不影响其他图层动画；keys设置参数的数字通道。生成图层继续使用完整命名空间ID与path定位，例`nodeId:'code/shape',path:['code']`。
6. 使用返回的短 candidate.planId 预检原生画面与确定性，再原样提交 apply，资源和全部场景共享一次撤销。coverage 明确报告超出 12 帧的未采样部分；资源独立修改时应在 preflight.samples 补入已有使用场景。

```json
{
  "revision":"当前版本",
  "source":"components/effects/brand.json",
  "expectedHash":"从 inspect/read 读取的原文件 hash",
  "actions":[{"type":"update","nodeId":"out","patch":{"opacity":0.4}}],
  "targets":[{"sceneId":"intro","nodeId":"title","action":"update","effectId":"brand","params":{"radius":10}}]
}
```

CLI effect-graph-query/effect-graph-inspect/effect-graph-plan使用--request JSON，与通用tool-call相同。project_schema name=effectGraph提供格式；SDK editEffectGraph操作节点/输出，compileEffectGraph检查/展开子图，defineEffectGraph检查本图拓扑。

Renderer的定义LRU最多128项/4MiB估算、编译结果LRU128项/8MiB估算，复用键包含参数和端口，检查根/所有子资源实际源文本。变化、删除、非法JSON或失效端口立即重新验证；无关文件保留缓存。inline定义按实际数据比较，JSON签名中的undefined等碰撞不会绕过验证。缓存对象冻结，错误不变成缓存结果，不缓存像素或组件求值。render_profile的graphCache=false提供独立基线，resourceCache=false也关闭此缓存；performance.effectGraphs提供parses/compiles/reused/invalidations和保留量。估算字节限制不是完整JS堆或全工程内存认证。

channels/colorMatrix的输入readback与输出数组预留scratch，与活动图面/时间采样联合检查256MiB预算；失败后释放预留和图面。performance提供graphScratchPeakBytes与当前graphScratchBytes。超限明确报错，不降低导出尺寸；其余既有像素效果临时内存仍需后续统一全局核算。

运行时优化由graphOptimize/graphRegions/graphTileRows独立控制。严格单位transform（坐标基共轭后也精确为单位）、单位colorMatrix、原样RGBA路由、零位移和零不透明度blend共享输入图面；保留作者节点与全部输入依赖求值，不隐藏缺失来源、循环或可见输入的奇异坐标错误。引用计数防止分支旁路后提前释放输入。graphOptimize=false提供原图面复制基线。

channels/colorMatrix/keyer可按实际输入alpha支持范围只做可见像素计算。常数alpha>0或正alpha bias必须全画布处理；空alpha仍返回透明图面。边界用实际原生像素扫描，不用声明对象尺寸猜测。扫描本身需要完整RGBA读回，报告readbackPixels，可能比基线读回更多；减少的是昂贵内核的scalarPixels，不能宣称所有读回均减少。默认128行分块，graphTileRows=0为完整数组基线；最后不足一块的行仍完整处理。分块控制新内核的峰值临时数组，不缩小预览/导出尺寸，也不等于所有效果的全局内存已经核算。

keyer的chroma模式在编码sRGB的Rec.709 UV平面计算键色距离，luma模式使用同一加权亮度。threshold以下去除，softness将覆盖用smoothstep过渡，原alpha只乘一次；invert反转覆盖而不会在原透明区域创造像素。view=matte用白RGB与新alpha，便于alpha遮罩复用。spill按键色最大通道抑制高于另外两通道的颜色，可为0完全关闭；没有复杂前景重建、自动色彩匹配或专业Keylight等价保证。先看不同背景上的边缘再提交。

render_compare使用同一工程/候选版本、固定帧与重复轮数，前后检查所有注册素材size/mtime（可编辑声音使用源hash），报告像素匹配、重复求值确定性、耗时、实际图面/readback/scalar开销、scratch峰值与有界节点定位。默认基线关闭运行旁路/区域/分块，优化配置开启；可显式覆盖baseline/optimized并选择执行顺序。默认返回紧凑证据，detail才返回逐轮hash/时间。graphDetail在render_profile中读取最多32条热点；内部最多256节点，遗漏执行明确标出。节点wall time包含嵌套输入捕获，不能相加当成独占时间。比较不自动改写工程、不把采样相同当作整条动画/4K/实时证明；素材检查是元数据而非媒体内容SHA。

graphExecution中的surfaces/surfacePixels统计图节点输出图面，readback/scalar统计已接入的点内核、图内场、遮罩与置换读回；既有raster pass内部全部scratch/readback尚未统一统计。surfaces池和fieldPixels另提供更广范围计数。不能把单项为0理解为原生效果没有执行或没有成本，定位仍需结合节点wall time与整帧耗时。

examples/keying-lab是六秒720p30演示，原始绿幕、抠像alpha与新背景同时保持代码/资源可编辑，create-keying-lab.ts必须显式--rebuild才重写，--render-only保留编辑。check-render-compare.mjs通过真实外部MCP检查保存前候选、双色/遮罩、优化等价/成本、CLI/直接加载、原生PNG/视频及一次undo。

运行时批次当前便携参考图10次采样像素全匹配，图节点输出330→30（300次严格旁路），scalar4608000→2394600，readback4608000→7002600，scratch峰值1843200→921600字节；热均值37.211→10.828ms。真实收益来自减少复制与内核区域，读回量在此例反而增加，不能据此宣称全系统加速。单算子UHD分块/16MiB临时预算测试通过，GPU与复杂4K/长片完整内存/实时验收仍待完成。默认成对结果9071/full13719 JSON字节；nodeLimit控制热点数，detail显式读逐轮信息。

本图最多 128 节点、512 连接，展开最多 256 节点，资源嵌套最多 8 层，单定义最多 8MiB。依赖循环、缺失输入、非法参数、错误 hash、删除仍引用的资源以及图层绑定递归有明确诊断。图像缓存按使用次数释放；临时 Canvas 上限沿用 256MiB，每输出帧 graph 工作上限 256M 节点像素计算，不降低导出分辨率。完全折叠的局部图像保持透明；有可见输入却无法换算的局部矩阵会报错。

这一阶段提供代码/JSON/MCP节点图、命名输出选择、通道合成、颜色矩阵及效果面板摘要。交互节点画布、GPU/自定义像素内核、共享实例多输出一次求值和图内时间分支尚未实现；motionBlur/echo可以放在节点图前后或所属组上，使用已有时间采样。检查只覆盖采样帧，参数连接超调和最终可见性仍需看原生图片。

examples/graph-outputs-lab是独立6秒720p/30fps可编辑演示，展示原始颜色、线性颜色矩阵和跨资源透明遮罩。create-graph-outputs-lab.ts重建需--rebuild，--render-only保留修改。check-graph-outputs.mjs使用真实外部MCP，验证分页/大参数、生成层端口与一次undo、缓存基线像素、子资源更新、PNG/视频及CLI桥接。

该批当前便携实测：精简节点查询3541对完整50985字节，约减少93.1%；40次图求值的解析80→2、编译40→6、复用34，缓存/无缓存像素全部相同。参考复杂图的热均值41.930→37.589ms，只是本机场景、不是整体实时或4K结论。默认MCP仍10入口13729字节，query的接口2266/条件缓存128字节；度量是JSON字节，不是模型token。

examples/effect-graph-lab 展示分支高光、命名图层遮罩、噪声置换和嵌套参数复用，已实际导出 4 秒 1280×720/30fps、120 帧。scripts/create-effect-graph-lab.ts --render-only 保留修改，重写需 --rebuild。真实外部 MCP 验收脚本 scripts/check-effect-graphs.mjs 包含节点筛选、短编辑、参数键、图片预检、PNG 字节一致、MP4 与原子撤销。
