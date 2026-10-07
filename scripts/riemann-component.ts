import { defineComponent, node, type Node, type ComponentContext } from '@vmotion/sdk';
import rawCaptions from './captions.json';
type Cue = { start: number; end: number; text: string };
const captions = rawCaptions as Record<string, Cue[]>;
const C = {
  ink: '#21304d',
  muted: '#758299',
  blue: '#4265b4',
  gold: '#ca9451',
  paper: '#faf8f3',
  line: '#deded9',
  red: '#ba6364',
  green: '#568e79',
};
const T = (
  id: string,
  text: string,
  x: number,
  y: number,
  size = 32,
  width = 1680,
  color = C.ink,
  weight = 400,
) =>
  node({
    id,
    type: 'text',
    text,
    x,
    y,
    width,
    height: 150,
    fontSize: size,
    fontWeight: weight,
    fontFamily: 'Microsoft YaHei',
    fill: color,
  });
const R = (
  id: string,
  x: number,
  y: number,
  width: number,
  height: number,
  fill = C.paper,
  radius = 0,
) => node({ id, type: 'rect', x, y, width, height, fill, radius });
const P = (id: string, d: string, color = C.blue, strokeWidth = 3) =>
  node({ id, type: 'path', path: d, fill: 'transparent', stroke: color, strokeWidth });
const E = (id: string, x: number, y: number, r: number, color = C.blue) =>
  node({ id, type: 'ellipse', x: x - r, y: y - r, width: r * 2, height: r * 2, fill: color });
