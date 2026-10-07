import {defineComponent,scene3DLayer,sphereMesh,standardMaterial,text,rect,linearGradient} from '@vmotion/sdk';
const sphere=sphereMesh(1,{widthSegments:20,heightSegments:10}),cards=[
  {id:'faceted',title:'平面法线',detail:'保持可见的多边形结构',material:standardMaterial({color:'#69d9c5',shading:'flat',roughness:.7})},
  {id:'smooth',title:'平滑法线',detail:'跨三角形连续插值',material:standardMaterial({color:'#69d9c5',shading:'smooth',roughness:.7})},
  {id:'metal',title:'金属高光',detail:'金属度 1.00 / 粗糙度 0.18',material:standardMaterial({color:'#e3aa56',metallic:1,roughness:.18})},
  {id:'rough',title:'粗糙金属',detail:'相同光照 / 粗糙度 0.70',material:standardMaterial({color:'#e3aa56',metallic:1,roughness:.7})},
  {id:'emissive',title:'自发光',detail:'发射项独立于表面受光',material:standardMaterial({color:'#46308a',roughness:.6,emissive:'#8f55ff',emissiveIntensity:.8})},
  {id:'point',title:'点光照明',detail:'距离衰减 / 动态灯位',material:standardMaterial({color:'#b4cfff',metallic:.1,roughness:.3})},
];
export default defineComponent({name:'Material laboratory',parameters:{spin:{type:'number',default:20},exposure:{type:'number',default:1,min:.01,max:16}},render(ctx,params){
  const nodes=[rect('background',{width:1280,height:720,gradient:linearGradient({x:0,y:0},{x:1280,y:720},['#071322','#12213a','#091a2c'])}),
    text('label','VMOTION  /  NATIVE MATERIALS',{x:44,y:25,width:1190,height:28,fontSize:18,fill:'#91a8c4'}),
    text('title','让模型拥有光泽，也拥有细节',{x:44,y:66,width:1190,height:64,fontSize:44,fontWeight:700,fill:'#edf5ff'}),
    text('subtitle','平滑法线 · 金属度 / 粗糙度 · 线性光照 · 透视正确插值 · 原生深度',{x:46,y:133,width:1190,height:36,fontSize:23,fill:'#9bb2ce'})];
  for(const [i,card]of cards.entries()){
    const x=44+(i%3)*401,y=185+Math.floor(i/3)*241;
    nodes.push(rect(`panel-${card.id}`,{x,y,width:389,height:227,radius:14,fill:'#101e30',stroke:'#2d435e',strokeWidth:1}),
      text(`name-${card.id}`,card.title,{x:x+18,y:y+13,width:354,height:32,fontSize:23,fill:'#dcecff'}),
      text(`detail-${card.id}`,card.detail,{x:x+18,y:y+192,width:354,height:27,fontSize:17,fill:'#91a9c5'}));
    const moving=card.id==='point',node=scene3DLayer(`material-${card.id}`,[{id:'sphere',mesh:sphere,material:card.material,transform:{rotation:{x:0,y:ctx.seconds*params.spin,z:0}}}],
      {position:{x:0,y:0,z:4.4},target:{x:0,y:0,z:0},width:360,height:158,fov:40,near:.1,far:20},
      {ambient:moving?.03:.08,lights:moving?[{type:'point',position:{x:2*Math.sin(ctx.seconds),y:1.5,z:3},color:'#a2c6ff',intensity:20}]:[{type:'directional',direction:{x:.3,y:.5,z:1},intensity:3},{type:'directional',direction:{x:-1,y:.1,z:.5},color:'#709aff',intensity:1}],toneMapping:'aces',exposure:params.exposure,samples:4});
    node.x=x+14;node.y=y+36;nodes.push(node);
  }
  nodes.push(text('footer','scene3d_materials · 按实例编辑 · 参数关键帧 · 原生 / 回退一致 · 预检 → 原子提交',{x:46,y:684,width:1190,height:27,fontSize:17,fill:'#829cbd'}));return nodes;
}});
