# 自由编程视觉

左侧由 Python 标准库生成波形干涉；右侧由项目 WGSL 对球体/圆环进行三维光线步进。全部算法源码位于 components/renderers，与场景/序列一起保存。

图层的 params.speed 可关键帧编辑；也可在 defineComponent 中转发可视化组件参数。渲染器按指定帧求值，不依赖播放历史。

`npx tsx scripts/create-program-lab.ts --render-only` 导出现有工程，`--rebuild` 才重新生成示例。WGSL 需要真实 GPU；Python 默认使用便携包/本地 runtime 中的标准库，VMOTION_PYTHON 可指定其他环境。详见 docs/RENDER-PROGRAMS.md。
