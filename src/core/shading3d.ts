import type { Scene3DData } from './scene3d-schema.js';
import { VmotionError } from './model.js';
import type { ResolvedMaterial3D } from './material3d-schema.js';
export type Triple = [number, number, number];
export interface RasterMaterial {
  model: 'standard' | 'unlit';
  base: Triple;
  metallic: number;
  roughness: number;
  emissive: Triple;
  doubleSided: boolean;
}
export interface RasterLighting {
  camera: Triple;
  viewDirection?: Triple;
  ambient: number;
  exposure: number;
  toneMapping: 'none' | 'reinhard' | 'aces';
  lights: Array<{
    type: 'directional' | 'point';
    vector: Triple;
    color: Triple;
    intensity: number;
    range?: number;
  }>;
}
export function validateShading(
  material: RasterMaterial,
  lighting: RasterLighting,
  attributes: number[][],
) {
  const vec = (v: number[] | undefined) => !!v && v.length === 3 && v.every(Number.isFinite);
  if (
    !['standard', 'unlit'].includes(material.model) ||
    !vec(material.base) ||
    material.base.some((v) => v < 0 || v > 1) ||
    !vec(material.emissive) ||
    material.emissive.some((v) => v < 0 || v > 8) ||
    !Number.isFinite(material.metallic) ||
    material.metallic < 0 ||
    material.metallic > 1 ||
    !Number.isFinite(material.roughness) ||
    material.roughness < 0.05 ||
    material.roughness > 1 ||
    typeof material.doubleSided !== 'boolean' ||
    attributes.length !== 3 ||
    attributes.some((v) => v.length !== 6 || !v.every(Number.isFinite))
  )
    throw new VmotionError('MATERIAL3D_INPUT', 'Invalid material or vertex attributes');
  if (
    !vec(lighting.camera) ||
    (lighting.viewDirection && !vec(lighting.viewDirection)) ||
    !Number.isFinite(lighting.ambient) ||
    lighting.ambient < 0 ||
    lighting.ambient > 1 ||
    !Number.isFinite(lighting.exposure) ||
    lighting.exposure < 0.01 ||
    lighting.exposure > 16 ||
    !['none', 'reinhard', 'aces'].includes(lighting.toneMapping) ||
    lighting.lights.length > 8
  )
    throw new VmotionError('MATERIAL3D_INPUT', 'Invalid lighting context');
  for (const light of lighting.lights)
    if (
      !['directional', 'point'].includes(light.type) ||
      !vec(light.vector) ||
      !vec(light.color) ||
      light.color.some((v) => v < 0 || v > 1) ||
      !Number.isFinite(light.intensity) ||
      light.intensity < 0 ||
      light.intensity > 1000 ||
      (light.range !== undefined && (!Number.isFinite(light.range) || light.range <= 0))
    )
      throw new VmotionError('MATERIAL3D_INPUT', 'Invalid light');
}
const normalize = (x: number, y: number, z: number): Triple => {
  const length = Math.hypot(x, y, z);
  return length ? [x / length, y / length, z / length] : [0, 0, 0];
};
export const srgbToLinear = (value: number) =>
  value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
const color = (hex: string): Triple =>
  [1, 3, 5].map((i) => srgbToLinear(parseInt(hex.slice(i, i + 2), 16) / 255)) as Triple;
