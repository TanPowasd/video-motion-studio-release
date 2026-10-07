use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};

type Vertex = [f64; 5];
#[derive(Clone)]
struct Triangle {
    a: Vertex, b: Vertex, c: Vertex, area: f64, color: [u8; 3], face: i32,
    bounds: [usize; 4], top: [bool; 3],
    material:Option<crate::shading::Material>,attributes:Option<[[f64;6];3]>,
}
pub struct Raster {
    pub rgba: Vec<u8>, pub depth: Option<Vec<f32>>, pub ids: Option<Vec<i32>>, pub triangles: usize,
}
fn edge(a: &Vertex, b: &Vertex, x: f64, y: f64) -> f64 {
    (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (x - a[0])
}
fn vertex(value: &Value) -> Result<Vertex, String> {
    let a = value.as_array().filter(|a| a.len() == 5).ok_or("Invalid raster vertex")?;
    let mut out = [0.0; 5];
    for i in 0..5 { out[i] = a[i].as_f64().filter(|v| v.is_finite()).ok_or("Nonfinite vertex")?; }
    if out[3] <= 0.0 || out[4] <= 0.0 { return Err("Clip W and eye depth must be positive".into()); }
    Ok(out)
}
fn dimension(value: &Value, max: u64) -> Result<usize, String> {
    value.as_u64().filter(|v| *v > 0 && *v <= max).map(|v| v as usize).ok_or("Invalid raster dimension".into())
}
pub fn render(request: &Value) -> Result<Raster, String> {
    let width = dimension(&request["width"], 3840)?;
    let height = dimension(&request["height"], 2160)?;
    let samples = request["samples"].as_u64().filter(|v| *v == 1 || *v == 4).ok_or("Samples must be 1 or 4")? as usize;
    let inspection = request["inspection"].as_bool().unwrap_or(false);
    let input = request["triangles"].as_array().filter(|a| a.len() <= 100_000).ok_or("Triangle limit exceeded")?;
    const TILE: usize = 16;
    let columns = width.div_ceil(TILE); let rows = height.div_ceil(TILE);
    let mut bins = vec![Vec::<usize>::new(); columns * rows]; let mut triangles = Vec::<Triangle>::new();
    let mut work = 0_u64;
    let lighting=if request["lighting"].is_null(){None}else{Some(crate::shading::lighting(&request["lighting"])?)};
    for value in input {
        let p = value["vertices"].as_array().filter(|a| a.len() == 3).ok_or("Triangle requires 3 vertices")?;
        let a = vertex(&p[0])?; let mut b = vertex(&p[1])?; let mut c = vertex(&p[2])?;
        let mut area = edge(&a, &b, c[0], c[1]);
        let material=if value["material"].is_null(){None}else{Some(crate::shading::material(&value["material"])?)};
        let mut attributes=None;
        if material.is_some(){
            if lighting.is_none(){return Err("MATERIAL3D_INPUT: lighting is missing".into());}
            let rows=value["attributes"].as_array().filter(|v|v.len()==3).ok_or("MATERIAL3D_INPUT: attributes missing")?;let mut out=[[0.0;6];3];
            for i in 0..3{let row=rows[i].as_array().filter(|v|v.len()==6).ok_or("MATERIAL3D_INPUT: attribute length")?;for j in 0..6{out[i][j]=row[j].as_f64().filter(|v|v.is_finite()).ok_or("MATERIAL3D_INPUT: nonfinite attribute")?;}}attributes=Some(out);
        }
        let channels = value["color"].as_array().filter(|a| a.len() == 3).ok_or("Triangle requires RGB")?;
        let mut color = [0_u8; 3];
        for i in 0..3 { color[i] = channels[i].as_u64().filter(|v| *v <= 255).ok_or("Invalid color")? as u8; }
        let face = value["faceId"].as_u64().filter(|v| *v <= i32::MAX as u64).ok_or("Invalid face ID")? as i32;
        if !area.is_finite() { return Err("Raster area overflow".into()); }
        if area.abs() < 1e-12 { continue; }
        if area < 0.0 { std::mem::swap(&mut b, &mut c);if let Some(ref mut data)=attributes{data.swap(1,2);} area = -area; }
        let x0 = a[0].min(b[0]).min(c[0]).floor().max(0.0);
        let y0 = a[1].min(b[1]).min(c[1]).floor().max(0.0);
        let x1 = a[0].max(b[0]).max(c[0]).ceil().min(width as f64) - 1.0;
        let y1 = a[1].max(b[1]).max(c[1]).ceil().min(height as f64) - 1.0;
        if x1 < x0 || y1 < y0 { continue; }
        let bounds = [x0 as usize, y0 as usize, x1 as usize, y1 as usize];
        work += ((bounds[2] - bounds[0] + 1) * (bounds[3] - bounds[1] + 1) * samples) as u64;
        if work > 256_000_000 { return Err("RASTER3D_WORK_LIMIT: lower resolution or simplify overlapping geometry".into()); }
        let top = [(&b, &c), (&c, &a), (&a, &b)].map(|(u, v)| v[1] < u[1] || (v[1] == u[1] && v[0] > u[0]));
        let index = triangles.len(); triangles.push(Triangle { a, b, c, area, color, face, bounds, top,material,attributes });
        for ty in bounds[1]/TILE..=bounds[3]/TILE { for tx in bounds[0]/TILE..=bounds[2]/TILE { bins[ty*columns+tx].push(index); } }
    }
    let mut rgba = vec![0_u8; width*height*4];
    let mut depths = inspection.then(|| vec![f32::INFINITY; width*height]);
    let mut faces = inspection.then(|| vec![-1_i32; width*height]);
    let size = TILE*TILE*samples;
    let mut z = vec![f64::INFINITY; size]; let mut eye = z.clone(); let mut ids = vec![-1_i32; size]; let mut rgb = vec![[0_u8; 3]; size];
    let offsets = if samples == 1 { vec![(0.5,0.5)] } else { vec![(0.25,0.25),(0.75,0.25),(0.25,0.75),(0.75,0.75)] };
    for ty in 0..rows { for tx in 0..columns {
        let left = tx*TILE; let top = ty*TILE; let w = TILE.min(width-left); let h = TILE.min(height-top);
        z.fill(f64::INFINITY); eye.fill(f64::INFINITY); ids.fill(-1); rgb.fill([0;3]);
        for index in &bins[ty*columns+tx] {
            let t = &triangles[*index];
            for y in top.max(t.bounds[1])..=(top+h-1).min(t.bounds[3]) { for x in left.max(t.bounds[0])..=(left+w-1).min(t.bounds[2]) { for (s,(ox,oy)) in offsets.iter().enumerate() {
                let px = x as f64+ox; let py = y as f64+oy;
                let ea = edge(&t.b,&t.c,px,py); let eb = edge(&t.c,&t.a,px,py); let ec = edge(&t.a,&t.b,px,py);
                if ea<0.0 || eb<0.0 || ec<0.0 || (ea==0.0&&!t.top[0]) || (eb==0.0&&!t.top[1]) || (ec==0.0&&!t.top[2]) { continue; }
                let a=ea/t.area; let b=eb/t.area; let c=ec/t.area;
                let ndc=a*t.a[2]+b*t.b[2]+c*t.c[2]; let at=((y-top)*TILE+x-left)*samples+s;
                if ndc < z[at] || (ndc==z[at] && (ids[at]<0 || t.face<ids[at])) {
                    z[at]=ndc; ids[at]=t.face;
                    rgb[at]=if let (Some(material),Some(data),Some(light))=(&t.material,&t.attributes,&lighting){
                        let den=a*t.a[3]+b*t.b[3]+c*t.c[3];let mut values=[0.0;6];for i in 0..6{values[i]=(a*t.a[3]*data[0][i]+b*t.b[3]*data[1][i]+c*t.c[3]*data[2][i])/den;}
                        crate::shading::shade(material,light,[values[0],values[1],values[2]],[values[3],values[4],values[5]])
                    }else{t.color};
                    eye[at]=(a*t.a[4]*t.a[3]+b*t.b[4]*t.b[3]+c*t.c[4]*t.c[3])/(a*t.a[3]+b*t.b[3]+c*t.c[3]);
                }
            } } }
        }
        for y in 0..h { for x in 0..w {
            let mut count=0_u32; let mut sum=[0_u32;3]; let mut nearest=f64::INFINITY; let mut nearest_id=-1_i32;
            for s in 0..samples {
                let at=(y*TILE+x)*samples+s; if ids[at]<0 {continue;}
                count+=1; for channel in 0..3 {sum[channel]+=rgb[at][channel] as u32;}
                if eye[at]<nearest || (eye[at]==nearest&&ids[at]<nearest_id) {nearest=eye[at];nearest_id=ids[at];}
            }
            let at=(top+y)*width+left+x;
            if count>0 {
                for channel in 0..3 {rgba[at*4+channel]=(sum[channel] as f64/count as f64).round() as u8;}
                rgba[at*4+3]=(255.0*count as f64/samples as f64).round() as u8;
            }
            if let Some(ref mut d)=depths {d[at]=nearest as f32;}
            if let Some(ref mut f)=faces {f[at]=nearest_id;}
        } }
    } }
    Ok(Raster {rgba,depth:depths,ids:faces,triangles:triangles.len()})
}
pub fn handle(request:&Value)->Result<Value,String>{
    let raster=render(request)?;
    let depth=raster.depth.map(|d|STANDARD.encode(d.into_iter().flat_map(f32::to_le_bytes).collect::<Vec<_>>()));
    let ids=raster.ids.map(|d|STANDARD.encode(d.into_iter().flat_map(i32::to_le_bytes).collect::<Vec<_>>()));
    Ok(json!({"rgba":STANDARD.encode(raster.rgba),"depth":depth,"faceIds":ids,"triangles":raster.triangles,"shadingVersion":1}))
}
#[cfg(test)] mod tests {
    use super::*;
    #[test] fn near_triangle_wins_independently_of_submission_order(){
        let near=json!({"vertices":[[0,0,-0.5,1,2],[4,0,-0.5,1,2],[0,4,-0.5,1,2]],"color":[255,0,0],"faceId":1});
        let far=json!({"vertices":[[0,0,0.5,1,5],[4,0,0.5,1,5],[0,4,0.5,1,5]],"color":[0,0,255],"faceId":2});
        let a=render(&json!({"width":4,"height":4,"samples":1,"inspection":true,"triangles":[near,far]})).unwrap();
        let b=render(&json!({"width":4,"height":4,"samples":1,"inspection":true,"triangles":[far,near]})).unwrap();
        assert_eq!(a.rgba,b.rgba);assert_eq!(&a.rgba[0..4],&[255,0,0,255]);assert_eq!(a.ids.unwrap()[0],1);assert_eq!(a.depth.unwrap()[0],2.0);
    }
    #[test] fn touching_triangles_have_no_shared_edge_holes(){
        let a=json!({"vertices":[[0,0,0,1,2],[4,0,0,1,2],[0,4,0,1,2]],"color":[255,255,255],"faceId":0});
        let b=json!({"vertices":[[4,0,0,1,2],[4,4,0,1,2],[0,4,0,1,2]],"color":[255,255,255],"faceId":0});
        for samples in [1,4] {let image=render(&json!({"width":4,"height":4,"samples":samples,"triangles":[a,b]})).unwrap();assert!(image.rgba.iter().all(|v|*v==255));}
    }
    #[test] fn rejects_invalid_geometry_and_samples(){assert!(render(&json!({"width":3841,"height":1,"samples":1,"triangles":[]})).is_err());assert!(render(&json!({"width":4,"height":4,"samples":2,"triangles":[]})).is_err());}
}
