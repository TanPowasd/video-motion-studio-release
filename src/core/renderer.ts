import { renderSizeIssue } from './still-schema.js';
import {
  GlobalFonts,
  ImageData,
  createCanvas,
  type Canvas,
  type SKRSContext2D,
} from '@napi-rs/canvas';
import { readFile } from 'node:fs/promises';
import path, { resolve as pathResolve } from 'node:path';
import { analyzeAudio, audioAt, type AudioAnalysis } from '../media/analysis.js';
import { fingerprint } from '../media/ffmpeg.js';
import { audioSourceFile } from '../media/sound-source.js';
import { evaluateScene3D, type MeshInstance3D } from '../sdk/matrix3d.js';
import { initializeBundledFonts, nativeTextFont } from './bundled-fonts.js';
import { clipGain, clipSourceFrame } from './clip-window.js';
import { ComponentHost } from './components.js';
import { composeGenerated, isolateGroup, prefixNodes } from './composition.js';
import { contentTiming, contextFramesSchema, timeControlled } from './content-time.js';
import { drawingInkBounds, normalizeDrawing } from './drawing-renderer.js';
import { evaluateDrivers, hasDrivers, type DriverContext } from './drivers.js';
import { EffectGraphResolver } from './effect-graph-cache.js';
import { GeometryCache } from './geometry-cache.js';
import { GpuPoints, type GpuMode } from './gpu-points.js';
import { GraphExecution } from './graph-execution.js';
import {
  cameraMatrix,
  inverse,
  multiply,
  nodeMatrix,
  transform,
  type Bounds,
  type InteractionLayer,
  type Matrix,
} from './interaction.js';
import { resolveSceneMeshes } from './mesh-resources.js';
import { VmotionError, nodeSchema, type Node, type Scene, type Snapshot } from './model.js';
import { NativeEvaluator } from './native.js';
import { lumaMatte } from './pixels.js';
import { builtinNodeRenderers } from './rendering/builtin-renderers.js';
import type { NodeCompositorRuntime } from './rendering/node-compositor-runtime.js';
import { NodeCompositor } from './rendering/node-compositor.js';
import type { RenderServices } from './rendering/registry.js';
import { RenderMediaResources } from './rendering/render-media.js';
import {ProgramHost} from './programs/program-host.js';
import { SurfacePool } from './surface-pool.js';
import { TemplateResolver } from './template-resource.js';
import { temporalActive } from './temporal-effect.js';
import { ThemeResolver } from './theme.js';
import { frameSeconds } from './time.js';
import { TypographyLayout, invalidateTypographyFonts } from './typography.js';
import { GlyphSetResolver } from './glyphs/glyph-resources.js';
import { MixedTextMeasurer, glyphSourceFor, type GlyphTextSource } from './glyphs/glyph-text.js';
import { shapeBounds, shapePath } from './vector.js';

export type RenderDriverScope = Pick<DriverContext, 'width' | 'height' | 'duration'> & {
  group?: { id: string; sourceAt: (frame: number) => Promise<Node[]> };
};
export type RendererOptions = {
  width?: number;
  height?: number;
  sceneId?: string;
  path?: string[];
  contextFrames?: number[];
  mediaQuality?: 'original' | 'auto';
};
export class Renderer {
  readonly nodeRenderers = builtinNodeRenderers();
  readonly programs:ProgramHost;
  private readonly media: RenderMediaResources;
  private compositor: NodeCompositor;

  readonly surfaces = new SurfacePool();
  readonly typography: TypographyLayout;
  readonly glyphSets: GlyphSetResolver;
  readonly geometry: GeometryCache<ReturnType<typeof shapePath>>;
  readonly themes: ThemeResolver;
  readonly templates: TemplateResolver;
  readonly effectGraphs: EffectGraphResolver;
  readonly graphExecution: GraphExecution;
  private timings = { paintCalls: 0, componentCalls: 0, componentMs: 0, evaluateMs: 0 };
  performanceInfo() {
    return {
      ...this.timings,
      typography: this.typography.report(),
      glyphSets: this.glyphSets.report(),
      geometry: this.geometry.report(),
      themes: this.themes.report(),
      templates: this.templates.report(),
      effectGraphs: this.effectGraphs.report(),
      graphExecution: this.graphExecution.report(),
      nativeAnimation: this.native.diagnostics(),
      gpu: this.gpu.report(),
      programs:this.programs.report(),
      liveLayerBytes: this.layerBytes,
      temporalPixels: this.temporalWork,
      temporalQueries: this.temporalQueries,
      effectGraphPixels: this.effectGraphWork,
      fieldPixels: this.fieldPixels,
      graphScratchBytes: this.graphScratchBytes,
      graphScratchPeakBytes: this.graphScratchPeakBytes,
      components: this.components.diagnostics(),
      surfaces: this.surfaces.report(),
    };
  }
  readonly components: ComponentHost;
  readonly native: NativeEvaluator;
  readonly gpu: GpuPoints;

  private rendering = 0;

  get busy() {
    return this.rendering > 0 || this.audioControllers.size > 0;
  }
  mediaInfo() {
    return this.media.info();
  }

