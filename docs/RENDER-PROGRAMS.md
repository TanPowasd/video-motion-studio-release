# 自定义 Python 渲染器和 WGSL

外部 Agent 可以直接编写渲染算法和完整 shader，不必转换成内置节点组合。程序不接入 AI 模型。自定义输出作为普通图层/效果，继续使用同一时钟、关键帧、遮罩、混合、预览和导出。

## 项目资源与 SDK

`components/renderers/*.json` 声明 `kind: "render-program"`、`version: 1`、name、`backend: "python" | "wgsl"`、entry。files 声明额外项目源码/JSON 依赖，assets 声明素材 ID；源码随工程快照、验证和收集。入口/依赖在 components 内，扩展名 py/wgsl/json，不允许路径越界。总源码上限4MB，单个 WGSL 上限128KB。

parameters 可声明标准 Vmotion 参数类型及默认值；省略时传入任意 JSON 参数对象。uniforms 声明 WGSL 数值参数路径顺序，最多64个有限 f32。workgroup 默认 `[8,8]`，须与 shader 一致，乘积≤256。timeoutMs 默认10000，可设100～60000，超时终止进程并返回诊断。

`programLayer(id, manifestPath, props)` 创建 program 图层；`programEffect(manifestPath, params)` 创建有序效果，也能作为 effectGraph 的 pass。节点 `params.*`、效果 `effects.N.params.*` 使用普通关键帧。程序图层支持内容时间重映射。可从 defineComponent 转发它暴露的参数，沿用现有可视化参数编辑。

## Python

```python
def render(ctx, params, input_rgba):
    color = bytes([int(ctx['frame']) % 256, 80, 180, 255])
    return color * (ctx['width'] * ctx['height'])
```

ctx 提供 frame/seconds/fps/timebase、width/height、seed、revision、assets（ID、类型、本地路径、metadata）。返回 bytes/bytearray/memoryview，严格 width×height×4 个非预乘 SDR RGBA8 字节。生成器输入透明，效果输入为当前合成画布。可使用 NumPy/Pillow `.tobytes()` 或自己的离线渲染程序，不依赖 DOM。

便携包内置 CPython 标准库。VMOTION_PYTHON 指定装有第三方库的解释器；程序不自动安装这些依赖，移动工程时需另行迁移/固定该环境。files 会写到按内容 hash 固定的快照目录，素材通过声明引用提供。Python 是用户可信代码，具有所选解释器的本机权限，和 TS 组件一样不是安全沙箱。

每帧重置标准随机种子，其他随机库自行使用 ctx.seed。动画从给定时间求值，避免墙上时钟/调用计数；可缓存纯数据。最多复用4个 worker，不缓存帧结果，依赖变更产生新 worker。print 转到 stderr，stdout 专用于有界二进制协议。Windows 超时/关闭会终止所属进程树。

## WGSL

提供完整 main 入口，三个 storage binding：

```wgsl
@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read> clock: array<vec4<f32>>;
// clock[0] = width, height, frame, seconds
// clock[1] = fps, seed, uniform count, reserved
// clock[2..17] = 64 scalar parameter values, unused lanes zero
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) p: vec3<u32>) {
  let w = u32(clock[0].x); let h = u32(clock[0].y);
  if (p.x >= w || p.y >= h) { return; }
  let i = p.y * w + p.x;
  output[i] = input[i];
}
```

u32 按 R/G/B/A 的低→高8位打包。可以编写光线步进、分形、流场、自定义形变和数值算法，无需内置 kernel。input/output 只暴露当前画面长度，输出先清空，复用有界设备缓冲；pipeline 缓存最多16份。作者负责 shader 边界和 workgroup 一致。

WGSL 需要真实 GPU，gpu:cpu 明确失败，不用不同画面冒充回退。不同驱动不保证自定义浮点 shader 字节一致，应使用 frame_compare/render_compare 和采样确定性验证。当前接口不提供任意新增 binding/多纹理；其他图层可先在效果图中合成到输入，任意素材和外部渲染程序可通过 Python 访问。

## Agent 验证与边界

通过 project_schema renderProgram 获取格式，用 editFiles + addNode/effects 批量创建，保持稳定 ID。project_preflight 采样多时刻并启用 determinism，检查原生图片和源码位置，再提交原候选并验证一次撤销/重做；render_start 使用审阅 revision。结构验证不能证明任意脚本运行正确，必须取帧。

Python 解释器版本/二进制/wrapper、GPU 设备和源码快照进入导出版本；声明素材继续检查变化。外部安装的库、未声明读文件不会自动快照，应固定环境并声明 files/assets。render_profile gpu:auto 返回 programs 的帧数、workerStarts、字节计数；MCP 图片只传一次。UHD/时间/协议超限报错，不静默降分辨率。

examples/program-lab 是可编辑 Python 波形 + WGSL 光线步进三维演示。create-program-lab.ts --render-only 导出已有工程，重建必须显式 --rebuild。验收覆盖真实 MCP、超时/错误、随机跳帧、shader 错误、PNG parity、候选撤销、pack、便携解释器及导出；不宣称任意自定义代码实时运行。