const F = (id: string, text: string, x: number, y: number, size = 56, width = 1680) =>
  node({ id, type: 'formula', text, x, y, width, height: 150, fontSize: size, fill: C.ink });
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const reveal = (s: number, offset = 0, duration = 2) => clamp((s - offset) / duration);
const primes: number[] = [];
const primeCounts: number[] = [];
const composite = new Uint8Array(3001);
let count = 0;
for (let n = 0; n <= 3000; n++) {
  if (n >= 2 && !composite[n]) {
    primes.push(n);
    count++;
    for (let k = n * n; k <= 3000; k += n) composite[k] = 1;
  }
  primeCounts.push(count);
}
const li: number[] = Array(3001).fill(0);
for (let x = 3; x <= 3000; x++) {
  const a = x - 1,
    b = x,
    m = (a + b) / 2;
  li[x] = li[x - 1] + (1 / Math.log(a) + 4 / Math.log(m) + 1 / Math.log(b)) / 6;
}
export function zeta(sigma: number, t: number) {
  const re: number[] = [],
    im: number[] = [];
  for (let n = 1; n <= 180; n++) {
    const length = n ** -sigma,
      angle = -t * Math.log(n);
    re.push(length * Math.cos(angle));
    im.push(length * Math.sin(angle));
  }
  let er = 0,
    ei = 0;
  for (let k = 0; k < 180; k++) {
    er += re[0] / 2;
    ei += im[0] / 2;
    for (let j = 0; j < 179 - k; j++) {
      re[j] = (re[j] - re[j + 1]) / 2;
      im[j] = (im[j] - im[j + 1]) / 2;
    }
  }
  const radius = 2 ** (1 - sigma),
    angle = -t * Math.log(2),
    dr = 1 - radius * Math.cos(angle),
    di = -radius * Math.sin(angle),
    den = dr * dr + di * di;
  return { re: (er * dr + ei * di) / den, im: (ei * dr - er * di) / den };
}
const zeroHeights = [
  14.134725141734693, 21.022039638771555, 25.01085758014569, 30.424876125859513, 32.93506158773919,
];
const zetaCurve = Array.from({ length: 701 }, (_, i) => {
  const t = (i * 35) / 700,
    z = zeta(0.5, t);
  return { t, value: Math.hypot(z.re, z.im) };
});
function axes(x: number, y: number, w: number, h: number, xlabel: string, ylabel: string) {
  return [
    P('axis', `M ${x} ${y - h} L ${x} ${y} L ${x + w} ${y}`, C.muted, 2),
    T('axis-x', xlabel, x + w - 140, y + 22, 24, 180, C.muted),
    T('axis-y', ylabel, x - 20, y - h - 43, 24, 300, C.muted),
    ...Array.from({ length: 5 }, (_, i) =>
      P(`grid-${i}`, `M ${x} ${y - (i * h) / 4} L ${x + w} ${y - (i * h) / 4}`, C.line, 1),
    ),
  ];
}
function graphPath(values: number[], x: number, y: number, w: number, h: number, max: number) {
  return values
    .map((v, i) => `${i ? 'L' : 'M'} ${x + (i * w) / (values.length - 1)} ${y - (v / max) * h}`)
    .join(' ');
}
function primePlot(seconds: number, showLi = false, showError = false) {
  const maximum = 1000,
    values = primeCounts.slice(2, maximum + 1),
    smooth = showLi
      ? li.slice(2, maximum + 1)
      : Array.from({ length: maximum - 1 }, (_, i) => (i + 2) / Math.log(i + 2));
  if (showError) {
    const error = values.map((v, i) => v - smooth[i]),
      nodes = axes(210, 720, 1470, 350, 'x', 'π(x) − Li(x)');
    nodes.push(
      P('error-zero', 'M 210 545 L 1680 545', C.muted, 1),
      P(
        'error',
        graphPath(
          error.map((v) => v + 12),
          210,
          720,
          1470,
          350,
          24,
        ),
        C.blue,
        3,
      ),
    );
    return nodes;
  }
  const nodes = axes(210, 750, 1470, 390, 'x', '素数个数'),
    n = Math.floor(40 + reveal(seconds, 0.5, 14) * (maximum - 40));
  nodes.push(
    P('prime-count', graphPath(values, 210, 750, 1470, 390, 180), C.blue, 3),
    P('approximation', graphPath(smooth, 210, 750, 1470, 390, 180), C.gold, 3),
    P(
      'scan',
      `M ${210 + ((n - 2) / 998) * 1470} 350 L ${210 + ((n - 2) / 998) * 1470} 750`,
      C.muted,
      1,
    ),
    E('marker', 210 + ((n - 2) / 998) * 1470, 750 - (primeCounts[n] / 180) * 390, 7),
    T('legend-exact', 'π(x)：真实素数计数', 250, 285, 28, 600, C.blue),
    T(
      'legend-approx',
      showLi ? 'Li(x)：对数积分' : 'x / ln x：平均近似',
      1090,
      285,
      28,
      650,
      C.gold,
    ),
    T('count-readout', `x = ${n}     π(x) = ${primeCounts[n]}`, 950, 760, 32, 650),
  );
  return nodes;
}
function zeroMap(seconds: number, kind: string) {
  const x = (sigma: number) => 460 + (sigma + 0.5) * 500,
    y = (t: number) => 535 - t * 7.2;
  const nodes: Node[] = [
    R('strip', x(0), 265, x(1) - x(0), 550, '#e5ecf7', 12),
    P('imaginary-axis', `M ${x(0)} 265 L ${x(0)} 825`, C.muted, 1),
    P('real-axis', `M 140 535 L 1740 535`, C.muted, 2),
    P('critical-line', `M ${x(0.5)} 260 L ${x(0.5)} 825`, C.blue, 4),
    T('critical-label', 'Re(s) = 1/2', x(0.5) + 18, 280, 30, 330, C.blue),
    T('strip-label', '临界带', x(0) + 18, 790, 24, 250, C.blue),
    T('real-label', '实部 σ', 1600, 552, 24, 180, C.muted),
    T('imag-label', '虚部 t', x(0.5) - 165, 225, 24, 220, C.muted),
  ];
  for (const sigma of [-0.5, 0, 0.5, 1, 1.5])
    nodes.push(T(`sigma-${sigma}`, String(sigma), x(sigma) - 35, 550, 22, 80, C.muted));
  for (const [i, height] of zeroHeights.entries()) {
    if (reveal(seconds, 1, 6) < i / 5) continue;
    nodes.push(
      E(`zero-${i}`, x(0.5), y(height), 7, C.blue),
      E(`conjugate-${i}`, x(0.5), y(-height), 7, C.blue),
    );
    if (i < 3)
      nodes.push(T(`height-${i}`, height.toFixed(5), x(0.5) + 30, y(height) - 10, 21, 250, C.blue));
  }
  if (kind === 'zeros')
    nodes.push(T('trivial', '平凡零点：−2，−4，−6，…（位于更左侧）', 150, 860, 25, 1500, C.muted));
  if (kind === 'symmetry') {
    const points = [
      [0.24, 22],
      [0.76, 22],
      [0.24, -22],
      [0.76, -22],
    ];
    for (const [i, [sigma, t]] of points.entries())
      nodes.push(E(`hypothetical-${i}`, x(sigma), y(t), 10, C.red));
    nodes.push(
      T('hypothetical-label', '红点是“假想反例”，不代表已发现的零点', 150, 832, 24, 1620, C.red),
    );
  }
  return nodes;
}
function visual(id: string, s: number, duration: number): Node[] {
  if (id === 'opening' || id === 'ending') {
    const nodes: Node[] = [
      P('line', 'M 1160 400 L 1160 830', C.blue, 4),
      T('half', '1/2', 1120, 835, 38, 160, C.blue),
      T('left-topic', '整数世界', 220, 345, 38, 650, C.muted),
      T('right-topic', '复数世界', 1260, 345, 38, 500, C.muted),
      F('center-equation', '\\mathrm{Re}(\\rho)=\\frac12', 830, 245, 56, 950),
    ];
    primes
      .slice(0, 24)
      .forEach((p, i) =>
        nodes.push(
          T(
            `prime-${i}`,
            String(p),
            220 + (i % 6) * 95,
            435 + Math.floor(i / 6) * 75,
            34,
            90,
            i % 5 === 0 ? C.gold : C.ink,
          ),
        ),
      );
    zeroHeights.forEach((h, i) =>
      nodes.push(E(`zero-${i}`, 1160, 460 + i * 65, 7 + Math.sin(s + i) * 2, C.blue)),
    );
    nodes.push(T('bridge-label', '素数的波动  ←→  零点的位置', 250, 840, 34, 1200, C.ink));
    return nodes;
  }
  if (id === 'primes') {
    const nodes: Node[] = [];
    for (let n = 1; n <= 60; n++) {
      const prime = n >= 2 && !composite[n],
        i = n - 1,
        x = 180 + (i % 12) * 132,
        y = 280 + Math.floor(i / 12) * 105;
      nodes.push(
        R(`cell-${n}`, x, y, 108, 76, prime ? '#e3ebf9' : '#edece7', 9),
        T(
          `number-${n}`,
          String(n),
          x + 26,
          y + 18,
          32,
          90,
          prime ? C.blue : C.muted,
          prime ? 600 : 400,
        ),
      );
    }
    nodes.push(F('factor', '12=2^2\\times3\\qquad30=2\\times3\\times5', 370, 845, 50, 1320));
    return nodes;
  }
  if (id === 'counting')
    return [...primePlot(s), F('definition', '\\pi(10)=4\\qquad\\pi(100)=25', 610, 825, 48, 900)];
  if (id === 'pnt')
    return [
      ...primePlot(s),
      F('pnt', '\\frac{\\pi(x)}{x/\\ln x}\\longrightarrow1', 540, 825, 48, 1250),
    ];
  if (id === 'error')
    return [
      ...primePlot(s, true, s > duration * 0.56),
      F('li', '\\mathrm{Li}(x)=\\int_2^x\\frac{dt}{\\ln t}', 585, 815, 46, 1150),
    ];
  if (id === 'series') {
    const nodes: Node[] = [
      F('series', '\\zeta(s)=\\sum_{n=1}^{\\infty}\\frac{1}{n^s}', 340, 290, 72, 1500),
      T('condition', '收敛条件：Re(s) > 1', 1040, 470, 32, 680, C.blue),
      F(
        'basel',
        '\\zeta(2)=1+\\frac14+\\frac19+\\frac1{16}+\\cdots=\\frac{\\pi^2}{6}',
        280,
        650,
        56,
        1500,
      ),
    ];
    for (let i = 1; i <= 18; i++) {
      const h = 210 / (i * i);
      nodes.push(R(`term-${i}`, 230 + (i - 1) * 82, 635 - h, 46, h, C.blue, 3));
    }
    return nodes;
  }
  if (id === 'euler')
    return [
      F('product', '\\zeta(s)=\\prod_{p\\;\\mathrm{prime}}\\frac{1}{1-p^{-s}}', 330, 275, 70, 1480),
      F('geometric', '\\frac{1}{1-p^{-s}}=1+p^{-s}+p^{-2s}+\\cdots', 300, 480, 53, 1500),
      ...primes
        .slice(0, 9)
        .flatMap((p, i) => [
          R(`prime-card-${p}`, 240 + i * 163, 680, 125, 105, '#e5ecf7', 12),
          T(`prime-p-${p}`, String(p), 270 + i * 163, 695, 42, 95, C.blue, 600),
        ]),
      T('unique', '唯一素因数分解：展开乘积时，每个整数恰好出现一次', 240, 825, 32, 1600),
    ];
  if (id === 'complex')
    return [
      P('complex-axes', 'M 320 680 L 1540 680 M 650 260 L 650 810', C.muted, 2),
      R('projection', 650, 464, 465, 216, '#edf1f8'),
      P('point-guide', 'M 650 464 L 1115 464 L 1115 680', C.line, 2),
      E('point', 1115, 464, 12),
      T('point-label', 's = σ + it', 1150, 432, 46, 500, C.blue),
      T('sigma', '实部 σ', 1050, 710, 34, 450),
      T('t', '虚部 t', 435, 448, 34, 250),
      F('imaginary', 'i^2=-1', 300, 820, 54, 900),
    ];
  if (id === 'vectors') {
    const nodes = axes(300, 750, 1300, 440, '实部', '虚部');
    let px = 520,
      py = 515;
    const t = 2 + Math.sin(s / 4) * 2;
    for (let n = 1; n <= 12; n++) {
      const r = 250 / n ** 2,
        a = -t * Math.log(n),
        nx = px + r * Math.cos(a),
        ny = py - r * Math.sin(a);
      nodes.push(
        P(`vector-${n}`, `M ${px} ${py} L ${nx} ${ny}`, n % 2 ? C.blue : C.gold, 5),
        E(`tip-${n}`, nx, ny, 3, n % 2 ? C.blue : C.gold),
      );
      px = nx;
      py = ny;
    }
    nodes.push(
      E('sum', px, py, 10, C.red),
      F('power', 'n^{-s}=n^{-\\sigma}e^{-it\\ln n}', 340, 245, 60, 1350),
      T('vector-caption', 'σ = 2；前 12 项的收敛区域示意', 400, 825, 30, 1300, C.muted),
    );
    return nodes;
  }
  if (id === 'continuation')
    return [
      R('known', 260, 285, 520, 330, '#e4edf5', 18),
      R('extended', 880, 285, 770, 330, '#f0e8db', 18),
      T('known-label', '原级数的定义区', 305, 325, 37, 450, C.blue),
      F('known-region', '\\mathrm{Re}(s)>1', 310, 440, 55, 470),
      T('extended-label', '解析延拓后的函数', 945, 325, 37, 670, C.gold),
      T('extended-region', '复平面；s = 1 是极点', 940, 455, 31, 620),
      P('continuation-arrow', 'M 790 450 L 860 450 M 840 430 L 860 450 L 840 470', C.gold, 4),
      F('regularized', '\\zeta(-1)=-\\frac1{12}', 490, 705, 70, 1250),
      T('not-sum', '不等于“1 + 2 + 3 + … 作为普通求和得到 −1/12”', 240, 845, 31, 1500, C.red),
    ];
  if (['zeros', 'statement', 'symmetry'].includes(id)) {
    const nodes = zeroMap(s, id);
    if (id === 'statement')
      nodes.push(
        F(
          'rh',
          '\\zeta(\\rho)=0,\\quad0<\\mathrm{Re}(\\rho)<1\\quad\\Rightarrow\\quad\\mathrm{Re}(\\rho)=\\frac12',
          240,
          850,
          36,
          1620,
        ),
      );
    if (id === 'symmetry')
      nodes.push(
        F(
          'xi',
          '\\xi(s)=\\tfrac12s(s-1)\\pi^{-s/2}\\Gamma(s/2)\\zeta(s),\\quad\\xi(s)=\\xi(1-s)',
          210,
          874,
          30,
          1700,
        ),
      );
    return nodes;
  }
  if (id === 'numeric') {
    const nodes = axes(210, 740, 1490, 390, 't', '|ζ(1/2 + it)|');
    nodes.push(
      P(
        'zeta-magnitude',
        graphPath(
          zetaCurve.map((p) => p.value),
          210,
          740,
          1490,
          390,
          5,
        ),
        C.blue,
        3,
      ),
    );
    zeroHeights.forEach((t, i) => {
      const x = 210 + (t / 35) * 1490;
      nodes.push(
        E(`zero-mark-${i}`, x, 740, 7, C.gold),
        T(`zero-height-${i}`, t.toFixed(3), x - 55, 766, 20, 140, C.gold),
      );
    });
    const t = 35 * reveal(s, 2, Math.max(10, duration - 5));
    const z = zeta(0.5, t);
    nodes.push(
      P('zeta-scan', `M ${210 + (t / 35) * 1490} 330 L ${210 + (t / 35) * 1490} 740`, C.muted, 1),
      E('zeta-point', 210 + (t / 35) * 1490, 740 - (Math.hypot(z.re, z.im) / 5) * 390, 8, C.blue),
      T(
        'numerical-warning',
        '数值图像；不是证明。标注为前几个正虚部零点。',
        230,
        845,
        30,
        1550,
        C.muted,
      ),
    );
    return nodes;
  }
  if (id === 'bridge')
    return [
      F('psi', '\\psi(x)=\\sum_{p^k\\le x}\\ln p', 330, 275, 62, 1500),
      F('explicit', '\\psi(x)\\approx x-\\sum_{\\rho}\\frac{x^{\\rho}}{\\rho}', 360, 505, 68, 1400),
      T('trend', 'x：平均趋势', 315, 765, 38, 610, C.gold),
      T('oscillations', '零点项：振荡修正', 1060, 765, 38, 700, C.blue),
      T(
        'explicit-note',
        '结构示意：省略常数修正与严格的求和 / 截断规定',
        230,
        860,
        27,
        1500,
        C.muted,
      ),
    ];
  if (id === 'half') {
    const nodes = axes(260, 770, 1380, 350, 'x', '单项幅度尺度');
    const xs = Array.from({ length: 300 }, (_, i) => 1 + (i * 999) / 299);
    nodes.push(
      P(
        'sqrt-scale',
        graphPath(
          xs.map((x) => Math.sqrt(x)),
          260,
          770,
          1380,
          350,
          260,
        ),
        C.blue,
        4,
      ),
      P(
        'larger-scale',
        graphPath(
          xs.map((x) => x ** 0.8),
          260,
          770,
          1380,
          350,
          260,
        ),
        C.red,
        4,
      ),
      F('zero-power', 'x^{\\rho}=x^{\\beta}e^{i\\gamma\\ln x}', 400, 260, 67, 1400),
      T('sqrt-label', 'β = 1/2：√x', 450, 780, 32, 650, C.blue),
      T('larger-label', 'β = 0.8：更快增长的假想情况', 1050, 445, 30, 680, C.red),
      T('scale-note', '比较单个零点项的结构，不是实际素数误差的模拟', 230, 865, 27, 1500, C.muted),
    );
    return nodes;
  }
  if (id === 'bound')
    return [
      F(
        'bound',
        '\\mathrm{RH}\\quad\\Longleftrightarrow\\quad\\pi(x)=\\mathrm{Li}(x)+O(\\sqrt{x}\\ln x)',
        240,
        330,
        62,
        1650,
      ),
      F(
        'constant',
        '|\\pi(x)-\\mathrm{Li}(x)|\\le C\\sqrt{x}\\ln x\\qquad(x\\ge x_0)',
        275,
        570,
        51,
        1600,
      ),
      R('constant-card', 250, 760, 1420, 120, '#e6ecf7', 12),
      T('constant-note', 'C 和 x₀ 固定，不随 x 改变；这是渐近误差界。', 300, 795, 31, 1320, C.blue),
    ];
  if (id === 'proof') {
    const nodes: Node[] = [
      R('verified', 240, 310, 900, 350, '#e5edf4', 15),
      R('unknown', 1190, 310, 480, 350, '#efe9df', 15),
      T('verified-title', '有限区域：严格检验', 285, 355, 37, 820, C.blue),
      T('unknown-title', '更高处：无限', 1235, 355, 37, 400, C.gold),
      P('height-axis', 'M 240 725 L 1680 725', C.muted, 2),
      T('height-label', '已检查到的高度 T', 900, 745, 31, 690, C.muted),
      T('quantifier', '“检验很多”  ≠  “证明每一个”', 380, 820, 49, 1250),
    ];
    for (let i = 0; i < 24; i++)
      nodes.push(E(`checked-${i}`, 310 + (i % 8) * 100, 450 + Math.floor(i / 8) * 65, 5, C.blue));
    nodes.push(T('unknown-question', '?', 1340, 440, 115, 200, C.gold));
    return nodes;
  }
  if (id === 'known')
    return [
      R('known-card', 240, 290, 1450, 530, '#e7edf3', 20),
      T('known-1', '01  非平凡零点位于临界带', 320, 340, 43, 1300, C.blue),
      T('known-2', '02  关于实轴与临界线对称', 320, 460, 43, 1300, C.blue),
      T('known-3', '03  临界线上有无穷多个零点', 320, 580, 43, 1300, C.blue),
      T('unknown-all', '? 全部非平凡零点都在临界线上', 320, 715, 41, 1320, C.red),
    ];
  if (id === 'meaning')
    return [
      R('meaning-1', 235, 290, 1450, 165, '#e4edf5', 15),
      T('meaning-main', '更精确地控制素数分布误差', 295, 340, 44, 1300, C.blue),
      R('meaning-2', 235, 505, 1450, 165, '#eee8de', 15),
      T('meaning-conditional', '将许多条件性结论变为无条件结论', 295, 555, 42, 1300, C.gold),
      T(
        'misconception',
        '不等于：即时列出所有素数，或让密码体系自动失效。',
        260,
        800,
        32,
        1450,
        C.muted,
      ),
    ];
  return [];
}
const titles: Record<string, [string, string]> = {
  opening: ['黎曼猜想', '一条直线，牵动所有素数'],
  primes: ['整数的原子', '01 / 素数'],
  counting: ['先数一数素数', '02 / 素数计数函数'],
  pnt: ['杂乱之中，有一个平均规律', '03 / 素数定理'],
  error: ['真正的问题，是误差', '04 / 从平均到波动'],
  series: ['把整数装进一个函数', '05 / 黎曼 ζ 函数'],
  euler: ['整数之和，变成素数之积', '06 / 欧拉乘积'],
  complex: ['把输入放进复平面', '07 / s = σ + it'],
  vectors: ['长度与旋转，两种作用', '08 / 复数次幂的直觉'],
  continuation: ['越过级数的边界', '09 / 解析延拓'],
  zeros: ['零点在哪里？', '10 / 平凡零点与临界带'],
  statement: ['猜想的完整陈述', '11 / 临界线'],
  symmetry: ['对称性，不等于都在中间', '12 / 函数方程'],
  numeric: ['沿临界线观察函数', '13 / 数值图像'],
  bridge: ['零点怎样影响素数？', '14 / 显式公式的结构'],
  half: ['为什么偏偏是二分之一？', '15 / 振荡的幅度尺度'],
  bound: ['把直觉，写成误差界', '16 / 一个等价表述'],
  proof: ['验证很多，仍然不是证明', '17 / 有限与无限'],
  known: ['我们已经知道什么？', '18 / 已知结果与未知边界'],
  meaning: ['如果它是真的，会改变什么？', '19 / 意义与误解'],
  ending: ['一条直线，仍等待证明', '20 / 回看这座桥'],
};
export default defineComponent({
  name: '黎曼猜想 · 科普影片',
  parameters: {
    chapter: { type: 'string', default: 'opening' },
    duration: { type: 'number', default: 40, min: 1, max: 1000 },
  },
  render(ctx: ComponentContext, params) {
    const id = String(params.chapter),
      duration = Number(params.duration),
      [title, kicker] = titles[id] ?? titles.opening,
      s = ctx.seconds;
    const fade = Math.min(reveal(s, 0, 0.7), clamp((duration - s) / 0.6));
    const cue = (captions[id] ?? []).find((c) => s >= c.start && s < c.end);
    const nodes: Node[] = [
      T('kicker', kicker, 120, 72, 23, 1690, C.muted, 500),
      T('title', title, 118, 112, 58, 1730, C.ink, 600),
      P('header-rule', 'M 120 205 L 1800 205', C.line, 1),
      ...visual(id, s, duration),
      P('footer-rule', 'M 120 1040 L 1800 1040', C.line, 1),
      R('progress', 120, 1040, 1680 * clamp(s / duration), 3, C.blue),
      T('footer-left', 'VMOTION / 数学科普', 120, 1056, 15, 900, C.muted),
      T(
        'footer-right',
        '资料：Clay Mathematics Institute · NIST DLMF',
        1110,
        1056,
        15,
        700,
        C.muted,
      ),
    ];
    if (cue)
      nodes.push(
        R('caption-bg', 95, 945, 1730, 88, '#eeeee8', 12),
        T('caption', cue.text, 130, 960, 31, 1660, C.ink, 400),
      );
    return [
      node({ id: 'content', type: 'group', opacity: fade, y: (1 - reveal(s, 0, 0.8)) * 15 }),
      ...nodes.map((n) => ({ ...n, parentId: 'content' })),
    ];
  },
});
