# 动画层、循环曲线与原生索引

动画层让位移、缩放、透明度、组件参数和效果通道自由叠加，普通关键帧保留为基础。权威数据为Node.animationLayers，使用稳定ID、可继续编辑的数值通道与独立局部时钟；SDK、CLI、MCP、渲染和选框使用相同求值。程序不调用AI模型。

```ts
node({id:'card',type:'rect',x:100,width:80,height:60,
  animations:[{property:'x',keys:[{frame:0,value:100},{frame:90,value:300}]}],
  animationLayers:[{
    id:'float',blend:'add',weight:1,start:0,rate:1,offset:0,
    channels:[{property:'y',keys:[{frame:0,value:0,easing:'easeInOut'},
      {frame:24,value:-24,easing:'easeInOut'},{frame:48,value:0}],after:'cycle'}]
  },{
    id:'breathe',blend:'multiply',weight:.8,
    channels:[{property:'scaleX',keys:[{frame:0,value:1},{frame:30,value:1.2}],after:'pingpong'}]
  }]
});
```

普通键先求值并钳制opacity/reveal，再依顺序混合动画层，最后再次钳制opacity/reveal；布局、路径和表达式在该基础之后求值。设已有值v、当前层通道k、权重w：add为v+w×k，multiply为v×(1+w×(k−1))，replace为v+w×(k−v)。weight在0–1之间，0不贡献；顺序会影响结果，界面或工具不擅自交换。其他属性不偷偷钳制，越界参数/非有限值有诊断。

层默认从start=0开始，end为可选的独占结束帧；没有end表示持续作用到之后。层局部帧为(parentFrame−start)×rate+offset，rate可为0冻结或负数倒放，范围−1000至1000。channels里的键为局部非负整数，采样可为小数或负数。每个层最多64通道，整个层栈最多32层/100000键；普通通道与原生索引程序合计最多100000键。层内禁止控制animationLayers.N.*，避免自引用；用普通动画控制weight/rate/offset。重排/复制/删除按层ID映射这些控制键，复制保留原控制曲线，删除清理。权重和rate表达式发生在混合之后，故明确拒绝直接给这些元数据写post-stack expression；TypeScript或普通键可先计算。

曲线before/after独立选择constant（默认）、linear、cycle、cycleOffset或pingpong。linear按最近两个键的割线延续，不伪称贝塞尔瞬时切线。cycle重复首末键区间，cycleOffset每周期增加末值−首值，pingpong按周期反转。正好位于原首/末键仍返回该键；区间之外的周期边界可能跳跃，这是显式曲线行为。单键恒定。SDK prepareKeyframes返回冻结、已排序索引，sampleKeyframes支持随机跳转/二分查找；修改原键不改变prepared。interpolate仍兼容原调用，可传{before,after}，内部有界缓存按实际数据检测变化。

原生Rust索引协议将关键帧程序与当前数值姿态分开。相同定义按实际内容指纹编译一次，排序后二分查找；后续只传受控数值属性/层元数据，不发送文字、素材、网格与全部源码。宿主复制改变路径的容器，保持未改变资源与通道，源节点不被求值改写。宿主定义缓存128项/8MiB估算，Rust程序缓存128项/16MiB估算；按原始数组实际内容复核，缓存逐出/进程重启后缺失程序重传，错误不降级画面。每个原生请求最多64节点、16MB输入限制；大定义超限明确诊断。旧原生程序或缺失程序使用完整TypeScript语义回退，性能证据标记fallbackNodes。缓存不存渲染帧。

render_profile/render_compare的nativeCache=false关闭定义/程序复用，提供像素相同的性能基线。cache.nativeAnimation报告实际IPC字节、定义字节、宿主hash/reuse、原生编译/命中/逐出/保留量、binarySteps与samples。估算缓存字节不是全JS/Rust堆认证；减少程序发送不等于整个场景都快。旧主进程使用旧二进制时，不能靠文件更新自动获得新版本，要重启服务。

Agent先调用animation_layers_inspect：默认8层/16通道，按layerIds/properties选择，offset/limit和channelOffset/channelLimit独立分页；includeKeys才读keyOffset/keyLimit键页，默认32键。覆盖/总数/nextOffset明确。samples显示普通键+完整栈结果、当前权重/局部帧，**位于驱动前**；animation_inspect与frame_capture可验证驱动后的最终值和原生画面。未知层/参数或旧revision拒绝，不修改历史。

animation_layers_plan批量处理原始/生成层append/update/remove/move/toggle/duplicate/channels。update保留稳定ID、数组完整替换，end:null移除窗口；channels复用关键帧动作，包括extrapolate。普通animation_edit也可设置extrapolate，其before/after:null恢复默认。生成目标用完整ID/path，例如code/box与["code"]，局部frame和祖先contextFrames按现有内容时钟规则。端点/窗口/原键最多128个姿态检查，图片最多12帧，coverage明确遗漏；节点参数按实际组件定义校验，不是所有帧保证。

effect/shape/text算子重排和复制同步动画层通道，组件参数数组insert/remove/move也保持指向原项目；删除最后受控来源后空层及元数据键一起清理。表达式文本引用仍遵守原重排保护，不自动改写任意代码。提交使用固定planId、预检画面/确定性、准确apply与一次共享undo。

motion_plan默认output=keys保持原行为；output=layers把每个cue变成同ID的动作层，可在同属性上重叠。blend默认replace，add/multiply默认neutral基值0/1，replace默认source基值；valueBasis显式source/neutral改变模板的base。weight、window（只在cue区间及最后键帧作用）、before/after均可配置；已经存在的cue层ID拒绝，修改既有层用layers_plan。不同时间由有理数fps换算绝对键再取整。此前collision策略仍用于keys输出，层输出保留普通键。SDK applyMotionLayers与服务使用同样规则。

独立examples/animation-layers-lab展示基础运动、add浮动+multiply呼吸和最终表达式跟随；六秒720p30、180帧保持可编辑。create-animation-layers-lab.ts的--render-only保留编辑，重写需显式--rebuild。动画层当前重点服务Agent与代码，独立图形化动作层编辑面板、自动烘焙驱动与任意历史属性采样仍待实现。

该批当前便携MCP参考场景：2000键、12次成对帧像素相同，原生编译24→2，definitionBytes1467432→122330、evaluationBytes1480869→135743，热均值4.866→1.268ms。是本机特定图的缓存基线，不是旧版本/全部场景/4K长片性能证明。layer摘要798字节、显式1000键页60315字节；没有使用模型分词假设。默认10入口仍13729字节，layer inspect schema2056/缓存134、plan schema10998/缓存131字节；schema含ref保持完整验证。
