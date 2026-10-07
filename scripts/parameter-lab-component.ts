import { defineComponent, rect, path, text, group, linearGradient } from '@vmotion/sdk';
export default defineComponent({
  name: '可编辑数据组件',
  parameters: {
    mode: { type: 'enum', label: '图表类型', options: ['bar', 'line'], default: 'bar' },
    showLabels: { type: 'boolean', label: '显示标签', default: true },
    origin: { type: 'vec2', label: '图表位置', default: { x: 190, y: 230 }, min: 0, max: 1280 },
    data: {
      type: 'array',
      label: '数据',
      minLength: 1,
      maxLength: 12,
      items: {
        type: 'object',
        properties: {
          label: { type: 'string', label: '标签', default: '新数据' },
          value: { type: 'number', label: '数值', default: 50, min: 0, max: 100 },
        },
      },
      default: [
        { label: '素数', value: 30 },
        { label: '复数', value: 62 },
        { label: '函数', value: 45 },
        { label: '动画', value: 84 },
      ],
    },
    style: {
      type: 'object',
      label: '样式',
      properties: {
        accent: { type: 'color', label: '主题色', default: '#79b6ff' },
        line: {
          type: 'object',
          label: '线条',
          properties: { width: { type: 'number', label: '宽度', default: 4, min: 1, max: 20 } },
        },
      },
    },
  },
  render(ctx, p) {
    const nodes = [
      rect('background', {
        width: 1280,
        height: 720,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, ['#0b1021', '#10243a']),
      }),
      text('label', 'VMOTION / STRUCTURED PARAMETERS', {
        x: 72,
        y: 42,
        width: 1100,
        height: 40,
        fontSize: 18,
        fill: '#849ebf',
      }),
      text('heading', '数据和布局，都能成为动画参数', {
        x: 72,
        y: 92,
        width: 1100,
        height: 100,
        fontSize: 48,
        fontWeight: 600,
        fill: '#e0ebff',
      }),
      text('footer', '枚举 · 布尔 · 向量 · 数组对象 · 嵌套关键帧', {
        x: 72,
        y: 654,
        width: 1100,
        height: 38,
        fontSize: 20,
        fill: '#92a8c6',
      }),
    ];
    const chart = [],
      width = 850,
      height = 310,
      gap = width / p.data.length;
    chart.push(
      path('axis', `M 0 0 L 0 ${height} L ${width} ${height}`, {
        fill: 'transparent',
        stroke: '#456180',
        strokeWidth: 2,
      }),
    );
    if (p.mode === 'line')
      chart.push(
        path(
          'curve',
          p.data
            .map(
              (entry, i) =>
                `${i ? 'L' : 'M'} ${gap * (i + 0.5)} ${height * (1 - entry.value / 100)}`,
            )
            .join(' '),
          { fill: 'transparent', stroke: p.style.accent, strokeWidth: p.style.line.width },
        ),
      );
    p.data.forEach((entry, i) => {
      const h = (height * entry.value) / 100,
        x = gap * i + gap * 0.16;
      if (p.mode === 'bar')
        chart.push(
          rect('bar-' + i, {
            x,
            y: height - h,
            width: gap * 0.68,
            height: h,
            radius: 8,
            fill: p.style.accent,
          }),
        );
      if (p.showLabels) {
        chart.push(
          text('name-' + i, entry.label, {
            x: gap * i,
            y: height + 16,
            width: gap,
            height: 42,
            align: 'center',
            fontSize: 22,
            fill: '#b6cbe6',
          }),
          text('value-' + i, entry.value.toFixed(0), {
            x: gap * i,
            y: height - h - 42,
            width: gap,
            height: 40,
            align: 'center',
            fontSize: 24,
            fill: '#e2edff',
          }),
        );
      }
    });
    nodes.push(...group('chart', chart, { x: p.origin.x, y: p.origin.y, width, height }));
    return nodes;
  },
});
