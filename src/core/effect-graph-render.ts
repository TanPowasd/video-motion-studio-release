import { ImageData } from '@napi-rs/canvas';
import {
  graphDependencies,
  type CompiledEffectGraph,
  type CompiledGraphNode,
} from './effect-graph.js';
import { rasterPass, type EffectSurface, type RasterEnvironment } from './raster-pass.js';
import { inverse, multiply, transform, type Matrix } from './interaction.js';
import { fractalNoise, samplePremultiplied, lumaMatte } from './pixels.js';
import { VmotionError } from './model.js';
import { prepareTexture } from './visual-fields.js';
import { pixelRegion } from './pixel-region.js';
import { graphPointPass } from './graph-point-pass.js';
import type { GraphExecutionEvent } from './graph-execution.js';
import { encodeGpuPoint, type GpuPoints } from './gpu-points.js';
export type GraphEnvironment = RasterEnvironment & {
  gpu?: GpuPoints;
  input: (slot: string) => Promise<EffectSurface>;
  charge?: (pixels: number) => void;
  evaluatedPixels?: (pixels: number) => void;
  fullFieldScan?: boolean;
  reserveScratch?: (bytes: number) => () => void;
  optimize?: boolean;
  regions?: boolean;
  tileRows?: number;
  traceTimings?: boolean;
  execution?: (event: GraphExecutionEvent) => void;
};
const affineIdentity = [1, 0, 0, 1, 0, 0],
  colorIdentity = [1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 1, 0];
