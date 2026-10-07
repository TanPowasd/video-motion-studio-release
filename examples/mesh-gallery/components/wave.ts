import {defineComponent, node} from '@vmotion/sdk';

export default defineComponent({
  name: 'Sine wave',
  parameters: {
    amplitude: {type: 'number', default: 100, min: 0, max: 180},
    frequency: {type: 'number', default: 2, min: 0.1, max: 8},
    color: {type: 'color', default: '#92a0ff'}
  },
  render(ctx, params) {
    const amplitude = Number(params.amplitude);
    const frequency = Number(params.frequency);
    const color = String(params.color);
    const line = Array.from({length: 401}, (_, i) => {
      const x = i * ctx.width / 400;
      const y = ctx.height / 2 - Math.sin(i / 400 * Math.PI * 2 * frequency - ctx.seconds) * amplitude;
      return (i ? 'L' : 'M') + ' ' + x + ' ' + y;
    }).join(' ');
    return [
      node({id: 'axis', type: 'path', path: 'M 0 ' + ctx.height / 2 + ' L ' + ctx.width + ' ' + ctx.height / 2, fill: 'transparent', stroke: '#38445f', strokeWidth: 2}),
      node({id: 'curve', type: 'path', path: line, fill: 'transparent', stroke: color, strokeWidth: 5}),
      node({id: 'dot', type: 'ellipse', x: ctx.width / 2 - 9, y: ctx.height / 2 - Math.sin(Math.PI * frequency - ctx.seconds) * amplitude - 9, width: 18, height: 18, fill: '#ffffff'})
    ];
  }
});
