import {definePlugin,definePluginTool,node,effectGraph} from '@vmotion/sdk';
export default definePlugin({name:'可编程创作包',tools:{
  compose:definePluginTool({parameters:{sceneId:{type:'string',default:'intro'},title:{type:'string',default:'创作能力，由插件自由组合。'},accent:{type:'color',default:'#67d4db'}},run(ctx,p){
    const sx=ctx.project.width/1280,sy=ctx.project.height/720;
    const nodes=[
      node({id:'layout',type:'group',width:1280,height:720,scaleX:sx,scaleY:sy}),
      node({id:'eyebrow',parentId:'layout',type:'text',text:'VMOTION  /  PLUGIN WORKFLOW',x:58,y:40,width:1150,height:30,fontSize:18,fill:'#8da8bd'}),
      node({id:'title',parentId:'layout',type:'text',text:p.title,x:54,y:108,width:1160,height:94,fontSize:50,fontWeight:700,fill:'#edf7ff',animations:[{property:'opacity',keys:[{frame:0,value:0},{frame:24,value:1}]}]}),
      node({id:'description',parentId:'layout',type:'text',text:'组件 + 主题 + 特效图 + 类型化工具  ·  本地 JSON / TypeScript',x:58,y:213,width:1160,height:42,fontSize:24,fill:'#90aec4'}),
      ...['可编辑参数','确定性动画','MCP 候选'].map((label,i)=>node({id:'card-'+i,parentId:'layout',type:'component',component:'components/plugins/creative/card.ts',x:58+i*408,y:305,width:348,height:255,params:{label,color:p.accent,value:[68,94,86][i],delay:i*8},effects:[effectGraph('components/effects/plugin-shine.json')]})),
      node({id:'footer',parentId:'layout',type:'text',text:'Agent：发现插件 → 查询参数 → 编排候选 → 原生画面预检 → 原样提交',x:58,y:650,width:1170,height:30,fontSize:20,fill:'#8da8bd'})
    ];
    return {operations:[{type:'updateScene' as const,sceneId:p.sceneId,patch:{background:'#091522',nodes}}],samples:[0,60,120].map(frame=>({sceneId:p.sceneId,frame})),summary:{sceneId:p.sceneId,layers:nodes.length,editable:true}};
  }}),
  inspect:definePluginTool({parameters:{},run(ctx){return {scenes:ctx.scenes.map(s=>({id:s.id,layers:s.nodes.length,types:[...new Set(s.nodes.map(n=>n.type))]}))};}})
}});
