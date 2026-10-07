import {
  defineComponent,
  text,
  path,
  rect,
  ellipse,
  formula,
  matrixMultiply,
  transformPoints,
  leastSquares,
  conjugateGradient,
} from '@vmotion/sdk';

// Constant fits/optimization are computed once per script process, independent of frame order.
const measurements = [
    [0, 1.2],
    [0.5, 1.5],
    [1, 1.85],
    [1.5, 2.7],
    [2, 2.55],
    [2.5, 3.4],
    [3, 3.7],
  ],
  fit = leastSquares(
    measurements.map(([x]) => [1, x]),
    measurements.map(([, y]) => y),
  ),
  optimize = conjugateGradient(
    [
      [4, 1],
      [1, 3],
    ],
    [1, 2],
    { initial: [-1.8, 1.6], trace: true },
  ),
  identity = [
    [1, 0],
    [0, 1],
  ],
  target = [
    [1.3, 0.65],
    [-0.25, 0.9],
  ],
  grid = Array.from({ length: 11 }, (_, i) => i - 5).flatMap((v) => [
    [
      [-5, v],
      [5, v],
    ],
    [
      [v, -5],
      [v, 5],
    ],
  ]);
const color = {
  ink: '#edf5ff',
  muted: '#8fa7c4',
  teal: '#69e3c6',
  violet: '#ab98ff',
  coral: '#ffa17b',
};
const progress = (frame: number, start: number, duration: number) => {
  const t = Math.max(0, Math.min(1, (frame - start) / duration));
  return t * t * (3 - 2 * t);
};
export default defineComponent({
  name: '线性代数：变换、拟合与优化',
  parameters: {},
  render(ctx) {
    const t = progress(ctx.frame, 25, 200),
      a = identity.map((row, i) => row.map((value, j) => value + t * (target[i][j] - value))),
      affine = matrixMultiply(
        [
          [26, 0],
          [0, -26],
        ],
        a,
      ).map((row, i) => [...row, i ? 404 : 333]);
    const nodes = [
      text('eyebrow', 'VMOTION  /  LINEAR ALGEBRA', {
        x: 50,
        y: 26,
        width: 1180,
        height: 30,
        fontSize: 18,
        fill: color.muted,
      }),
      text('title', '把矩阵变成运动，把算法变成画面', {
        x: 50,
        y: 66,
        width: 1180,
        height: 64,
        fontSize: 42,
        fontWeight: 700,
        fill: color.ink,
      }),
      rect('left-panel', {
        x: 50,
        y: 150,
        width: 566,
        height: 510,
        radius: 16,
        fill: '#111e31',
        stroke: '#263a55',
        strokeWidth: 1,
      }),
      rect('fit-panel', {
        x: 640,
        y: 150,
        width: 590,
        height: 254,
        radius: 16,
        fill: '#111e31',
        stroke: '#263a55',
        strokeWidth: 1,
      }),
      rect('opt-panel', {
        x: 640,
        y: 420,
        width: 590,
        height: 240,
        radius: 16,
        fill: '#111e31',
        stroke: '#263a55',
        strokeWidth: 1,
      }),
      text('transform-label', '01 / 线性变换 · 基向量决定整张网格', {
        x: 72,
        y: 170,
        width: 526,
        height: 36,
        fontSize: 23,
        fill: color.ink,
      }),
      text(
        'matrix',
        `A = [ ${a[0].map((v) => v.toFixed(2)).join('   ')} ; ${a[1].map((v) => v.toFixed(2)).join('   ')} ]`,
        { x: 82, y: 604, width: 510, height: 32, fontSize: 22, fill: color.teal },
      ),
      text('fit-label', '02 / QR 最小二乘 · 从带噪数据拟合直线', {
        x: 664,
        y: 167,
        width: 542,
        height: 36,
        fontSize: 23,
        fill: color.ink,
      }),
      text('opt-label', '03 / 共轭梯度 · 沿迭代轨迹走向最小值', {
        x: 664,
        y: 437,
        width: 542,
        height: 36,
        fontSize: 23,
        fill: color.ink,
      }),
    ];
    for (const [i, segment] of grid.entries()) {
      const points = transformPoints(affine, segment);
      nodes.push(
        path(`grid-${i}`, points.map(([x, y], j) => `${j ? 'L' : 'M'}${x} ${y}`).join(' '), {
          fill: 'transparent',
          stroke: '#294963',
          strokeWidth: 1.2,
        }),
      );
    }
    const basis = transformPoints(affine, [
      [0, 0],
      [3, 0],
      [0, 3],
    ]);
    for (const i of [1, 2]) {
      const [x, y] = basis[i],
        [ox, oy] = basis[0],
        angle = Math.atan2(y - oy, x - ox),
        c = i === 1 ? color.teal : color.violet;
      nodes.push(
        path(
          `basis-${i}`,
          `M${ox} ${oy}L${x} ${y} M${x - 13 * Math.cos(angle - 0.45)} ${y - 13 * Math.sin(angle - 0.45)}L${x} ${y}L${x - 13 * Math.cos(angle + 0.45)} ${y - 13 * Math.sin(angle + 0.45)}`,
          { fill: 'transparent', stroke: c, strokeWidth: 4, strokeCap: 'round' },
        ),
      );
    }
    const lineProgress = progress(ctx.frame, 70, 140),
      xy = (x: number, y: number) => [690 + x * 100, 357 - y * 34];
    nodes.push(
      path('fit-axes', 'M682 220V365H1044', {
        fill: 'transparent',
        stroke: '#344c68',
        strokeWidth: 1.5,
      }),
    );
    for (const [i, [x, y]] of measurements.entries()) {
      const [px, py] = xy(x, y),
        [, predicted] = xy(x, fit.solution[0] + fit.solution[1] * x);
      nodes.push(
        path(`residual-${i}`, `M${px} ${py}L${px} ${predicted}`, {
          fill: 'transparent',
          stroke: color.coral,
          strokeWidth: 1.5,
          opacity: lineProgress,
        }),
        ellipse(`point-${i}`, { x: px - 4, y: py - 4, width: 8, height: 8, fill: color.coral }),
      );
    }
    const start = xy(0, fit.solution[0]),
      end = xy(3 * lineProgress, fit.solution[0] + fit.solution[1] * 3 * lineProgress);
    nodes.push(
      path('fitted-line', `M${start[0]} ${start[1]}L${end[0]} ${end[1]}`, {
        fill: 'transparent',
        stroke: color.teal,
        strokeWidth: 3,
      }),
      text(
        'fit-result',
        `y = ${fit.solution[0].toFixed(3)} + ${fit.solution[1].toFixed(3)}x\n残差范数 ${fit.residualNorm.toFixed(4)}\n列主元 Householder QR`,
        {
          x: 1054,
          y: 241,
          width: 159,
          height: 120,
          fontSize: 17,
          lineHeight: 1.6,
          fill: color.muted,
        },
      ),
    );
    const ox = 782,
      oy = 562,
      scale = 44,
      optimum = optimize.solution,
      toCanvas = ([x, y]: readonly number[]) => [ox + x * scale, oy - y * scale];
    // Ellipses are constant-value contours of xᵀAx around the computed minimizer.
    for (const [index, radius] of [0.5, 1, 1.5, 2].entries()) {
      const points = Array.from({ length: 81 }, (_, i) => {
        const angle = (i * 2 * Math.PI) / 80,
          dx = Math.cos(angle),
          dy = Math.sin(angle),
          r = radius / Math.sqrt(4 * dx * dx + 2 * dx * dy + 3 * dy * dy);
        return toCanvas([optimum[0] + r * dx, optimum[1] + r * dy]);
      });
      nodes.push(
        path(
          `contour-${index}`,
          points.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' ') + 'Z',
          { fill: 'transparent', stroke: '#34506c', strokeWidth: 1.2 },
        ),
      );
    }
    const motion = progress(ctx.frame, 130, 170) * (optimize.steps.length - 1),
      at = Math.min(optimize.steps.length - 2, Math.floor(motion)),
      u = Math.min(1, motion - at),
      current = optimize.steps[at].solution.map(
        (v, i) => v + u * (optimize.steps[at + 1].solution[i] - v),
      ),
      trail = [
        ...optimize.steps.slice(0, at + 1).map((s) => toCanvas(s.solution)),
        toCanvas(current),
      ],
      [px, py] = toCanvas(current);
    nodes.push(
      path('optimization-path', trail.map(([x, y], i) => `${i ? 'L' : 'M'}${x} ${y}`).join(' '), {
        fill: 'transparent',
        stroke: color.violet,
        strokeWidth: 3,
        strokeCap: 'round',
      }),
      ellipse('optimizer', { x: px - 6, y: py - 6, width: 12, height: 12, fill: color.violet }),
      formula('objective', '\\min_x\\;\\frac12 x^T A x-b^T x', {
        x: 948,
        y: 497,
        width: 262,
        height: 42,
        fontSize: 22,
        fill: color.muted,
      }),
      text(
        'opt-result',
        `x* = (${optimum.map((v) => v.toFixed(4)).join(', ')})\n${optimize.iterations} 次迭代 · 残差 ${optimize.residualNorm.toExponential(1)}`,
        {
          x: 948,
          y: 544,
          width: 262,
          height: 72,
          fontSize: 19,
          lineHeight: 1.6,
          fill: color.muted,
        },
      ),
      text('footer', '纯函数帧求值 · 批量坐标变换 · 可复用分解 · 数值残差验证 · SDK / CLI / MCP', {
        x: 50,
        y: 680,
        width: 1180,
        height: 28,
        fontSize: 17,
        fill: color.muted,
      }),
    );
    return nodes;
  },
});
