import path from 'node:path';
import {initProject} from '../src/service/template.js';
import {Application} from '../src/service/application.js';
import {newNode} from '../src/core/model.js';
const root=path.resolve('artifacts/ui-multiselect-fixture');
await initProject(root);
const app=await new Application(root).open(false);
await app.service.transact([
 {type:'updateProject',patch:{name:'多选拖拽交互验收',width:1280,height:720}},
 {type:'writeSource',path:'components/pair.ts',content:"import {defineComponent,text,group} from '@vmotion/sdk';export default defineComponent({name:'Pair',parameters:{},render(){return group('row',[text('first','第一段文字',{x:120,y:140,width:400,height:90,fontSize:60}),text('second','第二段文字',{x:650,y:140,width:400,height:90,fontSize:60})]);}});"},
 {type:'updateScene',sceneId:'intro',patch:{name:'多选拖拽',duration:180,nodes:[newNode({id:'code',type:'component',name:'文字组合',component:'components/pair.ts',width:1280,height:720}),newNode({id:'shape',type:'rect',name:'蓝色形状',x:150,y:400,width:200,height:100,fill:'#79b6ff'})]}}
]);
await app.close();
console.log(root);
