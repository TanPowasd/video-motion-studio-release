import type { EffectGraphNode } from './effect-graph-schema.js';
type Keyer = Extract<EffectGraphNode, { type: 'keyer' }>;
const clamp = (v: number) => Math.max(0, Math.min(1, v));
const uv = (r: number, g: number, b: number) => {
  const y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  return [(b - y) / 1.8556, (r - y) / 1.5748];
};
/** Local SDR keying: encoded Rec.709 UV distance or luma, preserving source alpha. */
export function keyerPixels(source: Uint8ClampedArray, node: Keyer) {
  const key = [1, 3, 5].map((i) => parseInt(node.color.slice(i, i + 2), 16) / 255),
    keyUv = uv(key[0], key[1], key[2]),
    dominant = key.indexOf(Math.max(...key)),
    output = new Uint8ClampedArray(source.length);
  for (let at = 0; at < source.length; at += 4) {
    const r = source[at] / 255,
      g = source[at + 1] / 255,
      b = source[at + 2] / 255,
      y = r * 0.2126 + g * 0.7152 + b * 0.0722;
    const distance =
      node.mode === 'luma'
        ? y
        : Math.min(
            1,
            Math.hypot((b - y) / 1.8556 - keyUv[0], (r - y) / 1.5748 - keyUv[1]) / Math.SQRT1_2,
          );
    const linear = node.softness
        ? clamp((distance - node.threshold) / node.softness)
        : distance > node.threshold
          ? 1
          : 0,
      keep = node.invert
        ? 1 - linear * linear * (3 - 2 * linear)
        : linear * linear * (3 - 2 * linear);
    if (node.view === 'matte') output.fill(255, at, at + 3);
    else {
      output[at] = source[at];
      output[at + 1] = source[at + 1];
      output[at + 2] = source[at + 2];
      if (node.mode === 'chroma' && node.spill) {
        const other = Math.max(
          source[at + ((dominant + 1) % 3)],
          source[at + ((dominant + 2) % 3)],
        );
        output[at + dominant] -= Math.max(0, source[at + dominant] - other) * node.spill;
      }
    }
    output[at + 3] = source[at + 3] * keep;
  }
  return output;
}