function passthroughInput(node: CompiledGraphNode, env: GraphEnvironment) {
  if (!env.optimize) return;
  if (node.type === 'transform' && node.matrix.every((v, i) => v === affineIdentity[i])) {
    const basis = node.space === 'canvas' ? env.canvasMatrix : env.matrix,
      inv = inverse(basis);
    if (inv && multiply(multiply(basis, node.matrix), inv).every((v, i) => v === affineIdentity[i]))
      return node.input;
  }
  if (node.type === 'colorMatrix' && node.matrix.every((v, i) => v === colorIdentity[i]))
    return node.input;
  if (node.type === 'channels') {
    const channels = [node.red, node.green, node.blue, node.alpha],
      first = channels[0];
    if (
      typeof first !== 'number' &&
      channels.every(
        (c, i) =>
          typeof c !== 'number' &&
          c.input === first.input &&
          c.channel === ['red', 'green', 'blue', 'alpha'][i],
      )
    )
      return first.input;
  }
  if (node.type === 'displace' && node.amountX === 0 && node.amountY === 0) return node.input;
  if (node.type === 'blend' && node.opacity === 0) return node.background;
}
export async function renderEffectGraph(
  graph: CompiledEffectGraph,
  env: GraphEnvironment,
): Promise<EffectSurface> {
  const values = new Map<string, { surface: EffectSurface; refs: number }>(),
    uses = new Map<string, number>([[graph.output, 1]]);
  for (const node of graph.nodes)
    for (const input of graphDependencies(node)) uses.set(input, (uses.get(input) ?? 0) + 1);
  let work = 0;
  const get = (id: string) => {
    const value = values.get(id);
    if (!value)
      throw new VmotionError('EFFECT_GRAPH_INPUT', 'Graph input has already been released', { id });
    return value;
  };
  const release = (id: string) => {
    const count = uses.get(id)! - 1;
    uses.set(id, count);
    if (count === 0) {
      const value = get(id);
      values.delete(id);
      if (--value.refs === 0) value.surface.release();
    }
  };
  const matrices = (space: 'layer' | 'canvas') =>
    space === 'canvas' ? env.canvasMatrix : env.matrix;
  try {
    for (let nodeIndex = 0; nodeIndex < graph.nodes.length; nodeIndex++) {
      const node = graph.nodes[nodeIndex];
      let surface: EffectSurface | undefined, alias: ReturnType<typeof get> | undefined;
      const started = env.traceTimings ? performance.now() : 0,
        pass = passthroughInput(node, env);
      let surfacePixels = 0,
        readbackPixels = 0,
        scalarPixels = 0;
      const evaluatedPixels = (pixels: number) => {
        scalarPixels += pixels;
        env.evaluatedPixels?.(pixels);
      };
      try {
        const dependencies = [...new Set(graphDependencies(node))];
        if (
          env.gpu &&
          env.gpu.mode !== 'cpu' &&
          dependencies.length === 1 &&
          encodeGpuPoint(node) &&
          pass === undefined
        ) {
          const source = get(dependencies[0]).surface,
            width = source.canvas.width,
            height = source.canvas.height,
            chain = [node];
          if (env.optimize)
            for (let next = nodeIndex + 1; next < graph.nodes.length && chain.length < 64; next++) {
              const last = chain.at(-1)!,
                candidate = graph.nodes[next],
                inputs = [...new Set(graphDependencies(candidate))];
              if (
                uses.get(last.id) !== 1 ||
                inputs.length !== 1 ||
                inputs[0] !== last.id ||
                !encodeGpuPoint(candidate) ||
                passthroughInput(candidate, env) !== undefined
              )
                break;
              chain.push(candidate);
            }
          if (env.gpu.eligible(width * height, chain.length)) {
            // Account for logical stage work before executing, even when intermediates are fused.
            const cost = width * height * chain.length * 2;
            if (work + cost > 256 * 1024 * 1024)
              throw new VmotionError('EFFECT_GRAPH_BUDGET', 'GPU chain exceeds graph work budget');
            const releaseScratch = env.reserveScratch?.(width * height * 8);
            try {
              const input = source.ctx.getImageData(0, 0, width, height).data,
                result = await env.gpu.run(input, width, height, chain);
              readbackPixels += width * height;
              if (result) {
                work += cost;
                env.charge?.(cost);
                surface = env.makeSurface();
                surface.ctx.putImageData(new ImageData(result, width, height), 0, 0);
                const last = chain.at(-1)!;
                values.set(last.id, { surface, refs: 1 });
                surface = undefined;
                for (const input of graphDependencies(node)) release(input);
                for (const [index, step] of chain.entries())
                  env.execution?.({
                    nodeId: step.id,
                    type: step.type,
                    kind: index === chain.length - 1 ? 'surface' : 'fused',
                    surfacePixels: index === chain.length - 1 ? width * height : 0,
                    readbackPixels: index === 0 ? width * height : 0,
                    scalarPixels: 0,
                    gpuPixels: width * height,
                    fused: chain.length > 1,
                    ...(env.traceTimings
                      ? { elapsedMs: index === chain.length - 1 ? performance.now() - started : 0 }
                      : {}),
                  });
                nodeIndex += chain.length - 1;
                continue;
              }
            } finally {
              releaseScratch?.();
            }
          }
        }
        if (node.type === 'alias' || pass !== undefined) {
          alias = get(node.type === 'alias' ? node.input : pass!);
          alias.refs++;
        } else if (node.type === 'input') surface = await env.input(node.slot);
        else if (node.type === 'pass')
          surface =
            node.effect.type === 'program'
              ? await (env.programPass?.(get(node.input).surface.canvas, node.effect) ??
                  Promise.reject(
                    new VmotionError(
                      'PROGRAM_CONTEXT',
                      'Custom effect needs project renderer context',
                    ),
                  ))
              : rasterPass(get(node.input).surface.canvas, node.effect, {
                  ...env,
                  evaluatedPixels,
                });
        else {
          surface = env.makeSurface();
          const out = surface.ctx,
            canvas = surface.canvas,
            w = canvas.width,
            h = canvas.height;
          work += w * h;
          env.charge?.(w * h);
          if (work > 256 * 1024 * 1024)
            throw new VmotionError(
              'EFFECT_GRAPH_BUDGET',
              'Graph exceeds 256M node-pixel evaluations',
            );
          if (node.type === 'blend') {
            out.drawImage(get(node.background).surface.canvas, 0, 0);
            out.globalAlpha = node.opacity;
            out.globalCompositeOperation = node.mode;
            out.drawImage(get(node.foreground).surface.canvas, 0, 0);
          } else if (
            node.type === 'channels' ||
            node.type === 'colorMatrix' ||
            node.type === 'keyer'
          ) {
            graphPointPass(
              node,
              new Map([...new Set(graphDependencies(node))].map((id) => [id, get(id).surface])),
              surface,
              {
                regions: env.regions,
                tileRows: env.tileRows,
                reserveScratch: env.reserveScratch,
                readback: (pixels) => {
                  readbackPixels += pixels;
                },
                evaluatedPixels,
              },
            );
          } else if (node.type === 'mask') {
            out.drawImage(get(node.input).surface.canvas, 0, 0);
            let matte = get(node.matte).surface.canvas;
            const temporary: EffectSurface[] = [];
            try {
              if (node.mode.startsWith('luma')) {
                const copy = env.makeSurface();
                temporary.push(copy);
                const image = matte.getContext('2d').getImageData(0, 0, w, h);
                readbackPixels += w * h;
                copy.ctx.putImageData(new ImageData(lumaMatte(image.data), w, h), 0, 0);
                matte = copy.canvas;
              }
              if (node.feather) {
                const blurred = env.makeSurface();
                temporary.push(blurred);
                blurred.ctx.filter = `blur(${node.feather * env.scale}px)`;
                blurred.ctx.drawImage(matte, 0, 0);
                matte = blurred.canvas;
              }
              out.globalCompositeOperation = node.mode.endsWith('Inverted')
                ? 'destination-out'
                : 'destination-in';
              out.drawImage(matte, 0, 0);
            } finally {
              for (const temp of temporary) temp.release();
            }
          } else if (node.type === 'transform') {
            const basis = matrices(node.space),
              inv = inverse(basis);
            const source = get(node.input).surface.canvas;
            if (!inv) {
              const pixels = source.getContext('2d').getImageData(0, 0, w, h).data;
              readbackPixels += w * h;
              if (pixels.some((value, index) => index % 4 === 3 && value > 0))
                throw new VmotionError(
                  'EFFECT_GRAPH_MATRIX',
                  'Graph transform uses a singular coordinate basis with visible input',
                  { nodeId: node.id },
                );
            } else {
              out.setTransform(...multiply(multiply(basis, node.matrix), inv));
              out.drawImage(source, 0, 0);
            }
          } else if (node.type === 'solid') {
            const matrix = matrices(node.space),
              region =
                node.region ??
                (node.space === 'canvas'
                  ? { x: 0, y: 0, width: w / env.canvasMatrix[0], height: h / env.canvasMatrix[3] }
                  : env.bounds);
            out.setTransform(...matrix);
            out.globalAlpha = node.opacity;
            out.fillStyle = node.color;
            out.fillRect(region.x, region.y, region.width, region.height);
          } else if (node.type === 'noise' || node.type === 'texture') {
            const matrix = matrices(node.space),
              inv = inverse(matrix);
            const region =
                node.region ??
                (node.space === 'canvas'
                  ? { x: 0, y: 0, width: w / env.canvasMatrix[0], height: h / env.canvasMatrix[3] }
                  : env.bounds),
              low =
                node.type === 'noise'
                  ? [1, 3, 5].map((i) => parseInt(node.low.slice(i, i + 2), 16))
                  : [],
              high =
                node.type === 'noise'
                  ? [1, 3, 5].map((i) => parseInt(node.high.slice(i, i + 2), 16))
                  : [],
              texture = node.type === 'texture' ? prepareTexture(node.settings) : undefined,
              colorTable = texture
                ? Array.from({ length: 1024 }, (_, i) => texture.color(i / 1023))
                : undefined,
              area = env.fullFieldScan
                ? { x0: 0, y0: 0, x1: w - 1, y1: h - 1, pixels: w * h }
                : pixelRegion(matrix, region, w, h),
              tileWidth = Math.max(0, area.x1 - area.x0 + 1),
              tileHeight = Math.max(0, area.y1 - area.y0 + 1),
              pixels = new Uint8ClampedArray(tileWidth * tileHeight * 4);
            if (inv)
              for (let y = area.y0; y <= area.y1; y++)
                for (let x = area.x0; x <= area.x1; x++) {
                  const p = transform(inv, { x: x + 0.5, y: y + 0.5 });
                  if (
                    p.x < region.x ||
                    p.y < region.y ||
                    p.x >= region.x + region.width ||
                    p.y >= region.y + region.height
                  )
                    continue;
                  const n =
                      node.type === 'texture'
                        ? texture!.value(p.x - region.x, p.y - region.y)
                        : fractalNoise(
                            (p.x - region.x) / node.scale + node.evolution,
                            (p.y - region.y) / node.scale + node.evolution * 0.73,
                            node.seed,
                            node.octaves,
                          ),
                    at = ((y - area.y0) * tileWidth + x - area.x0) * 4;
                  if (colorTable) {
                    const color = colorTable[Math.round(n * 1023)];
                    for (let c = 0; c < 3; c++) pixels[at + c] = color[c];
                    pixels[at + 3] = color[3] * node.opacity;
                  } else {
                    for (let c = 0; c < 3; c++) pixels[at + c] = low[c] + (high[c] - low[c]) * n;
                    pixels[at + 3] = node.opacity * 255;
                  }
                }
            evaluatedPixels(area.pixels);
            if (tileWidth && tileHeight)
              out.putImageData(new ImageData(pixels, tileWidth, tileHeight), area.x0, area.y0);
          } else if (node.type === 'displace') {
            readbackPixels += 2 * w * h;
            const source = get(node.input)
                .surface.canvas.getContext('2d')
                .getImageData(0, 0, w, h).data,
              map = get(node.map).surface.canvas.getContext('2d').getImageData(0, 0, w, h).data,
              result = new Uint8ClampedArray(source),
              channel = (at: number, name: string) =>
                name === 'alpha'
                  ? map[at + 3] / 255
                  : name === 'luma'
                    ? (map[at] * 0.2126 + map[at + 1] * 0.7152 + map[at + 2] * 0.0722) / 255
                    : map[at + { red: 0, green: 1, blue: 2 }[name as 'red' | 'green' | 'blue']] /
                      255;
            let x0 = w,
              y0 = h,
              x1 = -1,
              y1 = -1;
            if (node.mapAlpha === 'ignore' || env.fullFieldScan) {
              x0 = 0;
              y0 = 0;
              x1 = w - 1;
              y1 = h - 1;
            } else
              for (let at = 3; at < map.length; at += 4)
                if (map[at]) {
                  const p = (at - 3) / 4,
                    x = p % w,
                    y = Math.floor(p / w);
                  x0 = Math.min(x0, x);
                  x1 = Math.max(x1, x);
                  y0 = Math.min(y0, y);
                  y1 = Math.max(y1, y);
                }
            const basis = matrices(node.space);
            for (let y = y0; y <= y1; y++)
              for (let x = x0; x <= x1; x++) {
                const at = (y * w + x) * 4,
                  a = node.mapAlpha === 'ignore' ? 1 : map[at + 3] / 255,
                  dx = (channel(at, node.channelX) - node.midpointX) * 2 * node.amountX * a,
                  dy = (channel(at, node.channelY) - node.midpointY) * 2 * node.amountY * a;
                if (!dx && !dy) continue;
                result.fill(0, at, at + 4);
                samplePremultiplied(
                  source,
                  w,
                  h,
                  x + basis[0] * dx + basis[2] * dy,
                  y + basis[1] * dx + basis[3] * dy,
                  result,
                  at,
                  node.edge,
                );
              }
            evaluatedPixels(Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1));
            out.putImageData(new ImageData(result, w, h), 0, 0);
          }
        }
        if (surface) {
          surfacePixels = surface.canvas.width * surface.canvas.height;
          work += surface.canvas.width * surface.canvas.height;
          env.charge?.(surface.canvas.width * surface.canvas.height);
          if (work > 256 * 1024 * 1024)
            throw new VmotionError(
              'EFFECT_GRAPH_BUDGET',
              'Graph exceeds 256M node-pixel evaluations',
            );
          values.set(node.id, { surface, refs: 1 });
          surface = undefined;
        } else if (alias) {
          values.set(node.id, alias);
          alias = undefined;
        }
        for (const input of graphDependencies(node)) release(input);
        env.execution?.({
          nodeId: node.id,
          type: node.type,
          kind: node.type === 'alias' ? 'alias' : pass !== undefined ? 'passthrough' : 'surface',
          surfacePixels,
          readbackPixels,
          scalarPixels,
          ...(env.traceTimings ? { elapsedMs: performance.now() - started } : {}),
        });
      } catch (error) {
        surface?.release();
        if (alias && --alias.refs === 0) alias.surface.release();
        throw new VmotionError(
          error instanceof VmotionError ? error.code : 'EFFECT_GRAPH_RENDER',
          (error as Error).message,
          {
            nodeId: node.id,
            graph: graph.name,
            ...(error instanceof VmotionError && typeof error.details === 'object'
              ? error.details
              : {}),
          },
        );
      }
    }
    const output = get(graph.output);
    values.delete(graph.output);
    return output.surface;
  } finally {
    const released = new Set<EffectSurface>();
    for (const value of values.values())
      if (!released.has(value.surface)) {
        released.add(value.surface);
        value.surface.release();
      }
  }
}
