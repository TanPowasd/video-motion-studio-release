import { ImageData, type SKRSContext2D } from '@napi-rs/canvas';
import { renderEffectGraph } from '../effect-graph-render.js';
import { multiply, nodeMatrix, type Matrix } from '../interaction.js';
import { VmotionError, type Node, type Snapshot } from '../model.js';
import { rasterPass } from '../raster-pass.js';
import {
  temporalActive,
  temporalEffectSchema,
  TemporalPixels,
  temporalSamples,
} from '../temporal-effect.js';
import type { ManagedRenderSurface, NodeCompositorRuntime } from './node-compositor-runtime.js';
import type { NodeRendererRegistry, RenderServices } from './registry.js';
export class NodeCompositor {
  constructor(
    private runtime: NodeCompositorRuntime,
    private registry: NodeRendererRegistry,
    private services: RenderServices,
  ) {}
  async render(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    n: Node,
    frame: number,
    depth: number,
    children?: (target: SKRSContext2D) => Promise<void>,
    sampleSource?: (
      frame: number,
      before: { index: number; id?: string },
    ) => Promise<ManagedRenderSurface>,
    graphSource?: (layerId: string) => Promise<ManagedRenderSurface>,
    nodeSource?: (frame: number) => Promise<Node | undefined>,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Layer nesting exceeds 32');
    this.runtime.timings.paintCalls++;
    const container = ['group', 'component', 'scene', 'drawing'].includes(n.type),
      isolate =
        n.isolation === true ||
        n.effects.some((effect) => effect.enabled !== false) ||
        (container &&
          (n.opacity !== 1 ||
            n.blend !== 'source-over' ||
            n.blur > 0 ||
            n.brightness !== 1 ||
            n.saturation !== 1 ||
            !!n.shadow));
    if (isolate) {
      const layer = this.runtime.surface(ctx),
        matrix = ctx.getTransform();
      try {
        layer.ctx.setTransform(matrix);
        await this.render(
          layer.ctx,
          snapshot,
          {
            ...n,
            isolation: false,
            opacity: 1,
            blend: 'source-over',
            blur: 0,
            brightness: 1,
            saturation: 1,
            shadow: undefined,
            effects: [],
          },
          frame,
          depth,
          children,
          undefined,
          graphSource,
          nodeSource,
        );
        const scale = Math.max(
          Math.hypot(matrix.a, matrix.b) * Math.abs(n.scaleX),
          Math.hypot(matrix.c, matrix.d) * Math.abs(n.scaleY),
        );
        const effects = [
          ...(n.blur ? [{ type: 'blur' as const, radius: n.blur }] : []),
          ...(n.brightness !== 1 || n.saturation !== 1
            ? [
                {
                  type: 'color' as const,
                  brightness: n.brightness,
                  saturation: n.saturation,
                  contrast: 1,
                  hue: 0,
                },
              ]
            : []),
          ...(n.shadow ? [{ type: 'shadow' as const, ...n.shadow }] : []),
          ...n.effects,
        ];
        const ownsSampledOpacity = n.effects.some((effect) =>
            temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
          ),
          legacyCount = effects.length - n.effects.length;
        const environment = {
          programPass: async (
            current: import('@napi-rs/canvas').Canvas,
            effect: Extract<import('../model.js').Effect, { type: 'program' }>,
          ) => {
            const out = this.runtime.surface(ctx);
            try {
              const image = await this.services.programs.render(
                snapshot,
                effect.source,
                frame,
                current.width,
                current.height,
                effect.params,
                current.getContext('2d').getImageData(0, 0, current.width, current.height).data,
              );
              try {
                out.ctx.putImageData(
                  image.getContext('2d').getImageData(0, 0, current.width, current.height),
                  0,
                  0,
                );
              } finally {
                image.width = 1;
                image.height = 1;
              }
              return out;
            } catch (error) {
              out.release();
              throw error;
            }
          },
          makeSurface: (width?: number, height?: number) =>
            this.runtime.surface(ctx, width, height),
          frame,
          fps: snapshot.project.fps.num / snapshot.project.fps.den,
          scale,
          matrix: multiply(
            [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f],
            nodeMatrix(n),
          ),
          offsetMatrix: [matrix.a, matrix.b, matrix.c, matrix.d, matrix.e, matrix.f] as Matrix,
          bounds: { x: 0, y: 0, width: n.width, height: n.height },
          canvasMatrix: this.runtime.canvasMatrix,
          fullFieldScan: this.runtime.fullFieldScan,
          evaluatedPixels: (pixels: number) => {
            this.runtime.fieldPixels += pixels;
            if (this.runtime.fieldPixels > 256 * 1024 * 1024)
              throw new VmotionError(
                'FIELD_BUDGET',
                'Output frame exceeds 256M field/ray scalar evaluations',
              );
          },
        };
        let current = layer.canvas;
        let previous: ManagedRenderSurface | undefined;
        try {
          for (const [effectIndex, effect] of effects.entries()) {
            if ('enabled' in effect && effect.enabled === false) continue;
            let out: ManagedRenderSurface | undefined;
            try {
              if (effect.type === 'motionBlur' || effect.type === 'echo') {
                out = this.runtime.surface(ctx);
                if (
                  !temporalActive(effect as unknown as Record<string, unknown> & { type: string })
                )
                  out.ctx.drawImage(current, 0, 0);
                else {
                  if (!sampleSource)
                    throw new VmotionError(
                      'TEMPORAL_SOURCE',
                      'Temporal layer has no historical graph source',
                    );
                  const { id: _id, enabled: _enabled, ...config } = effect,
                    temporal = temporalEffectSchema.parse(config),
                    length = current.width * current.height * 4,
                    bytes = length * 4;
                  if (this.runtime.temporalBytes + bytes > 256 * 1024 * 1024)
                    throw new VmotionError(
                      'EFFECT_MEMORY',
                      'Temporal accumulators exceed the 256MB budget',
                    );
                  this.runtime.temporalBytes += bytes;
                  try {
                    const pixels = new TemporalPixels(
                      length,
                      temporal.type === 'motionBlur' ? 'average' : temporal.operator,
                    );
                    for (const entry of temporalSamples(
                      temporal,
                      frame,
                      snapshot.project.fps.num / snapshot.project.fps.den,
                    )) {
                      const source = await sampleSource(entry.frame, {
                        index: effectIndex - legacyCount,
                        id: 'id' in effect ? effect.id : undefined,
                      });
                      try {
                        pixels.add(
                          source.ctx.getImageData(0, 0, source.canvas.width, source.canvas.height)
                            .data,
                          entry.weight,
                        );
                      } finally {
                        source.release();
                      }
                    }
                    out.ctx.putImageData(
                      new ImageData(pixels.finish(), current.width, current.height),
                      0,
                      0,
                    );
                  } finally {
                    this.runtime.temporalBytes -= bytes;
                  }
                }
              } else if (effect.type === 'effectGraph') {
                const graph = this.runtime.effectGraphs.resolve(snapshot, effect),
                  key = n.id + ':' + effectIndex;
                if (this.runtime.effectGraphStack.has(key))
                  throw new VmotionError(
                    'EFFECT_GRAPH_CYCLE',
                    'Layer graph bindings contain a rendering cycle',
                    { nodeId: n.id },
                  );
                if (this.runtime.effectGraphStack.size >= 16)
                  throw new VmotionError(
                    'EFFECT_GRAPH_LIMIT',
                    'Layer graph binding depth exceeds 16',
                  );
                this.runtime.effectGraphStack.add(key);
                try {
                  out = await renderEffectGraph(graph, {
                    ...environment,
                    optimize: this.runtime.graphOptimize,
                    regions: this.runtime.graphRegions,
                    tileRows: this.runtime.graphTileRows,
                    traceTimings: this.runtime.graphExecution.trace,
                    execution: (event) =>
                      this.runtime.graphExecution.add(event, {
                        ownerId: n.id,
                        index: effectIndex - legacyCount,
                        ...('id' in effect && effect.id ? { effectId: effect.id } : {}),
                        source: effect.source,
                        output: graph.output,
                        graph: graph.name,
                      }),
                    reserveScratch: (bytes) => {
                      if (
                        this.runtime.layerBytes +
                          this.runtime.temporalBytes +
                          this.runtime.graphScratchBytes +
                          bytes >
                        256 * 1024 * 1024
                      )
                        throw new VmotionError(
                          'EFFECT_GRAPH_MEMORY',
                          'Channel operations exceed the 256MiB live surface/scratch budget',
                          { bytes },
                        );
                      this.runtime.graphScratchBytes += bytes;
                      this.runtime.graphScratchPeakBytes = Math.max(
                        this.runtime.graphScratchPeakBytes,
                        this.runtime.graphScratchBytes,
                      );
                      return () => {
                        this.runtime.graphScratchBytes -= bytes;
                      };
                    },
                    fullFieldScan: this.runtime.fullFieldScan,
                    gpu: this.runtime.gpu,
                    evaluatedPixels: (pixels) => {
                      this.runtime.fieldPixels += pixels;
                      if (this.runtime.fieldPixels > 256 * 1024 * 1024)
                        throw new VmotionError(
                          'FIELD_BUDGET',
                          'Output frame exceeds 256M field/ray scalar evaluations',
                        );
                    },
                    charge: (pixels) => {
                      this.runtime.effectGraphWork += pixels;
                      if (this.runtime.effectGraphWork > 256 * 1024 * 1024)
                        throw new VmotionError(
                          'EFFECT_GRAPH_BUDGET',
                          'Output frame exceeds the effect graph work budget',
                        );
                    },
                    input: async (slot) => {
                      if (slot === 'source') {
                        const copy = this.runtime.surface(ctx);
                        try {
                          copy.ctx.drawImage(current, 0, 0);
                          return copy;
                        } catch (error) {
                          copy.release();
                          throw error;
                        }
                      }
                      const id = Object.hasOwn(effect.bindings, slot)
                        ? effect.bindings[slot]
                        : undefined;
                      if (!id || !graphSource)
                        throw new VmotionError(
                          'EFFECT_GRAPH_BINDING',
                          'A named graph input needs a layer binding',
                          { nodeId: n.id, slot },
                        );
                      return graphSource(id);
                    },
                  });
                } finally {
                  this.runtime.effectGraphStack.delete(key);
                }
              } else if (effect.type === 'program') {
                out = await environment.programPass(current, effect);
              } else {
                out = rasterPass(current, effect, environment);
              }
            } catch (e) {
              out?.release();
              throw e;
            }
            previous?.release();
            current = out.canvas;
            previous = out;
          }
          ctx.save();
          try {
            ctx.resetTransform();
            ctx.filter = 'none';
            ctx.globalAlpha *= ownsSampledOpacity ? 1 : n.opacity;
            ctx.globalCompositeOperation = n.blend;
            ctx.drawImage(current, 0, 0);
          } finally {
            ctx.restore();
          }
        } finally {
          previous?.release();
        }
      } finally {
        layer.release();
      }
      return;
    }
    ctx.save();
    try {
      const parentTransform = ctx.getTransform();
      ctx.transform(...nodeMatrix(n));
      ctx.globalAlpha *= n.opacity;
      ctx.globalCompositeOperation = n.blend;
      const filters: string[] = [];
      if (n.blur > 0) filters.push(`blur(${n.blur}px)`);
      if (n.brightness !== 1) filters.push(`brightness(${n.brightness})`);
      if (n.saturation !== 1) filters.push(`saturate(${n.saturation})`);
      ctx.filter = filters.length ? filters.join(' ') : 'none';
      ctx.fillStyle = n.fill;
      if (n.gradient) {
        const g = n.gradient,
          paint =
            g.type === 'linear'
              ? ctx.createLinearGradient(g.from.x, g.from.y, g.to.x, g.to.y)
              : ctx.createRadialGradient(
                  g.center.x,
                  g.center.y,
                  0,
                  g.center.x,
                  g.center.y,
                  g.radius,
                );
        for (const stop of [...g.stops].sort((a, b) => a.offset - b.offset))
          paint.addColorStop(stop.offset, stop.color);
        ctx.fillStyle = paint;
      }
      ctx.strokeStyle = n.stroke || 'transparent';
      ctx.lineWidth = n.strokeWidth;
      ctx.lineCap = n.strokeCap;
      ctx.lineJoin = n.strokeJoin;
      ctx.miterLimit = Math.max(1, n.strokeMiterLimit);
      ctx.setLineDash(n.strokeDash.map((value) => Math.max(0, value)));
      ctx.lineDashOffset = n.strokeDashOffset;
      if (n.shadow) {
        ctx.shadowColor = n.shadow.color;
        ctx.shadowBlur = n.shadow.blur;
        ctx.shadowOffsetX = n.shadow.x;
        ctx.shadowOffsetY = n.shadow.y;
      }
      if (n.clip) {
        ctx.beginPath();
        ctx.rect(n.clip.x, n.clip.y, n.clip.width, n.clip.height);
        ctx.clip();
      }
      const content = await this.registry.get(n.type).render(
        {
          target: ctx,
          snapshot,
          frame,
          depth,
          parentTransform: [
            parentTransform.a,
            parentTransform.b,
            parentTransform.c,
            parentTransform.d,
            parentTransform.e,
            parentTransform.f,
          ],
          services: this.services,
          nodeSource,
        },
        n,
      );
      if (content.skipChildren) return;
      if (children) await children(ctx);
    } finally {
      ctx.restore();
    }
  }
}