  async clearMediaCache() {
    if (this.busy) throw new VmotionError('CACHE_BUSY', 'Renderer is using media caches');
    await this.media.clear();
  }
  private fonts = new Set<string>();
  private layerBytes = 0;
  private canvasMatrix: Matrix = [1, 0, 0, 1, 0, 0];
  private temporalBytes = 0;
  private temporalWork = 0;
  private temporalQueries = 0;
  private temporalDepth = 0;
  private effectGraphStack = new Set<string>();
  private effectGraphWork = 0;
  private fieldPixels = 0;
  private graphScratchBytes = 0;
  private graphScratchPeakBytes = 0;
  private graphOptimize = true;
  private graphRegions = true;
  private graphTileRows = 128;
  private fullFieldScan = false;
  private driverBudget = { remaining: 200000 };
  private audioAnalysis = new Map<string, Promise<AudioAnalysis>>();
  private audioControllers = new Map<string, AbortController>();
  constructor(
    readonly root: string,
    options: {
      surfacePoolBytes?: number;
      fullFieldScan?: boolean;
      graphicsCache?: boolean;
      mediaFraming?: 'direct' | 'concat';
      resourceCache?: boolean;
      graphCache?: boolean;
      graphOptimize?: boolean;
      graphRegions?: boolean;
      graphTileRows?: number;
      graphTrace?: boolean;
      nativeCache?: boolean;
      gpu?: GpuMode;
      gpuStrict?: boolean;
    } = {},
  ) {
    initializeBundledFonts();
    this.native = new NativeEvaluator({ cache: options.nativeCache });
    this.gpu = new GpuPoints(this.native.binary, {
      mode: options.gpu,
      strictAfterReady: options.gpuStrict,
    });
    const budget = options.graphicsCache === false ? 0 : 8 * 1024 * 1024;
    this.typography = new TypographyLayout(budget);
    this.glyphSets = new GlyphSetResolver(options.resourceCache === false ? 0 : 4 * 1024 * 1024);
    this.geometry = new GeometryCache(budget);
    this.themes = new ThemeResolver(options.resourceCache === false ? 0 : 4 * 1024 * 1024);
    this.templates = new TemplateResolver(options.resourceCache === false ? 0 : 8 * 1024 * 1024);
    this.effectGraphs = new EffectGraphResolver(
      options.graphCache === false || options.resourceCache === false ? 0 : 8 * 1024 * 1024,
    );
    this.graphOptimize = options.graphOptimize ?? true;
    this.graphRegions = options.graphRegions ?? true;
    this.graphTileRows = options.graphTileRows ?? 128;
    this.graphExecution = new GraphExecution(options.graphTrace ?? false);
    if (options.surfacePoolBytes !== undefined)
      this.surfaces = new SurfacePool(options.surfacePoolBytes);
    this.fullFieldScan = options.fullFieldScan ?? false;
    this.media = new RenderMediaResources(options.mediaFraming ?? 'direct');
    this.components = new ComponentHost(root);
    this.programs=new ProgramHost(root,this.gpu);
    this.compositor = new NodeCompositor(
      this.compositorRuntime(),
      this.nodeRenderers,
      this.nodeRenderServices(),
    );
  }
  async render(snapshot: Snapshot, frame: number, options: RendererOptions = {}): Promise<Canvas> {
    this.rendering++;
    try {
      if (this.gpu.mode === 'gpu') await this.gpu.initialize();
      return await this.renderImpl(snapshot, frame, options);
    } finally {
      this.rendering--;
    }
  }
  private async renderImpl(
    snapshot: Snapshot,
    frame: number,
    options: RendererOptions = {},
  ): Promise<Canvas> {
    this.timings = { paintCalls: 0, componentCalls: 0, componentMs: 0, evaluateMs: 0 };
    this.temporalWork = 0;
    this.temporalQueries = 0;
    this.effectGraphWork = 0;
    this.fieldPixels = 0;
    this.media.quality = options.mediaQuality ?? 'original';
    this.media.used = [];
    this.driverBudget = { remaining: 200000 };
    if (
      (options.path?.length || options.sceneId) &&
      (options.width === undefined || options.height === undefined)
    ) {
      const scope = await this.inspectComposition(
        snapshot,
        options.sceneId ?? snapshot.scenes[0].id,
        frame,
        options.path,
        options.contextFrames,
      );
      options = {
        ...options,
        width: options.width ?? scope.width,
        height: options.height ?? scope.height,
      };
    }
    const motion = snapshot.project.motionBlur;
    if (!motion || motion.shutterAngle === 0) return this.frame(snapshot, frame, options);
    if (!Number.isFinite(frame) || frame < 0)
      throw new VmotionError('FRAME_RANGE', 'Frame must be finite and nonnegative');
    const width = Math.round(options.width ?? snapshot.project.width),
      height = Math.round(options.height ?? snapshot.project.height);
    const blurIssue = renderSizeIssue(width, height, isStillTarget(snapshot, options.sceneId));
    if (blurIssue) throw new VmotionError('RESOLUTION', `Motion blur: ${blurIssue}`);
    const accumulator = new Float32Array(width * height * 4),
      linear = Array.from({ length: 256 }, (_, v) => {
        const c = v / 255;
        return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
    for (let sample = 0; sample < motion.samples; sample++) {
      const t = Math.max(
          0,
          frame + (((sample + 0.5) / motion.samples - 0.5) * motion.shutterAngle) / 360,
        ),
        canvas = await this.frame(snapshot, t, options),
        pixels = canvas.getContext('2d').getImageData(0, 0, width, height).data;
      for (let i = 0; i < pixels.length; i += 4) {
        const alpha = pixels[i + 3] / 255;
        accumulator[i] += linear[pixels[i]] * alpha;
        accumulator[i + 1] += linear[pixels[i + 1]] * alpha;
        accumulator[i + 2] += linear[pixels[i + 2]] * alpha;
        accumulator[i + 3] += alpha;
      }
      canvas.width = 1;
      canvas.height = 1;
    }
    const result = createCanvas(width, height),
      pixels = new Uint8ClampedArray(width * height * 4);
    for (let i = 0; i < pixels.length; i += 4) {
      const sumAlpha = accumulator[i + 3];
      if (sumAlpha === 0) continue;
      for (let c = 0; c < 3; c++) {
        const value = accumulator[i + c] / sumAlpha;
        pixels[i + c] = Math.round(
          255 * (value <= 0.0031308 ? value * 12.92 : 1.055 * value ** (1 / 2.4) - 0.055),
        );
      }
      pixels[i + 3] = Math.round((sumAlpha / motion.samples) * 255);
    }
    result.getContext('2d').putImageData(new ImageData(pixels, width, height), 0, 0);
    return result;
  }
  private async frame(
    snapshot: Snapshot,
    frame: number,
    options: {
      width?: number;
      height?: number;
      sceneId?: string;
      path?: string[];
      contextFrames?: number[];
      nodesAt?: (frame: number) => Promise<Node[]>;
      driverContext?: RenderDriverScope;
    } = {},
  ): Promise<Canvas> {
    if (options.path?.length) {
      const inspected = await this.inspectComposition(
        snapshot,
        options.sceneId ?? snapshot.scenes[0].id,
        frame,
        options.path,
        options.contextFrames,
      );
      return this.frame(
        {
          ...snapshot,
          project: { ...snapshot.project, width: inspected.width, height: inspected.height },
          scenes: [
            ...snapshot.scenes
              .filter((s) => s.id !== inspected.scene.id)
              .map((scene) => ({
                ...scene,
                width: scene.width ?? snapshot.project.width,
                height: scene.height ?? snapshot.project.height,
              })),
            inspected.scene,
          ],
        },
        frame,
        {
          ...options,
          path: undefined,
          sceneId: inspected.scene.id,
          driverContext: inspected.driverContext,
          nodesAt: async (at) =>
            (
              await this.inspectComposition(
                snapshot,
                options.sceneId ?? snapshot.scenes[0].id,
                at,
                options.path,
                options.contextFrames,
              )
            ).scene.nodes,
        },
      );
    }
    if (!Number.isFinite(frame) || frame < 0)
      throw new VmotionError('FRAME_RANGE', 'Frame must be finite and nonnegative');
    const width = Math.round(options.width ?? snapshot.project.width),
      height = Math.round(options.height ?? snapshot.project.height);
    const sizeIssue = renderSizeIssue(width, height, isStillTarget(snapshot, options.sceneId));
    if (sizeIssue) throw new VmotionError('RESOLUTION', sizeIssue);
    for (const asset of snapshot.project.assets.filter((a) => a.type === 'font')) {
      const file = path.resolve(this.root, asset.path);
      if (!this.fonts.has(file)) {
        GlobalFonts.registerFromPath(file, asset.name.replace(/\.[^.]+$/, ''));
        this.fonts.add(file);
        invalidateTypographyFonts();
      }
    }
    const canvas = createCanvas(width, height),
      ctx = canvas.getContext('2d');
    if (options.sceneId) {
      const scene = snapshot.scenes.find((s) => s.id === options.sceneId);
      if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
      this.canvasMatrix = [
        width / (scene.width ?? snapshot.project.width),
        0,
        0,
        height / (scene.height ?? snapshot.project.height),
        0,
        0,
      ];
      ctx.scale(
        width / (scene.width ?? snapshot.project.width),
        height / (scene.height ?? snapshot.project.height),
      );
      await this.scene(ctx, snapshot, scene, frame, 0, options.nodesAt, options.driverContext);
    } else {
      this.canvasMatrix = [
        width / snapshot.project.width,
        0,
        0,
        height / snapshot.project.height,
        0,
        0,
      ];
      ctx.scale(width / snapshot.project.width, height / snapshot.project.height);
      await this.sequence(ctx, snapshot, snapshot.project.activeSequence, frame, 0);
    }
    return canvas;
  }
  private async sequence(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    id: string,
    frame: number,
    depth: number,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Sequence nesting exceeds 32');
    const sequence = snapshot.sequences.find((s) => s.id === id);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', id);
    for (const track of sequence.tracks.filter((t) => t.type === 'video' && !t.muted))
      for (const clip of track.clips) {
        if (frame < clip.start || frame >= clip.start + clip.duration) continue;
        const local = clipSourceFrame(clip, frame - clip.start);
        ctx.save();
        const fade = clipGain(clip, frame - clip.start);
        const faded = fade < 1 ? this.surface(ctx) : undefined,
          target = faded?.ctx ?? ctx;
        if (faded) target.setTransform(ctx.getTransform());
        try {
          if (clip.sceneId) {
            const scene = snapshot.scenes.find((s) => s.id === clip.sceneId)!;
            target.scale(
              snapshot.project.width / (scene.width ?? snapshot.project.width),
              snapshot.project.height / (scene.height ?? snapshot.project.height),
            );
            await this.scene(target, snapshot, scene, local, depth + 1);
          } else if (clip.sequenceId)
            await this.sequence(target, snapshot, clip.sequenceId, local, depth + 1);
          else if (clip.assetId) {
            const asset = snapshot.project.assets.find((a) => a.id === clip.assetId)!;
            await this.node(
              target,
              snapshot,
              nodeSchema.parse({
                id: clip.id,
                type:
                  asset.type === 'drawing' ? 'drawing' : asset.type === 'video' ? 'video' : 'image',
                assetId: clip.assetId,
                width: snapshot.project.width,
                height: snapshot.project.height,
              }),
              local,
              depth + 1,
            );
          }
          if (faded) {
            ctx.resetTransform();
            ctx.globalAlpha *= fade;
            ctx.drawImage(faded.canvas, 0, 0);
          }
        } finally {
          faded?.release();
          ctx.restore();
        }
      }
  }
  private async scene(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    scene: Scene,
    frame: number,
    depth: number,
    nodesAt?: (frame: number) => Promise<Node[]>,
    driverContext?: RenderDriverScope,
  ) {
    if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Scene nesting exceeds 32');
    ctx.save();
    try {
      const width = scene.width ?? snapshot.project.width,
        height = scene.height ?? snapshot.project.height;
      ctx.fillStyle = scene.background;
      ctx.fillRect(0, 0, width, height);
      ctx.transform(...cameraMatrix(scene.camera, width, height));
      await this.graph(
        ctx,
        snapshot,
        scene.nodes,
        frame,
        depth,
        nodesAt,
        undefined,
        undefined,
        driverContext ?? {
          width,
          height,
          duration: scene.duration,
        },
      );
    } finally {
      ctx.restore();
    }
  }
  private surface(ctx: SKRSContext2D, width = ctx.canvas.width, height = ctx.canvas.height) {
    const bytes = width * height * 4;
    if (this.layerBytes + this.graphScratchBytes + bytes > 256 * 1024 * 1024)
      throw new VmotionError(
        'EFFECT_MEMORY',
        'Temporary effect surfaces exceed the 256MB frame budget. Reduce resolution or nested effects.',
      );
    this.layerBytes += bytes;
    try {
      const canvas = this.surfaces.acquire(width, height);
      let released = false;
      return {
        canvas,
        ctx: canvas.getContext('2d'),
        release: () => {
          if (released) return;
          released = true;
          this.layerBytes -= bytes;
          this.surfaces.release(canvas);
        },
      };
    } catch (e) {
      this.layerBytes -= bytes;
      throw e;
    }
  }
  private async graph(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    nodes: Node[],
    frame: number,
    depth: number,
    nodesAt: (frame: number) => Promise<Node[]> = async () => nodes,
    onlyId?: string,
    before?: { index: number; id?: string },
    driverContext: RenderDriverScope = {
      width: snapshot.project.width,
      height: snapshot.project.height,
      duration: snapshot.scenes[0]?.duration ?? 1,
    },
  ) {
    const evaluated = await this.driven(nodes, frame, snapshot, driverContext, this.driverBudget),
      byId = new Map(evaluated.map((n) => [n.id, n]));
    if (byId.size !== nodes.length)
      throw new VmotionError('GRAPH_IDS', 'Generated node IDs must be unique');
    const masks = new Set(evaluated.flatMap((n) => (n.maskId ? [n.maskId] : [])));
    const byParent = new Map<string | undefined, Node[]>();
    for (const n of evaluated) {
      if (n.parentId && !byId.has(n.parentId))
        throw new VmotionError('GRAPH_PARENT', `${n.id}: missing parent ${n.parentId}`);
      const seen = new Set([n.id]);
      let parent = n.parentId;
      while (parent) {
        if (seen.has(parent)) throw new VmotionError('GRAPH_CYCLE', `${n.id}: parent cycle`);
        seen.add(parent);
        if (seen.size > 33)
          throw new VmotionError('NESTING_DEPTH', 'Generated hierarchy exceeds 32 levels');
        parent = byId.get(parent)?.parentId;
      }
      if (n.maskId && (!byId.has(n.maskId) || n.maskId === n.id))
        throw new VmotionError('GRAPH_MASK', `${n.id}: invalid mask ${n.maskId}`);
      const maskChain = new Set([n.id]);
      let maskId = n.maskId;
      while (maskId) {
        if (maskChain.has(maskId))
          throw new VmotionError('GRAPH_MASK_CYCLE', `${n.id}: mask cycle`);
        maskChain.add(maskId);
        maskId = byId.get(maskId)?.maskId;
      }
      if (n.maskId && byId.get(n.maskId)!.parentId !== n.parentId)
        throw new VmotionError(
          'GRAPH_MASK_SPACE',
          `${n.id}: mask and target must share a parent coordinate space`,
        );
      const siblings = byParent.get(n.parentId) ?? [];
      siblings.push(n);
      byParent.set(n.parentId, siblings);
    }
    const historical = async (
      target: SKRSContext2D,
      nodeId: string,
      at: number,
      limit: { index: number; id?: string },
      level: number,
    ) => {
      this.temporalWork += target.canvas.width * target.canvas.height;
      if (
        ++this.temporalQueries > 512 ||
        this.temporalWork > 256 * 1024 * 1024 ||
        this.temporalDepth >= 8
      )
        throw new VmotionError(
          'TEMPORAL_BUDGET',
          'Temporal sampling exceeds the frame work/depth budget',
          { pixels: this.temporalWork, depth: this.temporalDepth },
        );
      const surface = this.surface(target);
      this.temporalDepth++;
      try {
        surface.ctx.setTransform(target.getTransform());
        await this.graph(
          surface.ctx,
          snapshot,
          await nodesAt(at),
          at,
          level,
          nodesAt,
          nodeId,
          limit,
          driverContext,
        );
        return surface;
      } catch (error) {
        surface.release();
        throw error;
      } finally {
        this.temporalDepth--;
      }
    };
    const draw = async (target: SKRSContext2D, parent?: string, level = depth) => {
      if (level > 32) throw new VmotionError('NESTING_DEPTH', 'Layer hierarchy exceeds 32');
      for (const raw of onlyId && parent === undefined
        ? [byId.get(onlyId)].filter((node): node is Node => !!node)
        : (byParent.get(parent) ?? [])) {
        let n = raw;
        if (onlyId === raw.id) n = { ...raw, blend: 'source-over' };
        if (onlyId === raw.id && before) {
          const index = before.id
            ? raw.effects.findIndex((effect) => effect.id === before.id)
            : before.index;
          n = {
            ...raw,
            blend: 'source-over',
            effects: raw.effects.slice(0, index >= 0 ? index : before.index),
          };
        }
        const temporal = n.effects.some((effect) =>
          temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
        );
        if (
          (masks.has(n.id) && onlyId !== n.id) ||
          (!temporal &&
            (!n.visible ||
              n.opacity === 0 ||
              frame < n.start ||
              (n.end !== undefined && frame >= n.end)))
        )
          continue;
        const sample = (at: number, limit: { index: number; id?: string }) =>
          historical(target, n.id, at, limit, level);
        const nodeAt = async (at: number, id = n.id) =>
          (
            await this.driven(await nodesAt(at), at, snapshot, driverContext, this.driverBudget)
          ).find((node) => node.id === id);
        const graphInput = async (layerId: string) => {
          const id = byId.has(layerId)
              ? layerId
              : n.id.slice(0, n.id.lastIndexOf('/') + 1) + layerId,
            source = byId.get(id);
          if (!source)
            throw new VmotionError('EFFECT_GRAPH_LAYER', 'Graph input layer is missing', {
              nodeId: n.id,
              input: layerId,
            });
          if (source.parentId !== n.parentId)
            throw new VmotionError(
              'EFFECT_GRAPH_SPACE',
              'Graph input layers must share the owner parent; precompose or use a sibling group',
              { nodeId: n.id, input: id },
            );
          const surface = this.surface(target);
          try {
            surface.ctx.setTransform(target.getTransform());
            await this.graph(
              surface.ctx,
              snapshot,
              nodes,
              frame,
              level,
              nodesAt,
              id,
              undefined,
              driverContext,
            );
            return surface;
          } catch (error) {
            surface.release();
            throw error;
          }
        };
        if (temporal && n.maskId) {
          await this.node(
            target,
            snapshot,
            { ...n, maskId: undefined },
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          continue;
        }
        if (!n.maskId) {
          await this.node(
            target,
            snapshot,
            n,
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          continue;
        }
        const paint = this.surface(target),
          matrix = target.getTransform();
        let mask: ReturnType<Renderer['surface']> | undefined;
        try {
          mask = this.surface(target);
          paint.ctx.setTransform(matrix);
          mask.ctx.setTransform(matrix);
          await this.node(
            paint.ctx,
            snapshot,
            { ...n, maskId: undefined, blend: 'source-over' },
            frame,
            level,
            (next) => draw(next, n.id, level + 1),
            sample,
            graphInput,
            nodeAt,
          );
          const maskNode = byId.get(n.maskId)!;
          if (
            maskNode.effects.some((effect) =>
              temporalActive(effect as unknown as Record<string, unknown> & { type: string }),
            ) ||
            (maskNode.visible &&
              frame >= maskNode.start &&
              (maskNode.end === undefined || frame < maskNode.end))
          )
            await this.node(
              mask.ctx,
              snapshot,
              { ...maskNode, blend: 'source-over' },
              frame,
              level,
              (next) => draw(next, maskNode.id, level + 1),
              (at, limit) => historical(mask!.ctx, maskNode.id, at, limit, level),
              graphInput,
              (at) => nodeAt(at, maskNode.id),
            );
          if (n.maskMode === 'luma' || n.maskMode === 'lumaInverted') {
            const image = mask.ctx.getImageData(0, 0, mask.canvas.width, mask.canvas.height);
            mask.ctx.resetTransform();
            mask.ctx.putImageData(
              new ImageData(lumaMatte(image.data), image.width, image.height),
              0,
              0,
            );
          }
          let matte = mask.canvas;
          let feather: ReturnType<Renderer['surface']> | undefined;
          try {
            if (n.maskFeather > 0) {
              feather = this.surface(target);
              feather.ctx.filter = `blur(${n.maskFeather * Math.max(Math.hypot(matrix.a, matrix.b), Math.hypot(matrix.c, matrix.d))}px)`;
              feather.ctx.drawImage(mask.canvas, 0, 0);
              matte = feather.canvas;
            }
            paint.ctx.resetTransform();
            paint.ctx.globalCompositeOperation = n.maskMode.endsWith('Inverted')
              ? 'destination-out'
              : 'destination-in';
            paint.ctx.drawImage(matte, 0, 0);
          } finally {
            feather?.release();
          }
          target.save();
          try {
            target.resetTransform();
            target.filter = 'none';
            target.globalCompositeOperation = n.blend;
            target.drawImage(paint.canvas, 0, 0);
          } finally {
            target.restore();
          }
        } finally {
          paint.release();
          mask?.release();
        }
      }
    };
    await draw(ctx);
  }
  private nodeRenderServices(): RenderServices {
    const owner = this;
    return {
      root: this.root,
      programs:this.programs,
      geometry: this.geometry,
      native: this.native,
      templates: this.templates,
      images: this.media.images,
      decoders: this.media.decoders,
      decoderLeases: this.media.decoderLeases,
      get mediaQuality() {
        return owner.media.quality;
      },
      get mediaFraming() {
        return owner.media.framing;
      },
      get mediaUsed() {
        return owner.media.used;
      },
      image: this.image.bind(this),
      text: this.text.bind(this),
      chart: this.chart.bind(this),
      generatedNodes: this.generatedNodes.bind(this),
      referencedScene: this.referencedScene.bind(this),
      graph: this.graph.bind(this),
      scene: this.scene.bind(this),
    };
  }
  private compositorRuntime(): NodeCompositorRuntime {
    const owner = this;
    return {
      surface: this.surface.bind(this),
      get canvasMatrix() {
        return owner.canvasMatrix;
      },
      set canvasMatrix(value) {
        owner.canvasMatrix = value;
      },
      get fullFieldScan() {
        return owner.fullFieldScan;
      },
      set fullFieldScan(value) {
        owner.fullFieldScan = value;
      },
      get fieldPixels() {
        return owner.fieldPixels;
      },
      set fieldPixels(value) {
        owner.fieldPixels = value;
      },
      get temporalBytes() {
        return owner.temporalBytes;
      },
      set temporalBytes(value) {
        owner.temporalBytes = value;
      },
      get effectGraphStack() {
        return owner.effectGraphStack;
      },
      set effectGraphStack(value) {
        owner.effectGraphStack = value;
      },
      get graphOptimize() {
        return owner.graphOptimize;
      },
      set graphOptimize(value) {
        owner.graphOptimize = value;
      },
      get graphRegions() {
        return owner.graphRegions;
      },
      set graphRegions(value) {
        owner.graphRegions = value;
      },
      get graphTileRows() {
        return owner.graphTileRows;
      },
      set graphTileRows(value) {
        owner.graphTileRows = value;
      },
      get layerBytes() {
        return owner.layerBytes;
      },
      set layerBytes(value) {
        owner.layerBytes = value;
      },
      get graphScratchBytes() {
        return owner.graphScratchBytes;
      },
      set graphScratchBytes(value) {
        owner.graphScratchBytes = value;
      },
      get graphScratchPeakBytes() {
        return owner.graphScratchPeakBytes;
      },
      set graphScratchPeakBytes(value) {
        owner.graphScratchPeakBytes = value;
      },
      get effectGraphWork() {
        return owner.effectGraphWork;
      },
      set effectGraphWork(value) {
        owner.effectGraphWork = value;
      },
      get timings() {
        return owner.timings;
      },
      get effectGraphs() {
        return owner.effectGraphs;
      },
      get graphExecution() {
        return owner.graphExecution;
      },
      get gpu() {
        return owner.gpu;
      },
    };
  }
  private image(key: string, source: string | Buffer) {
    return this.media.image(key, source);
  }
  private node(...args: Parameters<NodeCompositor['render']>) {
    return this.compositor.render(...args);
  }
  referencedScene(snapshot: Snapshot, node: Node): Scene {
    const scene = snapshot.scenes.find((s) => s.id === node.sceneId);
    if (!scene)
      throw new VmotionError(
        'MISSING_SCENE',
        `Referenced scene ${node.sceneId ?? node.id} not found`,
      );
    return scene;
  }
  async driven(
    nodes: Node[],
    frame: number,
    snapshot: Snapshot,
    context: RenderDriverScope,
    budget = { remaining: 200000 },
  ) {
    if (context.group) return isolateGroup(await context.group.sourceAt(frame), context.group.id);
    nodes = nodes.map((node) => this.themes.resolveNode(snapshot, node));
    const started = performance.now(),
      animated = await this.native.evaluate(nodes, frame);
    this.timings.evaluateMs += performance.now() - started;
    return hasDrivers(nodes)
      ? evaluateDrivers(
          nodes,
          { ...context, frame, fps: snapshot.project.fps.num / snapshot.project.fps.den, budget },
          animated,
        ).nodes
      : animated;
  }
  async inspectComposition(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    path: string[] = [],
    contextFrames: number[] = [],
  ) {
    contextFramesSchema.parse(contextFrames);
    if (contextFrames.length > path.length)
      throw new VmotionError('CONTENT_CONTEXT', 'Parent context cannot exceed navigation depth');
    const original = snapshot.scenes.find((s) => s.id === sceneId);
    if (!original) throw new VmotionError('NOT_FOUND', 'Scene not found');
    if (path.length > 32)
      throw new VmotionError('NESTING_DEPTH', 'Composition navigation exceeds 32');
    let nodes = original.nodes,
      width = original.width ?? snapshot.project.width,
      height = original.height ?? snapshot.project.height,
      name = original.name,
      duration = original.duration,
      background = original.background,
      camera = original.camera;
    type Target =
      | { kind: 'node'; nodeId: string }
      | { kind: 'generated'; rootNodeId: string; relativeId: string };
    let targets: Record<string, Target> = Object.fromEntries(
      nodes.map((n) => [n.id, { kind: 'node' as const, nodeId: n.id }]),
    );
    const breadcrumbs: Array<{ id: string; name: string; type: string }> = [];
    let scope: { parentId?: string; ownerNodeId?: string; componentPath?: string } = {},
      componentPrefix = '';
    let driverContext: RenderDriverScope = { width, height, duration };
    for (const [index, id] of path.entries()) {
      const root = nodes.find((n) => n.id === id);
      if (!root) throw new VmotionError('NOT_FOUND', `Composition layer ${id} no longer exists`);
      breadcrumbs.push({ id, name: root.name, type: root.type });
      name = root.name;
      if (root.type === 'group') {
        const parentNodes = nodes,
          parentContext = driverContext,
          parentPath = path.slice(0, index),
          parentContexts = contextFrames.slice(0, index);
        driverContext = {
          width,
          height,
          duration,
          group: {
            id,
            sourceAt: async (at) => {
              if (!parentPath.length) return this.driven(parentNodes, at, snapshot, parentContext);
              const parent = await this.inspectComposition(
                snapshot,
                sceneId,
                at,
                parentPath,
                parentContexts,
              );
              return this.driven(parent.scene.nodes, at, snapshot, parent.driverContext);
            },
          },
        };
        scope = {
          ...scope,
          parentId: componentPrefix ? root.id.slice(componentPrefix.length + 1) : root.id,
        };
        nodes = isolateGroup(nodes, id);
        targets = Object.fromEntries(nodes.map((n) => [n.id, targets[n.id]]));
        camera = undefined;
      } else if (root.type === 'component' || root.type === 'scene') {
        const target = targets[root.id],
          source = (
            await this.driven(nodes, contextFrames[index] ?? frame, snapshot, driverContext)
          ).find((node) => node.id === root.id)!,
          sourceFrame = index + 1 < path.length ? (contextFrames[index + 1] ?? frame) : frame;
        let generated: Node[];
        if (root.type === 'scene') {
          const scene = this.referencedScene(snapshot, source);
          generated = composeGenerated(this.templates.apply(snapshot, source, scene.nodes), source);
          width = scene.width ?? snapshot.project.width;
          height = scene.height ?? snapshot.project.height;
          duration = scene.duration;
          background = scene.background;
          camera = scene.camera;
        } else {
          generated = await this.generatedNodes(snapshot, source, sourceFrame);
          width = Math.max(16, Math.round(root.width));
          height = Math.max(16, Math.round(root.height));
          duration = source.timeMapping.duration ?? duration;
          camera = undefined;
        }
        scope =
          target.kind === 'node'
            ? { ownerNodeId: target.nodeId, componentPath: '' }
            : { ownerNodeId: target.rootNodeId, componentPath: target.relativeId };
        componentPrefix = root.id;
        nodes = prefixNodes(generated, root.id);
        driverContext = { width, height, duration };
        targets = Object.fromEntries(
          generated.map((n, i) => [
            nodes[i].id,
            target.kind === 'node'
              ? { kind: 'generated' as const, rootNodeId: target.nodeId, relativeId: n.id }
              : {
                  kind: 'generated' as const,
                  rootNodeId: target.rootNodeId,
                  relativeId: `${target.relativeId}/${n.id}`,
                },
          ]),
        );
      } else throw new VmotionError('COMPOSITION_TYPE', 'Open a group or programmable component');
    }
    return {
      scene: {
        ...original,
        id: `${original.id}::focus`,
        name,
        nodes,
        width,
        height,
        duration,
        background,
        camera,
      },
      width,
      height,
      targets,
      breadcrumbs,
      revision: snapshot.revision,
      scope,
      componentPrefix,
      driverContext,
      contextFrames,
      frame,
    };
  }
  async inspectInteractions(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    path: string[] = [],
    options: {
      includeEmpty?: boolean;
      includeInactive?: boolean;
      contextFrames?: number[];
      includeEvaluated?: boolean;
    } = {},
  ) {
    const scope = await this.inspectComposition(
        snapshot,
        sceneId,
        frame,
        path,
        options.contextFrames,
      ),
      layers: InteractionLayer[] = [],
      ctx = createCanvas(1, 1).getContext('2d');
    for (const asset of snapshot.project.assets.filter((a) => a.type === 'font')) {
      const file = pathResolve(this.root, asset.path);
      if (!this.fonts.has(file)) {
        GlobalFonts.registerFromPath(file, asset.name.replace(/\.[^.]+$/, ''));
        this.fonts.add(file);
        invalidateTypographyFonts();
      }
    }
    const walk = async (
      nodes: Node[],
      parentMatrix: Matrix,
      editPath: string[],
      clips: InteractionLayer['clips'],
      depth: number,
      opacity = 1,
      uncertainty: string[] = [],
      localFrame = frame,
      contexts = scope.contextFrames,
      localContext: RenderDriverScope = scope.driverContext,
    ) => {
      if (depth > 32) throw new VmotionError('NESTING_DEPTH', 'Interaction hierarchy exceeds 32');
      const evaluated = await this.driven(nodes, localFrame, snapshot, localContext),
        masks = new Set(evaluated.flatMap((n) => (n.maskId ? [n.maskId] : [])));
      const visit = async (
        parent: string | undefined,
        matrix: Matrix,
        inherited: InteractionLayer['clips'],
        level: number,
        inheritedOpacity = opacity,
        inheritedUncertainty = uncertainty,
      ) => {
        if (level > 32) throw new VmotionError('NESTING_DEPTH', 'Interaction hierarchy exceeds 32');
        for (const n of evaluated.filter((n) => n.parentId === parent)) {
          if (
            !options.includeInactive &&
            (masks.has(n.id) ||
              !n.visible ||
              n.opacity === 0 ||
              localFrame < n.start ||
              (n.end !== undefined && localFrame >= n.end))
          )
            continue;
          const world = multiply(matrix, nodeMatrix(n)),
            nextClips = n.clip ? [...inherited, { matrix: world, bounds: n.clip }] : inherited;
          const timing = timeControlled(n)
            ? contentTiming(snapshot, n, localFrame, true)
            : undefined;
          if (timing && !timing.present && !options.includeInactive) continue;
          const alpha = inheritedOpacity * n.opacity,
            uncertain = [
              ...new Set([
                ...inheritedUncertainty,
                ...(n.maskId ? ['mask'] : []),
                ...(n.effects.length || n.blur || n.shadow ? ['effect'] : []),
                ...(n.blend !== 'source-over' ? ['blend'] : []),
              ]),
            ];
          let bounds: Bounds = { x: 0, y: 0, width: n.width, height: n.height };
          let strokes: InteractionLayer['strokes'];
          let polygons: InteractionLayer['contentPolygons'],
            textLayout: InteractionLayer['textLayout'];
          if (n.type === 'text') {
            const text = this.textGeometry(n, localFrame, snapshot);
            textLayout = text.metrics;
            const regions = text.runs
              .filter((run) => run.alpha >= 0.05 && run.text.trim())
              .map((run) => {
                const pad = n.strokeWidth / 2,
                  left = run.box.x - pad,
                  right = run.box.x + run.box.width + pad,
                  top = run.box.y - pad,
                  bottom = run.box.y + run.box.height + pad,
                  angle = (run.rotation * Math.PI) / 180,
                  c = Math.cos(angle),
                  s = Math.sin(angle),
                  m: Matrix = [
                    c * run.scaleX,
                    s * run.scaleX,
                    -s * run.scaleY,
                    c * run.scaleY,
                    run.x,
                    run.y,
                  ];
                return [
                  { x: left, y: top },
                  { x: right, y: top },
                  { x: right, y: bottom },
                  { x: left, y: bottom },
                ].map((p) => transform(m, p));
              });
            const corners = regions.flat();
            polygons = regions.map((region) => region.map((point) => transform(world, point)));
            if (!corners.length) {
              if (!options.includeEmpty) continue;
              bounds = {
                x: 0,
                y: 0,
                width: options.includeInactive ? n.width : 0,
                height: options.includeInactive ? n.height : 0,
              };
            } else {
              const x = Math.min(...corners.map((p) => p.x)),
                y = Math.min(...corners.map((p) => p.y));
              bounds = {
                x,
                y,
                width: Math.max(...corners.map((p) => p.x)) - x,
                height: Math.max(...corners.map((p) => p.y)) - y,
              };
            }
          } else if (n.type === 'drawing') {
            let resource: unknown = { points: n.points },
              sourceWidth = snapshot.project.width,
              sourceHeight = snapshot.project.height;
            if (n.assetId) {
              const asset = snapshot.project.assets.find((a) => a.id === n.assetId);
              if (asset) {
                resource = JSON.parse(await readFile(pathResolve(this.root, asset.path), 'utf8'));
                sourceWidth = Number(asset.metadata.width ?? sourceWidth);
                sourceHeight = Number(asset.metadata.height ?? sourceHeight);
              }
            }
            const doc = normalizeDrawing(resource, {
                ...n,
                width: sourceWidth,
                height: sourceHeight,
              }),
              ink = drawingInkBounds(doc),
              sx = n.width / doc.width,
              sy = n.height / doc.height;
            bounds = {
              x: ink.x * sx,
              y: ink.y * sy,
              width: ink.width * sx,
              height: ink.height * sy,
            };
            strokes = doc.layers
              .filter((l) => l.visible && l.opacity)
              .flatMap((l) =>
                l.strokes
                  .filter((s) => s.tool === 'brush' && s.opacity)
                  .map((s) => ({
                    width: s.width * Math.max(Math.abs(sx), Math.abs(sy)),
                    points: s.points.map((p) => ({
                      ...p,
                      x: (p.x + l.x) * sx,
                      y: (p.y + l.y) * sy,
                    })),
                  })),
              );
            if (!strokes.length && !options.includeInactive) continue;
          } else if (['rect', 'ellipse', 'path'].includes(n.type)) {
            bounds = shapeBounds(n, shapePath(n, this.geometry));
          } else if (n.type === 'scene3d' && n.scene3d) {
            const data = resolveSceneMeshes(snapshot, n.scene3d),
              evaluated = evaluateScene3D(
                n.id,
                data.instances as unknown as MeshInstance3D[],
                data.camera,
                data.options,
              ),
              b = evaluated.bounds,
              sx = n.width / data.camera.width,
              sy = n.height / data.camera.height;
            bounds = b
              ? {
                  x: b.x * sx,
                  y: b.y * sy,
                  width: (b.right - b.x) * sx,
                  height: (b.bottom - b.y) * sy,
                }
              : { x: 0, y: 0, width: 0, height: 0 };
            uncertain.push('depth-raster');
          }
          const index = layers.length;
          layers.push({
            frame: localFrame,
            contentFrame: timing?.sourceFrame,
            contextFrames: contexts,
            node: nodes.find((raw) => raw.id === n.id)!,
            ...(options.includeEvaluated ? { evaluatedNode: n } : {}),
            path: editPath,
            matrix: world,
            parentMatrix: matrix,
            bounds,
            clips: nextClips,
            container: ['group', 'component', 'scene'].includes(n.type),
            strokes,
            opacity: alpha,
            uncertainty: uncertain,
            contentPolygons: polygons,
            textLayout,
          });
          if (layers.length > 20000)
            throw new VmotionError('INTERACTION_LIMIT', 'Interaction graph exceeds 20000 layers');
          if (n.type === 'component' || n.type === 'scene') {
            const scene = n.type === 'scene' ? this.referencedScene(snapshot, n) : undefined,
              generated = prefixNodes(
                scene
                  ? composeGenerated(this.templates.apply(snapshot, n, scene.nodes), n)
                  : await this.generatedNodes(snapshot, n, timing!.sourceFrame),
                n.id,
              ),
              sourceWidth = scene?.width ?? snapshot.project.width,
              sourceHeight = scene?.height ?? snapshot.project.height,
              sourceMatrix = scene
                ? multiply(
                    [n.width / sourceWidth, 0, 0, n.height / sourceHeight, 0, 0],
                    cameraMatrix(scene.camera, sourceWidth, sourceHeight),
                  )
                : ([1, 0, 0, 1, 0, 0] as Matrix);
            await walk(
              generated,
              multiply(world, sourceMatrix),
              [...editPath, n.id],
              nextClips,
              level + 1,
              alpha,
              uncertain,
              timing!.sourceFrame,
              [...contexts, localFrame],
              {
                width: scene ? sourceWidth : n.width,
                height: scene ? sourceHeight : n.height,
                duration: scene?.duration ?? n.timeMapping.duration ?? localContext.duration,
              },
            );
          }
          await visit(n.id, world, nextClips, level + 1, alpha, uncertain);
          if (n.type === 'group') {
            const inv = inverse(world);
            if (inv) {
              const points = layers.slice(index + 1).flatMap((layer) => {
                const b = layer.bounds,
                  m = multiply(inv, layer.matrix);
                return [
                  { x: b.x, y: b.y },
                  { x: b.x + b.width, y: b.y },
                  { x: b.x + b.width, y: b.y + b.height },
                  { x: b.x, y: b.y + b.height },
                ].map((p) => transform(m, p));
              });
              if (points.length) {
                const x = Math.min(...points.map((p) => p.x)),
                  y = Math.min(...points.map((p) => p.y));
                layers[index].bounds = {
                  x,
                  y,
                  width: Math.max(...points.map((p) => p.x)) - x,
                  height: Math.max(...points.map((p) => p.y)) - y,
                };
              }
            }
          }
        }
      };
      await visit(undefined, parentMatrix, clips, depth);
    };
    await walk(
      scope.scene.nodes,
      cameraMatrix(scope.scene.camera, scope.width, scope.height),
      path,
      [],
      0,
    );
    return {
      revision: snapshot.revision,
      frame,
      sceneId,
      path,
      contextFrames: scope.contextFrames,
      layers,
    };
  }
  async generatedNodes(snapshot: Snapshot, n: Node, frame: number): Promise<Node[]> {
    let audio: ReturnType<typeof audioAt> | undefined;
    if (n.audioAssetId) {
      const asset = snapshot.project.assets.find((a) => a.id === n.audioAssetId);
      if (!asset)
        throw new VmotionError('MISSING_AUDIO', `Audio asset ${n.audioAssetId} not found`);
      const file = await audioSourceFile(this.root, snapshot, asset),
        time = frameSeconds(frame, snapshot.project.fps) + n.audioOffset,
        segment = Math.max(0, Math.floor(time / 30)),
        key = `${file}:${await fingerprint(file)}:${segment}`;
      if (!this.audioAnalysis.has(key)) {
        if (this.audioAnalysis.size >= 3) {
          const first = this.audioAnalysis.keys().next().value!;
          this.audioAnalysis.delete(first);
          this.audioControllers.get(first)?.abort();
          this.audioControllers.delete(first);
        }
        const controller = new AbortController();
        this.audioControllers.set(key, controller);
        this.audioAnalysis.set(
          key,
          analyzeAudio(file, { start: segment * 30, duration: 31, signal: controller.signal })
            .catch((e) => {
              if (e instanceof VmotionError && e.code === 'ANALYSIS_RANGE')
                return {
                  sampleRate: 24000,
                  rate: 30,
                  duration: 0,
                  bpm: 0,
                  beats: [],
                  features: [],
                };
              this.audioAnalysis.delete(key);
              throw e;
            })
            .finally(() => this.audioControllers.delete(key)),
        );
      }
      audio = audioAt(await this.audioAnalysis.get(key)!, time - segment * 30);
    }
    const started = performance.now(),
      nodes = await this.components.render(snapshot, n, {
        frame,
        seconds: frameSeconds(frame, snapshot.project.fps),
        fps: snapshot.project.fps.num / snapshot.project.fps.den,
        width: n.width,
        height: n.height,
        seed: 1,
        audio,
      });
    this.timings.componentCalls++;
    this.timings.componentMs += performance.now() - started;
    return composeGenerated(nodes, n);
  }
  /** Glyph-set source for a text node; snapshot gives access to project glyph sets. */
  glyphSource(n: Node, snapshot?: Pick<Snapshot, 'files'>): GlyphTextSource {
    return glyphSourceFor(n, snapshot, this.glyphSets);
  }
  textGeometry(n: Node, frame = 0, snapshot?: Pick<Snapshot, 'files'>) {
    const ctx = createCanvas(1, 1).getContext('2d'),
      glyphs = this.glyphSource(n, snapshot);
    if (n.pathText || n.textAnimators.length) return this.typography.layout(ctx, n, frame, glyphs);
    const lines = this.textLines(ctx, n, glyphs),
      rendered = lines.filter((_, i) => i * n.fontSize * n.lineHeight < n.height),
      full = n.reveal === 1 ? lines : this.textLines(ctx, { ...n, reveal: 1 }, glyphs);
    const runs = this.textRuns(ctx, n, frame, glyphs).map((run, index) => {
      ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
      ctx.textAlign = 'left';
      ctx.textBaseline = run.baseline;
      const measure = new MixedTextMeasurer(ctx, glyphs, n.fontSize);
      return {
        ...run,
        index,
        wordIndex: -1,
        lineIndex: 0,
        width: measure.width(run.text),
        box: measure.box(run.text, run.baseline),
      };
    });
    return {
      runs,
      metrics: {
        lineCount: lines.length,
        renderedLineCount: rendered.length,
        fullLineCount: full.length,
        truncatedCharacters: lines.slice(rendered.length).join('').length,
        requiredHeight: full.length * n.fontSize * n.lineHeight + n.strokeWidth,
      },
    };
  }
  private textLines(ctx: SKRSContext2D, n: Node, glyphs?: GlyphTextSource) {
    return this.typography.lines(ctx, n, glyphs);
  }
  private textRuns(ctx: SKRSContext2D, n: Node, frame: number, glyphs?: GlyphTextSource) {
    if (n.pathText || n.textAnimators.length)
      return this.typography.layout(ctx, n, frame, glyphs).runs;
    const lines = this.textLines(ctx, n, glyphs),
      measure = new MixedTextMeasurer(ctx, glyphs ?? { fallback: 'font' }, n.fontSize);
    const runs: Array<{
      text: string;
      x: number;
      y: number;
      rotation: number;
      scaleX: number;
      scaleY: number;
      baseline: 'top' | 'alphabetic';
      fill?: string;
      alpha: number;
    }> = [];
    let unitIndex = 0;
    lines.forEach((line, i) => {
      if (i * n.fontSize * n.lineHeight >= n.height) return;
      if (n.textMotion) {
        const motion = n.textMotion,
          units = Array.from(
            new Intl.Segmenter('zh', {
              granularity: motion.unit === 'word' ? 'word' : 'grapheme',
            }).segment(line),
            (s) => s.segment,
          ),
          lineWidth = measure.width(line),
          origin =
            n.align === 'center'
              ? (n.width - lineWidth) / 2
              : n.align === 'right'
                ? n.width - lineWidth
                : 0;
        let prefix = '';
        for (const unit of units) {
          const p = Math.max(
              0,
              Math.min(1, (frame - motion.start - unitIndex++ * motion.stagger) / motion.duration),
            ),
            e = 1 - (1 - p) ** 3,
            position = measure.width(prefix);
          prefix += unit;
          if (p === 0) continue;
          runs.push({
            text: unit,
            x: origin + position + motion.offsetX * (1 - e),
            y: i * n.fontSize * n.lineHeight + motion.offsetY * (1 - e),
            rotation: motion.rotation * (1 - e),
            scaleX: motion.scale + (1 - motion.scale) * e,
            scaleY: motion.scale + (1 - motion.scale) * e,
            baseline: 'top',
            alpha: p,
          });
        }
        return;
      }
      const width = measure.width(line);
      runs.push({
        text: line,
        x: n.align === 'center' ? (n.width - width) / 2 : n.align === 'right' ? n.width - width : 0,
        y: i * n.fontSize * n.lineHeight,
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        baseline: 'top',
        alpha: 1,
      });
    });
    return runs;
  }
  private text(ctx: SKRSContext2D, n: Node, frame: number, snapshot?: Pick<Snapshot, 'files'>) {
    const glyphs = this.glyphSource(n, snapshot),
      runs = this.textRuns(ctx, n, frame, glyphs),
      measure = new MixedTextMeasurer(ctx, glyphs, n.fontSize);
    ctx.textAlign = 'left';
    for (const run of runs) {
      ctx.save();
      ctx.globalAlpha *= run.alpha;
      ctx.translate(run.x, run.y);
      ctx.rotate((run.rotation * Math.PI) / 180);
      ctx.scale(run.scaleX, run.scaleY);
      ctx.textBaseline = run.baseline;
      if (run.fill) ctx.fillStyle = run.fill;
      measure.draw(run.text, n.strokeWidth);
      ctx.restore();
    }
  }
  private chart(ctx: SKRSContext2D, n: Node) {
    const values = Array.isArray(n.params.values)
        ? n.params.values.map(Number)
        : [25, 60, 45, 90, 70],
      max = Math.max(1, ...values),
      mode = n.params.mode ?? 'bar';
    ctx.strokeStyle = '#44516b';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(0, n.height);
    ctx.lineTo(n.width, n.height);
    ctx.stroke();
    if (mode === 'line') {
      ctx.strokeStyle = n.fill;
      ctx.lineWidth = 3;
      ctx.beginPath();
      values.forEach((v, i) => {
        const x = (i * n.width) / Math.max(1, values.length - 1),
          y = n.height - (v / max) * (n.height - 20) * n.reveal;
        i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
      });
      ctx.stroke();
    } else
      values.forEach((v, i) => {
        const slot = n.width / values.length,
          height = (v / max) * (n.height - 20) * n.reveal;
        ctx.fillRect(i * slot + slot * 0.12, n.height - height, slot * 0.76, height);
      });
  }
  private drawing(ctx: SKRSContext2D, n: Node, points: Node['points']) {
    ctx.strokeStyle = n.stroke || n.fill;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    for (let i = 1; i < points.length; i++) {
      const a = points[i - 1],
        b = points[i];
      ctx.lineWidth = Math.max(0.5, (n.strokeWidth * (a.pressure + b.pressure)) / 2);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
  }
  async close() {
    await this.programs.close();
    this.themes.clear();
    this.templates.clear();
    this.effectGraphs.clear();
    this.typography.clear();
    this.glyphSets.clear();
    this.geometry.clear();
    for (const controller of this.audioControllers.values()) controller.abort();
    await Promise.allSettled(this.audioAnalysis.values());
    this.audioAnalysis.clear();
    this.audioControllers.clear();
    this.native.close();
    this.gpu.close();
    await this.components.close();
    await this.media.clear();
    this.surfaces.clear();
  }
}

/** Still artboards (and still projects rendered through their sequence) use the still budget. */
export function isStillTarget(snapshot: Snapshot, sceneId?: string) {
  if (sceneId) return !!snapshot.scenes.find((s) => s.id === sceneId)?.still;
  return snapshot.project.kind === 'still';
}
