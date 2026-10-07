import path from 'node:path';import {mkdir,writeFile}from 'node:fs/promises';import {existsSync}from 'node:fs';
import {initProject}from '../src/service/template.js';import {Application}from '../src/service/application.js';
import {newNode,sceneSchema}from '../src/core/model.js';import {contentTimeSchema}from '../src/core/content-time.js';
const root=path.resolve('examples/time-lab');if(!existsSync(path.join(root,'project.vmotion.json')))await initProject(root,'内容时间与重映射实验室');
const app=await new Application(root).open(false);
try{
  const motion=sceneSchema.parse({id:'motion',name:'共用运动源',width:540,height:360,duration:120,background:'transparent',nodes:[
    newNode({id:'panel',type:'rect',width:540,height:360,radius:20,fill:'#14243a',stroke:'#2c4763',strokeWidth:1}),
    newNode({id:'axis',type:'path',path:'M50 220H490',fill:'transparent',stroke:'#33536c',strokeWidth:3}),
    newNode({id:'dot',type:'ellipse',name:'运动圆点',x:50,y:196,width:48,height:48,fill:'#73e5d2',animations:[{property:'x',keys:[{frame:0,value:50,easing:'linear'},{frame:119,value:440,easing:'linear'}]}]}),
    newNode({id:'ring',type:'ellipse',name:'内容时钟圆环',x:192,y:48,width:156,height:156,fill:'transparent',stroke:'#73e5d2',strokeWidth:8,strokeCap:'round',pathTrim:{start:0,end:.7,offset:0},
      animations:[{property:'pathTrim.offset',keys:[{frame:0,value:0,easing:'linear'},{frame:119,value:1,easing:'linear'}]}]}),
    newNode({id:'caption',type:'text',x:36,y:279,width:468,height:44,fontSize:26,align:'center',text:'同一条轨迹 · 不同内容时钟',fill:'#9bb9d4'}),
  ]}),nodes=[
    newNode({id:'label',type:'text',x:72,y:38,width:1776,height:38,fontSize:22,text:'VMOTION / CONTENT TIME',fill:'#839bb7'}),
    newNode({id:'title',type:'text',x:72,y:93,width:1776,height:90,fontSize:62,fontWeight:700,text:'控制时间，重新组织运动',fill:'#f2f7ff'}),
    newNode({id:'subtitle',type:'text',x:76,y:186,width:1740,height:46,fontSize:28,text:'变速 · 倒放 · 冻结 · 循环 · 往返 · 贝塞尔时间重映射',fill:'#9eb6d2'}),
  ];
  const modes=[
    {id:'normal',label:'1× / 正常循环',time:contentTimeSchema.parse({repeat:'loop'})},
    {id:'fast',label:'2× / 双倍速度',time:contentTimeSchema.parse({rate:2,repeat:'loop'})},
    {id:'reverse',label:'-1× / 倒放循环',time:contentTimeSchema.parse({rate:-1,offset:119,repeat:'loop'})},
    {id:'frozen',label:'0× / 冻结内容',time:contentTimeSchema.parse({rate:0,offset:58,repeat:'clamp'})},
    {id:'pingpong',label:'往返 / 首尾折返',time:contentTimeSchema.parse({repeat:'pingpong'})},
    {id:'remap',label:'重映射 / 加速 · 停顿 · 倒放',time:contentTimeSchema.parse({mode:'remap',repeat:'clamp'})},
  ];
  for(const[i,mode]of modes.entries()){
    const x=72+(i%3)*604,y=252+Math.floor(i/3)*385;
    nodes.push(newNode({id:`label-${mode.id}`,type:'text',x,y,width:568,height:42,fontSize:26,text:mode.label,fill:i%3===0?'#73e5d2':i%3===1?'#b7a5ff':'#ffb68a'}),
      newNode({id:mode.id,type:'scene',name:mode.label,sceneId:'motion',x,y:y+56,width:568,height:305,timeMapping:mode.time,
        overrides:i%3?{dot:{fill:i%3===1?'#b7a5ff':'#ffb68a'},ring:{stroke:i%3===1?'#b7a5ff':'#ffb68a'}}:{},
        animations:mode.id==='remap'?[{property:'timeMapping.frame',keys:[
          {frame:0,value:0,easing:'bezier',bezier:[.65,0,.9,1]},{frame:70,value:110,easing:'hold'},
          {frame:110,value:110,easing:'easeInOut'},{frame:210,value:10,easing:'linear'},{frame:239,value:58,easing:'linear'},
        ]}]:mode.id==='frozen'?[{property:'x',keys:[{frame:0,value:x,easing:'easeInOut'},{frame:119,value:x+18,easing:'easeInOut'},{frame:239,value:x,easing:'linear'}]}]:[]}));
  }
  nodes.push(newNode({id:'footer',type:'text',x:76,y:1020,width:1768,height:38,fontSize:23,text:'内容按源时间求值 · 图层变换按父时间求值 · 随机跳帧一致 · CLI / MCP',fill:'#8ca8c6'}));
  await app.service.transact([
    {type:'updateProject',patch:{width:1920,height:1080}},
    app.service.snapshot.scenes.some((s)=>s.id==='motion')?{type:'updateScene',sceneId:'motion',patch:motion}:{type:'addScene',scene:motion},
    {type:'updateScene',sceneId:'intro',patch:{name:'内容时间实验室',duration:240,background:'#0a121f',nodes}},
    {type:'updateSequence',sequenceId:'main',patch:{duration:240,tracks:[{id:'visual',name:'时间控制',type:'video',muted:false,clips:[{id:'intro',sceneId:'intro',start:0,duration:240,sourceIn:0,speed:1,volume:1,fadeIn:0,fadeOut:0}]}]}},
  ]);
  await mkdir(path.join(root,'exports'),{recursive:true});
  for(const frame of [0,36,90,180,239])await writeFile(path.join(root,`exports/time-${frame}.png`),(await app.frame({frame})).buffer);
  const audit=await app.dispatch('visualAudit',{sceneId:'intro',frames:[0,36,90,180,239],width:640,output:path.join(root,'exports/contact-sheet.png')});
  console.log(JSON.stringify({root,revision:app.service.snapshot.revision,audit:audit.summary},null,2));
  if(process.argv.includes('--render')){const job=app.renders.start(app.service.snapshot,{output:path.join(root,'exports/content-time-1080p.mp4'),format:'mp4',encoder:'libx264'}),done=await app.renders.wait(job.id);console.log(JSON.stringify(done));if(done.status!=='completed')process.exitCode=1;}
}finally{await app.close();}
