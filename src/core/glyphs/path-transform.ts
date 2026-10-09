import { VmotionError } from '../model.js';

/** x' = a·x + c·y + e, y' = b·x + d·y + f (canvas/DOMMatrix order). */
export type Affine = [number, number, number, number, number, number];
export const identity: Affine = [1, 0, 0, 1, 0, 0];
export function multiply(m: Affine, n: Affine): Affine {
  // m ∘ n : apply n first, then m
  return [
    m[0] * n[0] + m[2] * n[1],
    m[1] * n[0] + m[3] * n[1],
    m[0] * n[2] + m[2] * n[3],
    m[1] * n[2] + m[3] * n[3],
    m[0] * n[4] + m[2] * n[5] + m[4],
    m[1] * n[4] + m[3] * n[5] + m[5],
  ];
}
export const apply = (m: Affine, x: number, y: number): [number, number] => [
  m[0] * x + m[2] * y + m[4],
  m[1] * x + m[3] * y + m[5],
];
/** Deterministic number formatting for path output. */
export const fmt = (v: number) => {
  const r = Math.round(v * 100) / 100;
  return Object.is(r, -0) ? '0' : String(r);
};

const arity: Record<string, number> = { M: 2, L: 2, H: 1, V: 1, C: 6, S: 4, Q: 4, T: 2, Z: 0 };

