import { fromLinear, toLinear } from './pixels.js';
import type { EffectGraphNode } from './effect-graph-schema.js';

type Channels = Extract<EffectGraphNode, { type: 'channels' }>;
type ColorMatrix = Extract<EffectGraphNode, { type: 'colorMatrix' }>;
const indices = { red: 0, green: 1, blue: 2, alpha: 3, luma: 4 };
/** Straight SDR RGBA channels, normalized to [0,1]. Alpha is independent of color. */
export function mergeGraphChannels(
  node: Channels,
  inputs: Map<string, Uint8ClampedArray>,
  length: number,
) {
  const sources = [node.red, node.green, node.blue, node.alpha].map((channel) =>
      typeof channel === 'number'
        ? { constant: channel * 255 }
        : { pixels: inputs.get(channel.input)!, index: indices[channel.channel] },
    ),
    output = new Uint8ClampedArray(length);
  for (let at = 0; at < length; at += 4)
    for (let c = 0; c < 4; c++) {
      const source = sources[c];
      output[at + c] =
        'constant' in source
          ? source.constant!
          : source.index === 4
            ? source.pixels![at] * 0.2126 +
              source.pixels![at + 1] * 0.7152 +
              source.pixels![at + 2] * 0.0722
            : source.pixels![at + source.index!];
    }
  return output;
}
/** Four rows of RGBA coefficients plus normalized bias; clamp only final output. */
export function colorMatrixPixels(source: Uint8ClampedArray, node: ColorMatrix) {
  const output = new Uint8ClampedArray(source.length),
    m = node.matrix,
    linear = node.colorSpace === 'linear',
    clamp = (v: number) => Math.max(0, Math.min(1, v));
  for (let at = 0; at < source.length; at += 4) {
    const r = linear ? toLinear(source[at] / 255) : source[at] / 255,
      g = linear ? toLinear(source[at + 1] / 255) : source[at + 1] / 255,
      b = linear ? toLinear(source[at + 2] / 255) : source[at + 2] / 255,
      a = source[at + 3] / 255;
    for (let c = 0; c < 4; c++) {
      const i = c * 5,
        value = clamp(m[i] * r + m[i + 1] * g + m[i + 2] * b + m[i + 3] * a + m[i + 4]);
      output[at + c] = (linear && c < 3 ? fromLinear(value) : value) * 255;
    }
  }
  return output;
}
