@group(0) @binding(0) var<storage, read> input: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read> clock: array<vec4<f32>>;
fn sdf(p: vec3<f32>, t: f32) -> f32 {
  let q = p - vec3<f32>(0.32 * sin(t), 0.16 * cos(t * 1.3), 0.0);
  let sphere = length(q) - 0.72;
  let torus = length(vec2<f32>(length(p.xz) - 1.02, p.y)) - 0.14;
  return min(sphere, torus);
}
fn normal(p: vec3<f32>, t: f32) -> vec3<f32> {
  let e = 0.001;
  return normalize(vec3<f32>(sdf(p + vec3<f32>(e,0,0),t) - sdf(p - vec3<f32>(e,0,0),t), sdf(p + vec3<f32>(0,e,0),t) - sdf(p - vec3<f32>(0,e,0),t), sdf(p + vec3<f32>(0,0,e),t) - sdf(p - vec3<f32>(0,0,e),t)));
}
@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let width = u32(clock[0].x); let height = u32(clock[0].y);
  if (id.x >= width || id.y >= height) { return; }
  let i = id.y * width + id.x;
  let t = clock[0].w * clock[2].x;
  let uv = (vec2<f32>(id.xy) + vec2<f32>(0.5)) / vec2<f32>(f32(width), f32(height)) * 2.0 - vec2<f32>(1.0);
  let origin = vec3<f32>(3.1 * sin(t * .35), 1.5, 3.1 * cos(t * .35));
  let forward = normalize(-origin);
  let right = normalize(cross(forward, vec3<f32>(0,1,0)));
  let up = cross(right,forward);
  let direction = normalize(forward * 1.6 + right * uv.x * f32(width)/f32(height) - up * uv.y);
  var distance = 0.0; var color = vec3<f32>(.025,.05,.12); var nearest = 1.0;
  for (var step = 0; step < 80; step++) {
    let p = origin + direction * distance;
    let d = sdf(p,t); nearest = min(nearest, d);
    if (d < .001) {
      let n = normal(p,t); let light = normalize(vec3<f32>(-2,4,3));
      let diffuse = max(dot(n,light),0.0);
      let rim = pow(1.0 - max(dot(n,-direction),0.0),3.0);
      color = vec3<f32>(.08,.62,.72) * (.2 + diffuse*.7) + vec3<f32>(.25,.18,.6)*rim;
      break;
    }
    distance += max(d,.001); if(distance > 12.0) {break;}
  }
  color += vec3<f32>(.05,.18,.3) * exp(-nearest * 18.0);
  let c = vec3<u32>(round(clamp(color,vec3<f32>(0),vec3<f32>(1))*255.0));
  // Preserve declared input binding and support using the shader as a transparent effect.
  output[i] = (input[i] & 0u) | c.x | (c.y << 8u) | (c.z << 16u) | 0xff000000u;
}
