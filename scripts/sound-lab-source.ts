export const soundLabSource = String.raw`import {defineComponent,node,compileSound} from '@vmotion/sdk';
import score from './sounds/score.json';
const music=compileSound(score),colors=['#78d8bf','#79a8ef','#c6a0ec','#e8b574','#a9cadd','#ef9197','#9fd49b'];
export default defineComponent({name:'声音制作工作台',parameters:{},render(ctx){
const time=ctx.seconds,progress=Math.min(1,time/music.duration),items=[
node({id:'title',type:'text',text:'声音，也可以编程创作。',x:70,y:48,width:1110,height:68,fontSize:44,fontWeight:700,fill:'#edf4ff'}),
node({id:'subtitle',type:'text',text:'音符编曲  /  合成与采样  /  音效  /  总线混音',x:74,y:125,width:1120,height:36,fontSize:20,fill:'#9fb1ca'}),
node({id:'panel',type:'rect',x:70,y:193,width:1140,height:360,radius:14,fill:'#152235'}),
node({id:'playhead',type:'rect',x:260+progress*905,y:215,width:2,height:310,fill:'#edf7ff'}),
node({id:'time',type:'text',text:time.toFixed(2)+'s / '+music.duration.toFixed(2)+'s',x:74,y:609,width:330,height:32,fontSize:22,fill:'#b4c9e4'}),
node({id:'footer',type:'text',text:'JSON 工程 · 稳定音符 ID · 修改后可持续重渲染',x:74,y:658,width:1050,height:28,fontSize:18,fill:'#8da5c2'})];
music.tracks.forEach(({track,events},row)=>{
const y=222+row*42,color=colors[row%colors.length];items.push(node({id:'name-'+track.id,type:'text',text:track.name,x:90,y:y-2,width:160,height:28,fontSize:17,fill:color}));
events.forEach(event=>{const begin=event.start/48000,length=event.gate,active=time>=begin&&time<begin+length;
items.push(node({id:track.id+'-'+event.id,type:'rect',x:260+begin/music.duration*905,y:y+(event.note%4)*2,width:Math.max(4,length/music.duration*905),height:active?22:14,radius:3,fill:color,opacity:active?1:.5}));});});
const level=Math.min(1,(ctx.audio?.rms??0)*3.6);
for(let i=0;i<34;i++)items.push(node({id:'meter-'+i,type:'rect',x:540+i*18,y:603,width:12,height:30,radius:2,fill:i>28?'#edb673':'#81d3bf',opacity:i/34<level?1:.15}));
return items;}});`;
