# 线性代数与数值优化

外部 agent 可通过 `linear_algebra` MCP 工具或 `vmotion linear-algebra --request request.json` 计算数值证据，无需打开界面。MCP 参数为 `{ "request": { "operation": "solve", "a": [[2,1],[1,3]], "b": [5,5] } }`；CLI 文件直接保存内部 request 对象。该例返回 solution `[2,1]` 与 residualNorm。程序不调用 AI 模型。

| 操作 | 输入 | 结果 |
|---|---|---|
| multiply | a、b 矩阵 | matrix |
| transpose / inverse / determinant | a 矩阵 | matrix 或 determinant |
| solve | 方阵 a、向量 b | solution、实际 residualNorm |
| leastSquares | 行数不小于列数的 a、b，可选 relativeTolerance | solution、rank、residual、residualNorm、列置换 |
| transformPoints | a、points，可选 project | 批量变换后的 points |
| conjugateGradient | SPD 方阵 a、b，可选 initial、relativeTolerance、maxIterations、trace | solution、converged、iterations、residualNorm、target、steps |

矩阵按行保存，向量视为列向量，`A*B` 表示先应用 B 再应用 A。原生二维仿射 `[a,b,c,d,e,f]` 对应 `[[a,c,e],[b,d,f]]`。普通矩阵变换可使用线性矩阵，增加一列表示平移；project=true 要求齐次方阵，并对最后一个分量进行透视除法，零分母返回 `POINT_AT_INFINITY`。

SDK 提供同名函数及 `matrixIdentity`、`matrixVector`、`vectorDot`、`vectorNorm`、`matrixLU`、`preparePointTransform`：

```ts
import { matrixLU, preparePointTransform, leastSquares, conjugateGradient } from '@vmotion/sdk';

// 常量分解与变换在组件模块加载时准备，逐帧只做必要的计算。
const factor = matrixLU([[4,1],[1,3]]);
const map = preparePointTransform([[2,0,100],[0,-2,200]], 2);
const fit = leastSquares([[1,0],[1,1],[1,2]], [1,2,2.8]);
const optimization = conjugateGradient([[4,1],[1,3]], [1,2], { trace: true });
const solution = factor.solve([1,2]);
const points = map([[0,0],[1,1]]);
// render(ctx) 按帧插值 optimization.steps，不保留上一次播放状态。
```

矩阵乘法使用 Float64Array 与连续行循环；LU 采用按行尺度选主元，并可复用同一分解求解不同右端项。最小二乘使用列主元 Householder QR，避免构造 AᵀA 放大病态问题。秩判断按 relativeTolerance 进行；秩不足时返回错误，当前不提供伪逆或欠定系统最小范数解。determinant 对该容差下的奇异矩阵返回 0。

共轭梯度用 Jacobi 预条件，要求输入对称正定矩阵，迭代检查正曲率；不是完整的正定性认证。返回实际重新计算的残差及 converged，达到迭代上限不等于求解成功。trace 的中间位置适合制作二次函数优化动画。

工具矩阵上限 128×128、批量点上限 10000、迭代上限 512；SDK 矩阵上限 256×256。运算使用本地 JavaScript Float64，当前没有 BLAS/GPU/SIMD 加速，也不覆盖 SVD、通用特征分解或稀疏求解。形状、有限值、奇异性和投影错误返回明确错误码。浮点结果以残差与视觉检查为依据。

`examples/linear-algebra-lab` 是实际使用 SDK 的 12 秒 1280×720/30fps 可编辑工程，包含基向量/网格变换、带噪数据拟合、二次函数等高线和优化轨迹。创建脚本默认保护已有工程，后续导出用 `npx tsx scripts/create-linear-algebra-lab.ts --render-only`。
