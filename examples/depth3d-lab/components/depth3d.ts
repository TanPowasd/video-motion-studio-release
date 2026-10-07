import { defineComponent, scene3D, scene3DLayer, cubeMesh, text, rect, group, linearGradient, type MeshInstance3D } from '@vmotion/sdk';
const panel={vertices:[{x:-1.7,y:-1.15,z:0},{x:1.7,y:-1.15,z:0},{x:1.7,y:1.15,z:0},{x:-1.7,y:1.15,z:0}],faces:[[0,1,2,3]]},cube=cubeMesh(1.8);
export default defineComponent({name:'深度测试：穿插的三维物体',parameters:{angle:{type:'number',default:43},speed:{type:'number',default:18}},render(ctx,params){
  const camera={position:{x:0,y:1.3,z:7},target:{x:0,y:0,z:0},width:540,height:350,fov:46,near:.2,far:40},
    angle=params.angle+Math.sin(ctx.seconds*.7)*20,
    objects:MeshInstance3D[]=[
      {id:'red-plane',mesh:panel,color:'#ff8869',transform:{rotation:{x:0,y:angle,z:4}}},
      {id:'blue-plane',mesh:panel,color:'#65a7ff',transform:{rotation:{x:0,y:-angle,z:-4}}},
    ],boxes:MeshInstance3D[]=[
      {id:'box-a',mesh:cube,color:'#65dfc4',transform:{position:{x:-.45,y:0,z:.05},rotation:{x:15,y:ctx.seconds*params.speed,z:12}}},
      {id:'box-b',mesh:cube,color:'#ac96ff',transform:{position:{x:.45,y:0,z:-.05},rotation:{x:-18,y:-ctx.seconds*params.speed,z:-16}}},
    ],nodes=[
      rect('background',{width:1280,height:720,gradient:linearGradient({x:0,y:0},{x:1280,y:720},['#081422','#101b2d','#081724'])}),
      text('label','VMOTION  /  NATIVE DEPTH 3D',{x:50,y:27,width:1180,height:28,fontSize:18,fill:'#90a7c4'}),
      text('title','逐像素判断前后，让三维物体真正穿插',{x:50,y:65,width:1180,height:63,fontSize:40,fontWeight:700,fill:'#f1f7ff'}),
      text('subtitle','同一组矩阵与顶点 · 从整面排序到每个采样点的深度测试',{x:52,y:137,width:1180,height:35,fontSize:23,fill:'#91aac7'}),
      rect('left-panel',{x:40,y:190,width:580,height:365,radius:16,fill:'#101d30',stroke:'#2e415a',strokeWidth:1}),
      rect('right-panel',{x:660,y:190,width:580,height:365,radius:16,fill:'#101d30',stroke:'#2e415a',strokeWidth:1}),
      text('left-label','路径排序 / 整张面只能在上或在下',{x:65,y:209,width:525,height:34,fontSize:21,fill:'#dda594'}),
      text('right-label','Rust 深度缓冲 / 交叉两侧分别遮挡',{x:685,y:209,width:525,height:34,fontSize:21,fill:'#80d7c5'}),
    ];
  nodes.push(...group('sorted',scene3D('world',objects,camera,{cullBackfaces:false,ambient:1}),{x:60,y:202,width:540,height:350,clip:{x:0,y:48,width:540,height:302}}),
    scene3DLayer('depth-tested',objects,camera,{cullBackfaces:false,ambient:1,samples:4}));
  const depth=nodes.at(-1)!;depth.x=680;depth.y=202;depth.clip={x:0,y:48,width:540,height:302};
  const boxCamera={...camera,width:420,height:190,fov:50};
  nodes.push(...group('box-proof',[scene3DLayer('solid-meshes',boxes,boxCamera,{ambient:.4})],{x:62,y:536}),
    text('proof-heading','实体网格也按同一深度规则合成',{x:531,y:578,width:665,height:38,fontSize:25,fill:'#d9e9fa'}),
    text('proof-detail','相互穿插的立方体 · 4 点抗锯齿 · 稳定面 ID\n彩色图 / 深度图 / 对象图，供外部 agent 检查',{x:532,y:621,width:650,height:73,fontSize:19,fill:'#91aac7',lineHeight:1.55}));
  return nodes;
}});
