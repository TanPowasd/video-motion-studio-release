import { defineComponent, rect, text, path, ellipse, group, booleanPath, roundPath, progress, type Node } from '@vmotion/sdk';
const circle = (cx: number, cy: number, r: number) =>
  `M ${cx-r} ${cy} A ${r} ${r} 0 1 0 ${cx+r} ${cy} A ${r} ${r} 0 1 0 ${cx-r} ${cy} Z`;
const waveform = Array.from({length:161},(_,i)=>`${i?'L':'M'} ${i*6} ${100-55*Math.sin(i/12)*Math.sin(i/42)}`).join(' ');
export default defineComponent({
  name: '矢量动画实验室',
  parameters: {
    accent: {type:'color',default:'#72e6d4',label:'主色'},
    speed: {type:'number',default:1,min:.25,max:3,label:'动画速度'},
  },
  render(ctx, params) {
    const time = ctx.seconds * params.speed, phase = time / 4,
      draw = progress(ctx,{start:12,duration:78}), separation = 105 + 40*Math.sin(time*1.4),
      a = circle(210, 270, 100), b = circle(210 + separation, 270, 100),
      accent = params.accent;
    const nodes: Node[] = [
      rect('background',{width:1920,height:1080,fill:'#0a111c'}),
      text('eyebrow','VMOTION / VECTOR LAB',{x:72,y:46,width:1600,height:32,fontSize:22,fill:'#8297b1'}),
      text('title','让路径成为动画语言',{x:72,y:94,width:1720,height:84,fontSize:62,fontWeight:700,fill:'#f2f6fc'}),
      text('subtitle','布尔几何 · 可动画裁切 · 虚线流动 · 原生图层',{x:76,y:183,width:1680,height:50,fontSize:28,fill:'#a6b9ce'}),
    ];
    for (const [index, operation] of (['union','difference','xor'] as const).entries()) {
      const colors = [accent,'#ffb480','#b6a2ff'], labels = ['合并 / UNION','相减 / DIFFERENCE','排除 / XOR'];
      nodes.push(...group(`boolean-${operation}`, [
        rect('card',{width:568,height:430,radius:20,fill:'#121d2c',stroke:'#26384d',strokeWidth:1}),
        text('label',labels[index],{x:30,y:26,width:508,height:42,fontSize:25,fill:colors[index]}),
        path('result',booleanPath([a,b],operation),{fill:colors[index],opacity:.88}),
        path('operand-a',a,{fill:'transparent',stroke:'#d7e5f4',strokeWidth:2,strokeDash:[7,7],opacity:.6}),
        path('operand-b',b,{fill:'transparent',stroke:'#d7e5f4',strokeWidth:2,strokeDash:[7,7],opacity:.6}),
        text('caption',['A ∪ B','A \\ B','A △ B'][index],{x:30,y:376,width:490,height:38,fontSize:22,fill:'#8aa1bc'}),
      ],{x:72+604*index,y:269,width:568,height:430}));
    }
    nodes.push(...group('stroke',[
      rect('card',{width:1172,height:260,radius:20,fill:'#121d2c',stroke:'#26384d',strokeWidth:1}),
      text('label','描边书写 / TRIM + DASH',{x:30,y:23,width:1050,height:40,fontSize:24,fill:accent}),
      path('reference',waveform,{x:80,y:93,fill:'transparent',stroke:'#26384d',strokeWidth:8}),
      path('draw',waveform,{x:80,y:93,fill:'transparent',stroke:accent,strokeWidth:8,strokeCap:'round',strokeJoin:'round',
        pathTrim:{start:0,end:draw,offset:0}}),
      path('flow','M80 223H1080',{fill:'transparent',stroke:'#e3edff',strokeWidth:4,strokeDash:[18,14,4,14],
        strokeDashOffset:-time*70,strokeCap:'round'}),
    ],{x:72,y:735,width:1172,height:260}));
    nodes.push(...group('orbit',[
      rect('card',{width:568,height:260,radius:20,fill:'#121d2c',stroke:'#26384d',strokeWidth:1}),
      text('label','首尾环绕 / OFFSET',{x:30,y:23,width:508,height:40,fontSize:24,fill:'#b6a2ff'}),
      ellipse('reference',{x:350,y:83,width:140,height:140,fill:'transparent',stroke:'#283b52',strokeWidth:12}),
      ellipse('arc',{x:350,y:83,width:140,height:140,fill:'transparent',stroke:'#b6a2ff',strokeWidth:12,strokeCap:'round',
        pathTrim:{start:.12,end:.82,offset:phase}}),
      path('rounded',roundPath('M0 0H140V80H88V134H0Z',18),{x:45,y:89,fill:'transparent',stroke:'#ffb480',strokeWidth:6,
        strokeJoin:'round',pathTrim:{start:0,end:1,offset:0}}),
    ],{x:1280,y:735,width:568,height:260}));
    nodes.push(text('footer','稳定 ID · 无状态逐帧求值 · SDK / CLI / MCP',{x:76,y:1024,width:1780,height:35,fontSize:20,fill:'#7087a1'}));
    return nodes;
  },
});
