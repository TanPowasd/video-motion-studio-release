struct Dimensions { pixels: u32, stages: u32, unused0: u32, unused1: u32 }
@group(0) @binding(0) var<storage, read> source: array<u32>;
@group(0) @binding(1) var<storage, read_write> output: array<u32>;
@group(0) @binding(2) var<storage, read> operations: array<f32>;
@group(0) @binding(3) var<storage, read> canvas_lut: array<u32>;
@group(0) @binding(4) var<uniform> dimensions: Dimensions;
@group(0) @binding(5) var<storage, read_write> rounding_flags: array<atomic<u32>>;
fn near_half(x: f32, error: f32) -> bool {
  return abs(fract(clamp(x,0.0,255.0))-0.5) <= error;
}
fn byte(packed: u32, c: u32) -> f32 { return f32((packed >> (c * 8u)) & 255u); }
fn quantize(x: f32) -> u32 {
  let bounded = clamp(x, 0.0, 255.0);
  let lo = floor(bounded);
  let frac = bounded - lo;
  return u32(lo) + select(0u, 1u, frac > 0.5 || (frac == 0.5 && (u32(lo) & 1u) == 1u));
}
fn canvas_channel(c: u32, alpha: u32) -> u32 {
  let index = c * 256u + alpha;
  return (canvas_lut[index / 4u] >> ((index % 4u) * 8u)) & 255u;
}
fn linear(x: f32) -> f32 { if(x <= 0.04045) { return x / 12.92; } return pow((x + 0.055)/1.055, 2.4); }
fn encoded(x: f32) -> f32 { if(x <= 0.0031308) { return x * 12.92; } return 1.055 * pow(x, 1.0/2.4) - 0.055; }
fn channel(v: vec4<f32>, kind: f32, constant: f32) -> f32 {
  if(kind == -1.0) { return constant * 255.0; }
  if(kind == 4.0) { return dot(v.xyz, vec3<f32>(0.2126, 0.7152, 0.0722)); }
  return v[u32(kind)];
}
fn matrix_row(at: u32, row: u32, v: vec4<f32>, is_linear: bool) -> f32 {
  let m = at + 2u + row * 5u;
  let value = clamp(operations[m]*v.x+operations[m+1u]*v.y+operations[m+2u]*v.z+operations[m+3u]*v.w+operations[m+4u],0.0,1.0);
  return select(value, encoded(value), is_linear && row < 3u) * 255.0;
}
@compute @workgroup_size(256)
fn main(@builtin(global_invocation_id) id: vec3<u32>) {
  let index = id.x;
  if(index >= dimensions.pixels) { return; }
  let packed = source[index];
  var v = vec4<f32>(byte(packed,0u), byte(packed,1u), byte(packed,2u), byte(packed,3u));
  var needs_cpu = false;
  for(var stage = 0u; stage < dimensions.stages; stage = stage + 1u) {
    let at = stage * 32u;
    let kind = u32(operations[at]);
    if(kind == 0u) {
      var normalized = v / 255.0;
      let is_linear = operations[at+1u] == 1.0;
      if(is_linear) { normalized = vec4<f32>(linear(normalized.x),linear(normalized.y),linear(normalized.z),normalized.w); }
      v=vec4<f32>(matrix_row(at,0u,normalized,is_linear),matrix_row(at,1u,normalized,is_linear),matrix_row(at,2u,normalized,is_linear),matrix_row(at,3u,normalized,is_linear));
    } else if(kind == 1u) {
      let rgb=v.xyz/255.0;
      let luma=dot(rgb,vec3<f32>(0.2126,0.7152,0.0722));
      var distance=luma;
      if(operations[at+1u] == 0.0) {
        let uv=vec2<f32>((rgb.z-luma)/1.8556,(rgb.x-luma)/1.5748);
        distance=min(1.0,length(uv-vec2<f32>(operations[at+2u],operations[at+3u]))/0.7071067811865476);
      }
      let threshold=operations[at+4u];
      let softness=operations[at+5u];
      if(softness==0.0 && abs(distance-threshold)<0.00001) { needs_cpu=true; }
      var amount=select(0.0,1.0,distance>threshold);
      if(softness>0.0) { amount=clamp((distance-threshold)/softness,0.0,1.0); }
      var keep=amount*amount*(3.0-2.0*amount);
      if(operations[at+6u] == 1.0) { keep=1.0-keep; }
      if(operations[at+7u] == 1.0) { v=vec4<f32>(255.0,255.0,255.0,v.w); }
      else if(operations[at+1u] == 0.0) {
        let dominant=u32(operations[at+8u]);
        if(dominant == 0u) { v.x=v.x-max(0.0,v.x-max(v.y,v.z))*operations[at+9u]; }
        else if(dominant == 1u) { v.y=v.y-max(0.0,v.y-max(v.x,v.z))*operations[at+9u]; }
        else { v.z=v.z-max(0.0,v.z-max(v.x,v.y))*operations[at+9u]; }
      }
      v.w=v.w*keep;
    } else {
      v=vec4<f32>(channel(v,operations[at+1u],operations[at+2u]),channel(v,operations[at+3u],operations[at+4u]),channel(v,operations[at+5u],operations[at+6u]),channel(v,operations[at+7u],operations[at+8u]));
    }
    let error=operations[at+31u];
    needs_cpu = needs_cpu || near_half(v.x,error) || near_half(v.y,error) || near_half(v.z,error) || near_half(v.w,error);
    var q=vec4<u32>(quantize(v.x),quantize(v.y),quantize(v.z),quantize(v.w));
    // Preserve the exact host Skia put/get quantization between fused nodes.
    if(stage+1u<dimensions.stages) { q=vec4<u32>(canvas_channel(q.x,q.w),canvas_channel(q.y,q.w),canvas_channel(q.z,q.w),q.w); }
    v=vec4<f32>(q);
  }
  output[index]=u32(v.x)|(u32(v.y)<<8u)|(u32(v.z)<<16u)|(u32(v.w)<<24u);
  if(needs_cpu) { atomicOr(&rounding_flags[index/32u],1u<<(index%32u)); }
}
