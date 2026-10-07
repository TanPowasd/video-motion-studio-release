import { ImageData } from '@napi-rs/canvas';
import type { EffectGraphNode } from './effect-graph-schema.js';
import type { EffectSurface } from './raster-pass.js';
import { colorMatrixPixels, mergeGraphChannels } from './graph-channel-pixels.js';
import { keyerPixels } from './keyer-pixels.js';
import { graphDependencies } from './effect-graph.js';
type PointNode = Extract<EffectGraphNode, { type: 'channels' | 'colorMatrix' | 'keyer' }>;
export type GraphPointEnvironment = {
  regions?: boolean;
  tileRows?: number;
  reserveScratch?: (bytes: number) => () => void;
  evaluatedPixels?: (pixels: number) => void;
  readback?: (pixels: number) => void;
};
function alphaBounds(source: EffectSurface, env: GraphPointEnvironment) {
  const w = source.canvas.width,
    h = source.canvas.height,
    release = env.reserveScratch?.(w * h * 4);
  try {
    const pixels = source.ctx.getImageData(0, 0, w, h).data;
    env.readback?.(w * h);
    let x0 = w,
      y0 = h,
      x1 = -1,
      y1 = -1;
    for (let y = 0; y < h; y++) {
      const start = y * w * 4;
      let left = 0;
      while (left < w && !pixels[start + left * 4 + 3]) left++;
      if (left === w) continue;
      let right = w - 1;
      while (right > left && !pixels[start + right * 4 + 3]) right--;
      x0 = Math.min(x0, left);
      x1 = Math.max(x1, right);
      y0 = Math.min(y0, y);
      y1 = y;
    }
    return { x: x0, y: y0, width: Math.max(0, x1 - x0 + 1), height: Math.max(0, y1 - y0 + 1) };
  } finally {
    release?.();
  }
}
/** Exact support bounds plus row tiles: constants/bias that create alpha force full coverage. */
export function graphPointPass(
  node: PointNode,
  inputs: Map<string, EffectSurface>,
  output: EffectSurface,
  env: GraphPointEnvironment,
) {
  const w = output.canvas.width,
    h = output.canvas.height,
    ids = [...new Set(graphDependencies(node))];
  let area = { x: 0, y: 0, width: w, height: h };
  if (env.regions) {
    if (node.type === 'channels') {
      if (typeof node.alpha === 'number') {
        if (node.alpha === 0) area = { x: 0, y: 0, width: 0, height: 0 };
      } else area = alphaBounds(inputs.get(node.alpha.input)!, env);
    } else if (node.type === 'keyer' || node.matrix[19] <= 0)
      area = alphaBounds(inputs.get(node.input)!, env);
  }
  const rows = env.tileRows && env.tileRows > 0 ? env.tileRows : area.height;
  for (let y = area.y; area.width && rows && y < area.y + area.height; y += rows) {
    const height = Math.min(rows, area.y + area.height - y),
      pixels = area.width * height,
      release = env.reserveScratch?.((ids.length + 1) * pixels * 4);
    try {
      const buffers = new Map(
        ids.map((id) => [id, inputs.get(id)!.ctx.getImageData(area.x, y, area.width, height).data]),
      );
      env.readback?.(ids.length * pixels);
      const result =
        node.type === 'channels'
          ? mergeGraphChannels(node, buffers, pixels * 4)
          : node.type === 'colorMatrix'
            ? colorMatrixPixels(buffers.get(node.input)!, node)
            : keyerPixels(buffers.get(node.input)!, node);
      env.evaluatedPixels?.(pixels);
      output.ctx.putImageData(new ImageData(result, area.width, height), area.x, y);
    } finally {
      release?.();
    }
  }
}
