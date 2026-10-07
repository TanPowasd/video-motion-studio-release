import { newNode, type Node } from '../core/model.js';
export function axes(
  id: string,
  width: number,
  height: number,
  options: { ticks?: number; color?: string } = {},
) {
  const ticks = options.ticks ?? 10,
    color = options.color ?? '#53617b';
  const nodes: Node[] = [
    newNode({
      id: `${id}/axes`,
      type: 'path',
      path: `M 0 ${height / 2} L ${width} ${height / 2} M ${width / 2} 0 L ${width / 2} ${height}`,
      fill: 'transparent',
      stroke: color,
      strokeWidth: 1.5,
    }),
  ];
  for (let i = 0; i <= ticks; i++) {
    const x = (i * width) / ticks;
    nodes.push(
      newNode({
        id: `${id}/tick-${i}`,
        type: 'path',
        path: `M ${x} ${height / 2 - 5} L ${x} ${height / 2 + 5}`,
        fill: 'transparent',
        stroke: color,
        strokeWidth: 1,
      }),
    );
  }
  return nodes;
}
export function diagram(
  id: string,
  labels: string[],
  edges: Array<[number, number]>,
  options: { width?: number; columns?: number; gap?: number } = {},
) {
  const columns = options.columns ?? 3,
    gap = options.gap ?? 30,
    width = options.width ?? 900,
    boxWidth = (width - gap * (columns - 1)) / columns,
    boxHeight = 90;
  const position = (i: number) => ({
    x: (i % columns) * (boxWidth + gap),
    y: Math.floor(i / columns) * (boxHeight + gap),
  });
  const nodes: Node[] = [];
  for (const [i, [a, b]] of edges.entries()) {
    const from = position(a),
      to = position(b),
      x1 = from.x + boxWidth / 2,
      y1 = from.y + boxHeight / 2,
      x2 = to.x + boxWidth / 2,
      y2 = to.y + boxHeight / 2;
    nodes.push(
      newNode({
        id: `${id}/edge-${i}`,
        type: 'path',
        path: `M ${x1} ${y1} L ${x2} ${y2}`,
        fill: 'transparent',
        stroke: '#697694',
        strokeWidth: 2,
      }),
    );
  }
  labels.forEach((label, i) => {
    const p = position(i);
    nodes.push(
      newNode({
        id: `${id}/box-${i}`,
        type: 'rect',
        ...p,
        width: boxWidth,
        height: boxHeight,
        fill: '#252e48',
        stroke: '#6779ab',
        strokeWidth: 1,
        radius: 12,
      }),
      newNode({
        id: `${id}/label-${i}`,
        type: 'text',
        text: label,
        x: p.x + 12,
        y: p.y + 26,
        width: boxWidth - 24,
        height: 50,
        fontSize: 25,
        fill: '#dbe3fa',
        align: 'center',
      }),
    );
  });
  return nodes;
}
export function stack(
  nodes: Node[],
  options: { direction?: 'row' | 'column'; gap?: number; x?: number; y?: number } = {},
) {
  let offset = 0;
  return nodes.map((node) => {
    const result = { ...node, x: options.x ?? 0, y: options.y ?? 0 };
    if (options.direction === 'row') {
      result.x += offset;
      offset += node.width + (options.gap ?? 16);
    } else {
      result.y += offset;
      offset += node.height + (options.gap ?? 16);
    }
    return result;
  });
}
export function cubicBezier(
  t: number,
  points: [
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
    { x: number; y: number },
  ],
) {
  const u = 1 - t;
  return {
    x:
      u ** 3 * points[0].x +
      3 * u * u * t * points[1].x +
      3 * u * t * t * points[2].x +
      t ** 3 * points[3].x,
    y:
      u ** 3 * points[0].y +
      3 * u * u * t * points[1].y +
      3 * u * t * t * points[2].y +
      t ** 3 * points[3].y,
  };
}
export function bubbleSortSteps(values: number[]) {
  const a = [...values],
    steps: Array<{ values: number[]; compare: [number, number]; swapped: boolean }> = [];
  for (let end = a.length - 1; end > 0; end--)
    for (let i = 0; i < end; i++) {
      const swapped = a[i] > a[i + 1];
      if (swapped) [a[i], a[i + 1]] = [a[i + 1], a[i]];
      steps.push({ values: [...a], compare: [i, i + 1], swapped });
    }
  return steps;
}
