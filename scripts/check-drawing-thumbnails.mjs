import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { createCanvas,loadImage } from '@napi-rs/canvas';
const state=(await (await fetch('http://127.0.0.1:4320/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})})).json()).result;
const result=[];
for(const asset of state.snapshot.project.assets.filter(a=>a.type==='drawing')){
 const resource=JSON.parse(await readFile(path.resolve(state.root,asset.path),'utf8'));
 const response=await fetch('http://127.0.0.1:4320/api/asset-thumbnail?id='+encodeURIComponent(asset.id));
 const canvas=createCanvas(160,100),ctx=canvas.getContext('2d');ctx.drawImage(await loadImage(Buffer.from(await response.arrayBuffer())),0,0);
 const pixels=ctx.getImageData(0,0,160,100).data;
 result.push({name:asset.name,points:resource.points?.length,insidePoints:resource.points?.filter(p=>p.x>=0&&p.x<=1280&&p.y>=0&&p.y<=720).length,visiblePixels:Array.from(pixels).filter((v,i)=>i%4===3&&v>0).length});
}
console.log(JSON.stringify(result));