/** Tokenize SVG path data into [command, numbers[]] tuples (no arcs). */
export function tokenizePath(d: string): Array<[string, number[]]> {
  const out: Array<[string, number[]]> = [],
    re = /([MmLlHhVvCcSsQqTtZz])|([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/g;
  let command = '',
    numbers: number[] = [],
    match: RegExpExecArray | null,
    consumed = 0;
  const flush = () => {
    if (!command) {
      if (numbers.length) throw new VmotionError('GLYPH_PATH', 'Path data must start with a command');
      return;
    }
    const upper = command.toUpperCase(),
      n = arity[upper];
    if (n === 0) {
      out.push([command, []]);
    } else {
      if (!numbers.length || numbers.length % n)
        throw new VmotionError('GLYPH_PATH', `Wrong number of values for ${command}`, { d });
      for (let i = 0; i < numbers.length; i += n) {
        // Implicit repeats after M are line-tos.
        const c = i && upper === 'M' ? (command === 'M' ? 'L' : 'l') : command;
        out.push([c, numbers.slice(i, i + n)]);
      }
    }
    numbers = [];
  };
  while ((match = re.exec(d))) {
    if (d.slice(consumed, match.index).replace(/[\s,]/g, ''))
      throw new VmotionError('GLYPH_PATH', 'Invalid path data', { d });
    consumed = match.index + match[0].length;
    if (match[1]) {
      flush();
      command = match[1];
    } else numbers.push(Number(match[2]));
  }
  if (d.slice(consumed).replace(/[\s,]/g, ''))
    throw new VmotionError('GLYPH_PATH', 'Invalid path data', { d });
  flush();
  if (out.length > 4096) throw new VmotionError('GLYPH_PATH', 'Path exceeds 4096 segments');
  return out;
}

/** Transform path data into absolute M/L/C/Q/Z commands. Exact for affine maps. */
export function transformPathData(d: string, m: Affine): string {
  const parts: string[] = [];
  let x = 0,
    y = 0,
    sx = 0,
    sy = 0,
    lastC: [number, number] | undefined,
    lastQ: [number, number] | undefined;
  const P = (px: number, py: number) => {
    const [tx, ty] = apply(m, px, py);
    return `${fmt(tx)} ${fmt(ty)}`;
  };
  for (const [command, v] of tokenizePath(d)) {
    const rel = command === command.toLowerCase() && command !== 'Z' && command !== 'z',
      ox = rel ? x : 0,
      oy = rel ? y : 0,
      c = command.toUpperCase();
    let nextC: [number, number] | undefined, nextQ: [number, number] | undefined;
    switch (c) {
      case 'M':
        x = ox + v[0];
        y = oy + v[1];
        sx = x;
        sy = y;
        parts.push(`M${P(x, y)}`);
        break;
      case 'L':
      case 'H':
      case 'V':
        if (c === 'L') {
          x = ox + v[0];
          y = oy + v[1];
        } else if (c === 'H') x = ox + v[0];
        else y = oy + v[0];
        parts.push(`L${P(x, y)}`);
        break;
      case 'C': {
        const x1 = ox + v[0], y1 = oy + v[1], x2 = ox + v[2], y2 = oy + v[3];
        x = ox + v[4];
        y = oy + v[5];
        parts.push(`C${P(x1, y1)} ${P(x2, y2)} ${P(x, y)}`);
        nextC = [x2, y2];
        break;
      }
      case 'S': {
        const x1 = lastC ? 2 * x - lastC[0] : x,
          y1 = lastC ? 2 * y - lastC[1] : y,
          x2 = ox + v[0],
          y2 = oy + v[1];
        x = ox + v[2];
        y = oy + v[3];
        parts.push(`C${P(x1, y1)} ${P(x2, y2)} ${P(x, y)}`);
        nextC = [x2, y2];
        break;
      }
      case 'Q': {
        const x1 = ox + v[0], y1 = oy + v[1];
        x = ox + v[2];
        y = oy + v[3];
        parts.push(`Q${P(x1, y1)} ${P(x, y)}`);
        nextQ = [x1, y1];
        break;
      }
      case 'T': {
        const x1 = lastQ ? 2 * x - lastQ[0] : x,
          y1 = lastQ ? 2 * y - lastQ[1] : y;
        x = ox + v[0];
        y = oy + v[1];
        parts.push(`Q${P(x1, y1)} ${P(x, y)}`);
        nextQ = [x1, y1];
        break;
      }
      case 'Z':
        x = sx;
        y = sy;
        parts.push('Z');
        break;
    }
    lastC = nextC;
    lastQ = nextQ;
  }
  return parts.join('');
}

/**
 * Polyline → path data with rounded interior corners (quadratic fillets).
 * roundness 0 keeps sharp corners; 1 cuts half of the shorter adjacent segment.
 */
export function polylinePath(points: Array<[number, number]>, roundness: number, closed = false) {
  const n = points.length;
  if (n < 2) return '';
  const corner = (i: number) => {
    const p = points[i],
      a = points[(i - 1 + n) % n],
      b = points[(i + 1) % n],
      la = Math.hypot(a[0] - p[0], a[1] - p[1]),
      lb = Math.hypot(b[0] - p[0], b[1] - p[1]),
      cut = roundness * 0.5 * Math.min(la, lb);
    if (!roundness || cut < 0.5 || !la || !lb) return undefined;
    return {
      p1: [p[0] + ((a[0] - p[0]) * cut) / la, p[1] + ((a[1] - p[1]) * cut) / la] as const,
      p2: [p[0] + ((b[0] - p[0]) * cut) / lb, p[1] + ((b[1] - p[1]) * cut) / lb] as const,
      p,
    };
  };
  const parts: string[] = [];
  if (closed) {
    const first = corner(0);
    const start = first ? first.p2 : points[0];
    parts.push(`M${fmt(start[0])} ${fmt(start[1])}`);
    for (let i = 1; i <= n; i++) {
      const idx = i % n,
        c = corner(idx);
      if (c)
        parts.push(
          `L${fmt(c.p1[0])} ${fmt(c.p1[1])}Q${fmt(c.p[0])} ${fmt(c.p[1])} ${fmt(c.p2[0])} ${fmt(c.p2[1])}`,
        );
      else parts.push(`L${fmt(points[idx][0])} ${fmt(points[idx][1])}`);
    }
    parts.push('Z');
    return parts.join('');
  }
  parts.push(`M${fmt(points[0][0])} ${fmt(points[0][1])}`);
  for (let i = 1; i < n - 1; i++) {
    const c = corner(i);
    if (c)
      parts.push(
        `L${fmt(c.p1[0])} ${fmt(c.p1[1])}Q${fmt(c.p[0])} ${fmt(c.p[1])} ${fmt(c.p2[0])} ${fmt(c.p2[1])}`,
      );
    else parts.push(`L${fmt(points[i][0])} ${fmt(points[i][1])}`);
  }
  parts.push(`L${fmt(points[n - 1][0])} ${fmt(points[n - 1][1])}`);
  return parts.join('');
}
