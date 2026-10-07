use serde_json::Value;
pub type Triple=[f64;3];
#[derive(Clone)] pub struct Material {unlit:bool,base:Triple,metallic:f64,roughness:f64,emissive:Triple,double_sided:bool}
#[derive(Clone)] struct Light {point:bool,vector:Triple,color:Triple,intensity:f64,range:Option<f64>}
pub struct Lighting {camera:Triple,view:Option<Triple>,ambient:f64,exposure:f64,tone:String,lights:Vec<Light>}
fn triple(value:&Value)->Result<Triple,String>{let a=value.as_array().filter(|a|a.len()==3).ok_or("MATERIAL3D_INPUT: expected three numbers")?;let mut out=[0.0;3];for i in 0..3{out[i]=a[i].as_f64().filter(|v|v.is_finite()).ok_or("MATERIAL3D_INPUT: nonfinite vector")?;}Ok(out)}
fn number(value:&Value,min:f64,max:f64)->Result<f64,String>{value.as_f64().filter(|v|v.is_finite()&&*v>=min&&*v<=max).ok_or("MATERIAL3D_INPUT: numeric range".into())}
pub fn material(value:&Value)->Result<Material,String>{
    let base=triple(&value["base"])?;let emissive=triple(&value["emissive"])?;
    if base.iter().any(|v|*v<0.0||*v>1.0)||emissive.iter().any(|v|*v<0.0||*v>8.0){return Err("MATERIAL3D_INPUT: color range".into());}
    let unlit=match value["model"].as_str(){Some("standard")=>false,Some("unlit")=>true,_=>return Err("MATERIAL3D_INPUT: unknown model".into())};
    Ok(Material{unlit,base,emissive,metallic:number(&value["metallic"],0.0,1.0)?,roughness:number(&value["roughness"],0.05,1.0)?,double_sided:value["doubleSided"].as_bool().ok_or("MATERIAL3D_INPUT: doubleSided")?})
}
pub fn lighting(value:&Value)->Result<Lighting,String>{
    let input=value["lights"].as_array().filter(|v|v.len()<=8).ok_or("MATERIAL3D_INPUT: at most 8 lights")?;let mut lights=Vec::new();
    for light in input{
        let point=match light["type"].as_str(){Some("directional")=>false,Some("point")=>true,_=>return Err("MATERIAL3D_INPUT: unknown light".into())};
        let vector=triple(&light["vector"])?;let color=triple(&light["color"])?;
        if color.iter().any(|v|*v<0.0||*v>1.0){return Err("MATERIAL3D_INPUT: light color range".into());}
        let range=if light["range"].is_null(){None}else{Some(number(&light["range"],f64::MIN_POSITIVE,f64::MAX)?)};
        lights.push(Light{point,vector:if point{vector}else{normalize(vector)},color,intensity:number(&light["intensity"],0.0,1000.0)?,range});
    }
    let tone=value["toneMapping"].as_str().filter(|v|["none","reinhard","aces"].contains(v)).ok_or("MATERIAL3D_INPUT: tone mapping")?.to_string();
    Ok(Lighting{camera:triple(&value["camera"] )?,view:if value["viewDirection"].is_null(){None}else{Some(normalize(triple(&value["viewDirection"])?))},ambient:number(&value["ambient"],0.0,1.0)?,exposure:number(&value["exposure"],0.01,16.0)?,tone,lights})
}
fn norm(v:Triple)->f64{v[0].hypot(v[1]).hypot(v[2])}
fn normalize(v:Triple)->Triple{let n=norm(v);if n>0.0{v.map(|x|x/n)}else{[0.0;3]}}
fn dot(a:Triple,b:Triple)->f64{a[0]*b[0]+a[1]*b[1]+a[2]*b[2]}
fn output(value:f64,l:&Lighting)->u8{
    let mut v=(value*l.exposure).max(0.0);
    if l.tone=="reinhard"{v=v/(1.0+v);}else if l.tone=="aces"{v=(v*(2.51*v+0.03))/(v*(2.43*v+0.59)+0.14);}
    v=v.clamp(0.0,1.0);let s=if v<=0.0031308{12.92*v}else{1.055*v.powf(1.0/2.4)-0.055};(s*255.0).clamp(0.0,255.0).round() as u8
}
pub fn shade(m:&Material,l:&Lighting,world:Triple,normal:Triple)->[u8;3]{
    let mut color=m.emissive;
    if m.unlit{for i in 0..3{color[i]+=m.base[i];}return color.map(|v|output(v,l));}
    let mut n=normalize(normal);let view=l.view.unwrap_or_else(||normalize([l.camera[0]-world[0],l.camera[1]-world[1],l.camera[2]-world[2]]));
    if m.double_sided&&dot(n,view)<0.0{n=n.map(|v|-v);}
    let nv=dot(n,view).max(0.0);let f0=m.base.map(|v|0.04*(1.0-m.metallic)+v*m.metallic);let a2=m.roughness.powi(4);
    for i in 0..3{color[i]+=l.ambient*(m.base[i]*(1.0-m.metallic)+f0[i]*0.15);}
    for light in &l.lights{
        let delta=if light.point{[light.vector[0]-world[0],light.vector[1]-world[1],light.vector[2]-world[2]]}else{light.vector};
        let distance=norm(delta);let direction=if light.point{normalize(delta)}else{delta};let nl=dot(n,direction).max(0.0);
        if nl<=0.0||nv<=0.0{continue;}
        let mut intensity=light.intensity;
        if light.point{intensity/=(distance*distance).max(0.01);if let Some(range)=light.range{intensity*=(1.0-(distance/range).powi(4)).max(0.0).powi(2);}}
        let half=normalize([view[0]+direction[0],view[1]+direction[1],view[2]+direction[2]]);let nh=dot(n,half).max(0.0);let vh=dot(view,half).max(0.0);
        let denominator=nh*nh*(a2-1.0)+1.0;let d=a2/(std::f64::consts::PI*denominator*denominator);
        let g1=|value:f64|2.0*value/(value+(a2+(1.0-a2)*value*value).sqrt());let g=g1(nl)*g1(nv);let fresnel=(1.0-vh).powi(5);
        for i in 0..3{let f=f0[i]+(1.0-f0[i])*fresnel;let diffuse=(1.0-f)*(1.0-m.metallic)*m.base[i]/std::f64::consts::PI;let specular=d*g*f/(4.0*nl*nv).max(1e-8);color[i]+=(diffuse+specular)*light.color[i]*intensity*nl;}
    }
    color.map(|v|output(v,l))
}
#[cfg(test)]mod tests{
use super::*;use serde_json::json;
#[test]fn unlit_round_trips_srgb(){let m=material(&json!({"model":"unlit","base":[1.0,0.0,0.0],"metallic":0.0,"roughness":0.5,"emissive":[0.0,0.0,0.0],"doubleSided":false})).unwrap();let l=lighting(&json!({"camera":[0,0,5],"ambient":0.0,"exposure":1.0,"toneMapping":"none","lights":[]})).unwrap();assert_eq!(shade(&m,&l,[0.0;3],[0.0,0.0,1.0]),[255,0,0]);}
#[test]fn invalid_material_is_rejected(){assert!(material(&json!({"model":"standard","base":[1,1,1],"metallic":2,"roughness":0.5,"emissive":[0,0,0],"doubleSided":false})).is_err());}
}
