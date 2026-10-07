import { defineComponent, text, rect, linearGradient } from '@vmotion/sdk';
export default defineComponent({
  name: '排版检查实验',
  parameters: { fixed: { type: 'boolean', label: '修复排版', default: false } },
  render(ctx, p) {
    return [
      rect('background', {
        width: 1280,
        height: 720,
        gradient: linearGradient({ x: 0, y: 0 }, { x: 1280, y: 720 }, ['#0d172a', '#122638']),
      }),
      text('label', 'VMOTION / VISUAL AUDIT', {
        x: 72,
        y: 42,
        width: 1000,
        height: 40,
        fontSize: 18,
        fill: '#809bbc',
      }),
      text('heading', '动画能生成，也需要逐帧检查', {
        x: 72,
        y: 98,
        width: 1100,
        height: 100,
        fontSize: 46,
        fill: '#e1ecff',
      }),
      text('overlap-a', '第一个标题', {
        x: 90,
        y: 250,
        width: 440,
        height: 60,
        fontSize: 38,
        fill: '#a0c9ff',
      }),
      text('overlap-b', '第二个标题', {
        x: p.fixed ? 330 : 160,
        y: 250,
        width: 400,
        height: 60,
        fontSize: 38,
        fill: '#efcba2',
      }),
      text('truncated', '三行内容必须完整显示\n不能只留下第一行\n代码也需要原生画面验证', {
        x: 90,
        y: 345,
        width: 500,
        height: p.fixed ? 160 : 24,
        fontSize: 30,
        fill: '#b6cde8',
      }),
      text('overflow', '这段文字不应跑出画布', {
        x: p.fixed ? 720 : 1180,
        y: 380,
        width: 450,
        height: 60,
        fontSize: 28,
        fill: '#aac1e0',
      }),
      text('covered', '文字不该被遮住', {
        x: 720,
        y: 250,
        width: 430,
        height: 60,
        fontSize: 34,
        fill: '#e5efff',
      }),
      rect('cover', { x: 710, y: p.fixed ? 450 : 245, width: 340, height: 54, fill: '#274460' }),
      text('moving', '运动应保持连续', {
        x: p.fixed ? 90 + ctx.frame * 2 : ctx.frame >= 60 ? 990 : 90,
        y: 550,
        width: 350,
        height: 60,
        fontSize: 30,
        fill: '#91bedc',
      }),
      text(
        'footer',
        p.fixed ? '修复版本 · 相同工程可持续编辑' : '测试版本 · 打开「检查画面」定位问题',
        { x: 72, y: 666, width: 1100, height: 36, fontSize: 18, fill: '#7e97bb' },
      ),
    ];
  },
});
