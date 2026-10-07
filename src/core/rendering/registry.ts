import type { Image, SKRSContext2D } from '@napi-rs/canvas';
import type { VideoDecoder } from '../../media/ffmpeg.js';
import type { GeometryCache } from '../geometry-cache.js';
import type { Bounds, Matrix } from '../interaction.js';
import type { Node, Scene, Snapshot } from '../model.js';
import { VmotionError } from '../model.js';
import type { NativeEvaluator } from '../native.js';
import type { RenderDriverScope } from '../renderer.js';
import type { TemplateResolver } from '../template-resource.js';
export type RenderSurface = SKRSContext2D;
export interface RenderLayer {
  target: RenderSurface;
  skipChildren?: boolean;
}
export interface RenderServices {
  programs: import('../programs/program-host.js').ProgramHost;
  root: string;
  geometry: GeometryCache<import('@napi-rs/canvas').Path2D>;
  native: NativeEvaluator;
  templates: TemplateResolver;
  images: Map<string, { image: Image; bytes: number }>;
  image(key: string, source: string | Buffer): Promise<Image>;
  decoders: Map<string, VideoDecoder>;
  decoderLeases: Map<string, () => void>;
  mediaQuality: 'original' | 'auto';
  mediaFraming: 'direct' | 'concat';
  mediaUsed: Array<{
    assetId?: string;
    proxy: boolean;
    decodeWidth: number;
    decodeHeight: number;
    path: string;
  }>;
  text(ctx: SKRSContext2D, node: Node, frame: number): void;
  chart(ctx: SKRSContext2D, node: Node): void;
  generatedNodes(snapshot: Snapshot, node: Node, frame: number): Promise<Node[]>;
  referencedScene(snapshot: Snapshot, node: Node): Scene;
  scene(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    scene: Scene,
    frame: number,
    depth: number,
    nodesAt?: (frame: number) => Promise<Node[]>,
    driverContext?: RenderDriverScope,
  ): Promise<void>;
  graph(
    ctx: SKRSContext2D,
    snapshot: Snapshot,
    nodes: Node[],
    frame: number,
    depth: number,
    nodesAt?: (frame: number) => Promise<Node[]>,
    onlyId?: string,
    before?: { index: number; id?: string },
    scope?: RenderDriverScope,
  ): Promise<void>;
}
export interface NodeRenderContext {
  snapshot: Snapshot;
  frame: number;
  depth: number;
  parentTransform: Matrix;
  target: RenderSurface;
  services: RenderServices;
  nodeSource?: (frame: number) => Promise<Node | undefined>;
}
export interface InteractionGeometry {
  bounds: Bounds;
}
export interface NodeRenderer {
  type: Node['type'];
  render(context: NodeRenderContext, node: Node): Promise<RenderLayer>;
  inspect?(context: NodeRenderContext, node: Node): Promise<InteractionGeometry>;
}
export class NodeRendererRegistry {
  private entries = new Map<Node['type'], NodeRenderer>();
  register(renderer: NodeRenderer) {
    if (this.entries.has(renderer.type))
      throw new VmotionError(
        'NODE_RENDERER_DUPLICATE',
        `Duplicate node renderer: ${renderer.type}`,
      );
    this.entries.set(renderer.type, renderer);
  }
  get(type: Node['type']) {
    const renderer = this.entries.get(type);
    if (!renderer)
      throw new VmotionError('NODE_RENDERER_UNSUPPORTED', `No renderer for node type ${type}`, {
        type,
      });
    return renderer;
  }
  list(): readonly NodeRenderer[] {
    return [...this.entries.values()];
  }
}
