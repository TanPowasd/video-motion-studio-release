import {defineComponent,rect,text,measureTextBlock}from '@vmotion/sdk';
import document from './captions-4f2267be-a506-41d2-b689-62b095081c3d.json';
export default defineComponent({name:"中文字幕",parameters:{
fontSize:{type:'number',default:34,min:8,max:200},fontFamily:{type:'string',default:"Microsoft YaHei"},color:{type:'color',default:"#ffffff"},bottom:{type:'number',default:46,min:0,max:2160}
},render(ctx,params){
let lo=0,hi=document.cues.length;while(lo<hi){const mid=(lo+hi)>>1;if(document.cues[mid].start<=ctx.frame)lo=mid+1;else hi=mid;}const cue=document.cues[lo-1];if(!cue||ctx.frame>=cue.end)return [];
const height=measureTextBlock(cue.text,{fontSize:params.fontSize,fontFamily:params.fontFamily,width:ctx.width*.8,lineHeight:1.35}).height,y=ctx.height-params.bottom-height;
return [rect('plate-'+cue.id,{x:ctx.width*.08,y:y-12,width:ctx.width*.84,height:height+24,radius:12,fill:'#000000ba'}),text(cue.id,cue.text,{name:cue.text.slice(0,30),x:ctx.width*.1,y,width:ctx.width*.8,height,fontSize:params.fontSize,fontFamily:params.fontFamily,fill:params.color,align:'center',lineHeight:1.35})];
}});