export function rasterMaterial(material: ResolvedMaterial3D, base: string): RasterMaterial {
  return {
    model: material.model,
    base: color(base),
    metallic: material.metallic,
    roughness: material.roughness,
    emissive: color(material.emissive).map((v) => v * material.emissiveIntensity) as Triple,
    doubleSided: material.doubleSided,
  };
}
export function rasterLighting(data: Scene3DData): RasterLighting {
  const camera = data.camera,
    options = data.options,
    lights = options.lights ?? [
      {
        type: 'directional' as const,
        direction: options.light ?? { x: -0.4, y: 0.8, z: 1 },
        color: '#ffffff',
        intensity: 3,
      },
    ];
  return {
    camera: [camera.position.x, camera.position.y, camera.position.z],
    ...(camera.projection === 'orthographic'
      ? {
          viewDirection: normalize(
            camera.position.x - camera.target.x,
            camera.position.y - camera.target.y,
            camera.position.z - camera.target.z,
          ),
        }
      : {}),
    ambient: options.ambient ?? 0.3,
    exposure: options.exposure ?? 1,
    toneMapping: options.toneMapping ?? 'none',
    lights: lights.map((light) => ({
      type: light.type,
      vector:
        light.type === 'directional'
          ? normalize(light.direction.x, light.direction.y, light.direction.z)
          : [light.position.x, light.position.y, light.position.z],
      color: color(light.color),
      intensity: light.intensity,
      ...(light.type === 'point' && light.range !== undefined ? { range: light.range } : {}),
    })),
  };
}
const output = (value: number, lighting: RasterLighting) => {
  let v = Math.max(0, value * lighting.exposure);
  if (lighting.toneMapping === 'reinhard') v = v / (1 + v);
  else if (lighting.toneMapping === 'aces')
    v = (v * (2.51 * v + 0.03)) / (v * (2.43 * v + 0.59) + 0.14);
  v = Math.min(1, Math.max(0, v));
  const s = v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055;
  return Math.round(Math.min(255, Math.max(0, s * 255)));
};
/** GGX/Smith/Schlick direct lighting in linear RGB; ambient is a bounded heuristic, not environment IBL. */
export function shadeFragment(
  material: RasterMaterial,
  lighting: RasterLighting,
  world: Triple,
  normal: Triple,
): Triple {
  const c: Triple = [...material.emissive];
  if (material.model === 'unlit') {
    for (let i = 0; i < 3; i++) c[i] += material.base[i];
    return c.map((v) => output(v, lighting)) as Triple;
  }
  let n = normalize(...normal);
  const view =
      lighting.viewDirection ??
      normalize(
        lighting.camera[0] - world[0],
        lighting.camera[1] - world[1],
        lighting.camera[2] - world[2],
      ),
    dot = (a: Triple, b: Triple) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  if (material.doubleSided && dot(n, view) < 0) n = n.map((v) => -v) as Triple;
  const nv = Math.max(0, dot(n, view)),
    f0 = material.base.map((v) => 0.04 * (1 - material.metallic) + v * material.metallic) as Triple,
    a2 = material.roughness ** 4;
  for (let i = 0; i < 3; i++)
    c[i] += lighting.ambient * (material.base[i] * (1 - material.metallic) + f0[i] * 0.15);
  for (const light of lighting.lights) {
    const delta =
        light.type === 'directional'
          ? light.vector
          : (light.vector.map((v, i) => v - world[i]) as Triple),
      distance = Math.hypot(...delta),
      direction = light.type === 'directional' ? delta : normalize(...delta),
      nl = Math.max(0, dot(n, direction));
    if (nl <= 0 || nv <= 0) continue;
    let intensity = light.intensity;
    if (light.type === 'point') {
      intensity /= Math.max(distance * distance, 0.01);
      if (light.range !== undefined)
        intensity *= Math.max(0, 1 - (distance / light.range) ** 4) ** 2;
    }
    const half = normalize(view[0] + direction[0], view[1] + direction[1], view[2] + direction[2]),
      nh = Math.max(0, dot(n, half)),
      vh = Math.max(0, dot(view, half)),
      denominator = nh * nh * (a2 - 1) + 1,
      D = a2 / (Math.PI * denominator * denominator),
      g1 = (value: number) => (2 * value) / (value + Math.sqrt(a2 + (1 - a2) * value * value)),
      G = g1(nl) * g1(nv),
      fresnel = (1 - vh) ** 5;
    for (let i = 0; i < 3; i++) {
      const F = f0[i] + (1 - f0[i]) * fresnel,
        diffuse = ((1 - F) * (1 - material.metallic) * material.base[i]) / Math.PI,
        specular = (D * G * F) / Math.max(4 * nl * nv, 1e-8);
      c[i] += (diffuse + specular) * light.color[i] * intensity * nl;
    }
  }
  return c.map((v) => output(v, lighting)) as Triple;
}
