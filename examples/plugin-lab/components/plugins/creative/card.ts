import {defineComponent,node,progress,ease} from '@vmotion/sdk';
export default defineComponent({name:'数据动效卡',parameters:{label:{type:'string',default:'数据'},color:{type:'color',default:'#67d4db'},value:{type:'number',default:68,min:0,max:100},delay:{type:'number',default:0,min:0,max:90}},render(ctx,p){
  const t=ease(progress(ctx,{start:p.delay,duration:50}),'easeOut'),v=Math.round(p.value*t);
  return [
    node({id:'panel',type:'rect',width:348,height:255,radius:18,fill:'#152b3e',stroke:'#35586b',strokeWidth:1}),
    node({id:'label',type:'text',text:p.label,x:24,y:27,width:300,height:48,fontSize:28,fontWeight:700,fill:'#eaf6ff'}),
    node({id:'value',type:'text',text:String(v),x:24,y:90,width:180,height:80,fontSize:62,fontWeight:700,fill:p.color}),
    node({id:'track',type:'rect',x:24,y:202,width:300,height:7,radius:3,fill:'#304e60'}),
    node({id:'bar',type:'rect',x:24,y:202,width:300*p.value/100*t,height:7,radius:3,fill:p.color}),
    ...Array.from({length:12},(_,i)=>node({id:'spark-'+i,type:'ellipse',x:220+(i%4)*26,y:105+Math.floor(i/4)*22+Math.sin(ctx.seconds*2+i)*4,width:4,height:4,opacity:(0.4+0.3*Math.sin(i+ctx.seconds))*t,fill:p.color}))
  ];
}});
