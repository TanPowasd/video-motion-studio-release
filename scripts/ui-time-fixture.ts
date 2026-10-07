import path from 'node:path';import {existsSync}from 'node:fs';import {initProject}from '../src/service/template.js';import {Application}from '../src/service/application.js';
import {newNode,sceneSchema}from '../src/core/model.js';import {contentTimeSchema}from '../src/core/content-time.js';
const root=path.resolve('artifacts/time-ui-20261004');if(!existsSync(path.join(root,'project.vmotion.json')))await initProject(root,'内容时间交互验收');
const app=await new Application(root).open(false);
try{
  const source=sceneSchema.parse({id:'source',name:'运动源',width:960,height:540,duration:120,background:'transparent',nodes:[
    newNode({id:'box',name:'运动方块',type:'rect',x:30,y:120,width:100,height:100,fill:'#73e5d2',animations:[{property:'x',keys:[{frame:0,value:30,easing:'linear'},{frame:119,value:700,easing:'linear'}]}]}),
  ]});
  await app.service.transact([{type:'updateProject',patch:{width:960,height:540}},
    app.service.snapshot.scenes.some((s)=>s.id==='source')?{type:'updateScene',sceneId:'source',patch:source}:{type:'addScene',scene:source},
    {type:'updateScene',sceneId:'intro',patch:{name:'父时间场景',duration:180,background:'#111c2c',nodes:[newNode({id:'ref',name:'变速场景实例',type:'scene',sceneId:'source',width:960,height:540,timeMapping:contentTimeSchema.parse({rate:2})})]}},
    {type:'updateSequence',sequenceId:'main',patch:{duration:180,tracks:[{id:'visual',name:'时间',type:'video',muted:false,clips:[{id:'intro',sceneId:'intro',start:0,duration:180,sourceIn:0,speed:1,volume:1,fadeIn:0,fadeOut:0}]}]}},
  ]);
  if(!(await app.dispatch('drawingList')).length)await app.dispatch('drawingCreate',{name:'验收画稿',width:160,height:90});
  console.log(JSON.stringify({root,revision:app.service.snapshot.revision}));
}finally{await app.close();}
