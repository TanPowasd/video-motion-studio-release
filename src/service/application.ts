import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { ProjectService } from './service.js';
import { Renderer } from '../core/renderer.js';
import { RenderManager } from '../media/export.js';
import { safePath, atomicWrite } from './project.js';
import {
  nodeSchema,
  VmotionError,
  type Node,
  type Operation,
  type Snapshot,
} from '../core/model.js';
import type { CompositionDraft } from '../core/interaction.js';
import { drawingFromAsset, drawingPreview, drawingDraftSchema } from './drawings.js';
import { drawingFrame } from '../core/drawing-renderer.js';
import { proxy } from '../media/ffmpeg.js';
import { fileURLToPath } from 'node:url';
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { fingerprint } from '../media/ffmpeg.js';
import { performance } from 'node:perf_hooks';
import { AudioPreview } from '../media/audio-preview.js';
import { AudioLiveService } from './audio-live.js';
import { applyOperations } from './operations.js';
import { checkAssets } from './media-evidence.js';
import { toolDefinitions } from '../mcp/catalog.js';
import {
  findTool,
  searchTools,
  toolSchema,
  toolSearchSchema,
  toolSchemaRequestSchema,
} from '../mcp/discovery.js';
import { agentDiscoverySchema } from './surfaces.js';
import { invokeTool, toolCallSchema } from '../mcp/invoke.js';
import { z } from 'zod';
import { resolveAgentPlan } from './agent-plans.js';
import { audioSourceFile } from '../media/sound-source.js';
import { ProxyManager } from '../media/proxy-cache.js';
import { applyCacheCleanup } from './cache-management.js';
import { builtinPlugins } from '../plugins/index.js';
import { PluginRegistry } from '../core/plugins.js';
import { pluginCatalog, callPluginTool } from './plugins.js';
import { projectPluginTools } from '../mcp/plugin-tools.js';
import { TrackingManager } from './tracking-jobs.js';
import type { FrameRequest, FrameResult, RpcInput, RpcMethod, RpcOutput } from './rpc-contract.js';
import { withChangeOrigin, type ChangeOrigin } from './change-journal.js';

/** External MCP clients that announced themselves recently (via ping heartbeats or tool calls). */
export interface AgentPresence {
  key: string;
  client: string;
  lastSeen: number;
}
const agentSchema = z
  .object({
    client: z.string().max(80).optional(),
    pid: z.number().int().optional(),
  })
  .strip();
/** Presence older than this is reported as disconnected. */
export const AGENT_PRESENCE_TTL = 45_000;

export class Application extends EventEmitter {
  service: ProjectService;
  renderer: Renderer;
  renders: RenderManager;
  readonly audioPreview: AudioPreview;
  readonly audioLive = new AudioLiveService();
  readonly proxies: ProxyManager;
  readonly tracking: TrackingManager;
  readonly plugins = new PluginRegistry();
  private readonly builtinTools = toolDefinitions();
  private pluginToolCache?: { hash: string; tools: ReturnType<typeof projectPluginTools> };
  private pluginDefinitions() {
    const catalog = pluginCatalog(this.plugins, this.service.snapshot, this.pluginToolCache?.hash);
    if (!catalog.notModified)
      this.pluginToolCache = { hash: catalog.catalogHash, tools: projectPluginTools(catalog) };
    return this.pluginToolCache!.tools;
  }
  private mediaTasks = 0;
  private activeRequests = 0;
  private cacheApplying = false;
  private mediaEpoch = 0;
  private publishedProxies = new Set<string>();
  private previewQueue: Promise<unknown> = Promise.resolve();
  private lastFrame?: {
    buffer: Buffer;
    revision: string;
    frame: number;
    media?: { quality: string; proxyCount: number; decodePixels: number };
  };
  private lastRgbaFrame?: {
    buffer: Buffer;
    revision: string;
    frame: number;
    width: number;
    height: number;
    media?: { quality: string; proxyCount: number; decodePixels: number };
  };
  private assetThumbnails = new Map<string, Promise<Buffer>>();
  private agents = new Map<string, AgentPresence>();
  /** Records an MCP client heartbeat. Returns the client name for attribution. */
  noteAgent(raw: unknown): string | undefined {
    const parsed = agentSchema.safeParse(raw);
    if (!parsed.success) return undefined;
    const client = parsed.data.client?.trim() || 'MCP',
      key = `${client}:${parsed.data.pid ?? ''}`,
      known = this.agents.has(key);
    this.agents.set(key, { key, client, lastSeen: Date.now() });
    if (!known) this.emit('agents', this.agentState());
    return client;
  }
  /** Connection/hold state shown by the Studio top bar and change feed. */
  agentState() {
    const now = Date.now();
    for (const [key, agent] of this.agents)
      if (now - agent.lastSeen > AGENT_PRESENCE_TTL * 4) this.agents.delete(key);
    return {
      hold: this.service.holdingAgents,
      clients: [...this.agents.values()].map((a) => ({
        client: a.client,
        lastSeen: a.lastSeen,
        active: now - a.lastSeen <= AGENT_PRESENCE_TTL,
      })),
    };
  }
  /** Recent change journal entries (who changed what), newest last. */
  changeLog(limit = 80) {
    return this.service.journal.tail(limit);
  }
  constructor(readonly root: string) {
    super();
    this.service = new ProjectService(root);
    this.renderer = new Renderer(root);
    this.audioPreview = new AudioPreview(root);
    this.tracking = new TrackingManager(root, () => this.emit('tracking', this.tracking.status()));
    this.proxies = new ProxyManager(root, () => {
      this.emit('proxy', this.proxies.status());
      for (const job of this.proxies.jobs.values())
        if (job.status === 'completed' && !this.publishedProxies.has(job.id)) {
          this.publishedProxies.add(job.id);
          this.mediaEpoch++;
          this.emit('change', { ...this.service.state(), mediaEpoch: this.mediaEpoch });
        }
    });
    this.service.extraValidation = async (snapshot) => {
      try {
        const typed = this.renderer.components.typecheck(snapshot);
        if (typed.length) return typed;
        await this.renderer.components.validate(snapshot);
        return this.plugins.resolve(snapshot).flatMap((entry) => entry.metadataWarnings);
      } catch (e) {
        return [
          {
            severity: 'error',
            code: e instanceof VmotionError ? e.code : 'COMPONENT_ERROR',
            message: (e as Error).message,
            ...(e instanceof VmotionError ? (e.details as object) : {}),
          },
        ];
      }
    };
    this.renders = new RenderManager(root, () =>
      this.emit('render', Array.from(this.renders.jobs.values())),
    );
    this.service.on('change', () =>
      this.emit('change', { ...this.service.state(), changeLog: this.changeLog() }),
    );
  }
  private connection() {
    const dir = path.dirname(
        typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
          ? fileURLToPath(import.meta.url)
          : String(import.meta.url),
      ),
      cli = path.resolve(dir, '../../dist/cli/index.mjs');
    return {
      command: process.execPath,
      args: [cli, 'mcp', '--project', path.resolve(this.root), '--tools', 'compact'],
      ...(process.versions.electron
        ? {
            env: {
              ELECTRON_RUN_AS_NODE: '1',
              VMOTION_NATIVE: process.env.VMOTION_NATIVE,
              VMOTION_SDK_SOURCE: process.env.VMOTION_SDK_SOURCE,
              ESBUILD_BINARY_PATH: process.env.ESBUILD_BINARY_PATH,
            },
          }
        : {}),
    };
  }
  async open(watch = true) {
    await this.service.open(watch);
    return this;
  }
  async frame(params: FrameRequest = {}): Promise<FrameResult> {
    if (this.cacheApplying)
      throw new VmotionError(
        'CACHE_BUSY',
        'Cache cleanup is active; retry the preview after it completes',
      );
    const task = this.previewQueue.then(async () => {
      try {
        const snapshot = params.draft
          ? await this.compositionDraft(
              this.service.snapshot,
              params.sceneId!,
              params.frame ?? 0,
              params.draft,
            )
          : this.service.snapshot;
        const start = performance.now(),
          canvas = await this.renderer.render(snapshot, params.frame ?? 0, params),
          renderMs = performance.now() - start;
        try {
          const encodedAt = performance.now(),
            format = params.format ?? 'png',
            width = canvas.width,
            height = canvas.height,
            buffer =
              format === 'rgba'
                ? Buffer.from(canvas.getContext('2d').getImageData(0, 0, width, height).data)
                : await canvas.encode('png'),
            encodeMs = performance.now() - encodedAt;
          const used = this.renderer.mediaInfo(),
            media = {
              quality: used.quality,
              proxyCount: used.uses.filter((u) => u.proxy).length,
              decodePixels: used.uses.reduce((n, u) => n + u.decodeWidth * u.decodeHeight, 0),
            };
          if (!params.draft) {
            if (format === 'rgba')
              this.lastRgbaFrame = {
                buffer,
                revision: snapshot.revision,
                frame: params.frame ?? 0,
                width,
                height,
                media,
              };
            else
              this.lastFrame = {
                buffer,
                revision: snapshot.revision,
                frame: params.frame ?? 0,
                media,
              };
          }
          return {
            buffer,
            stale: false,
            revision: snapshot.revision,
            frame: params.frame ?? 0,
            format,
            width,
            height,
            renderMs,
            encodeMs,
            media,
          };
        } finally {
          canvas.width = 1;
          canvas.height = 1;
        }
      } catch (e) {
        const previous = params.format === 'rgba' ? this.lastRgbaFrame : this.lastFrame;
        if (params.fallback && previous)
          return {
            ...previous,
            format: params.format ?? 'png',
            stale: true,
            error: (e as Error).message,
          };
        throw e;
      }
    });
    this.previewQueue = task.catch(() => {});
    return task;
  }
  private async compositionDraft(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    draft: CompositionDraft | CompositionDraft[],
  ): Promise<Snapshot> {
    const operations = await this.compositionOperations(
      snapshot,
      sceneId,
      frame,
      Array.isArray(draft) ? draft : [draft],
    );
    const updates = new Map(
      operations.map((op) => {
        const update = op as Extract<Operation, { type: 'updateNode' }>;
        return [update.nodeId, update.patch];
      }),
    );
    return {
      ...snapshot,
      scenes: snapshot.scenes.map((scene) =>
        scene.id !== sceneId
          ? scene
          : {
              ...scene,
              nodes: scene.nodes.map((node) => {
                const patch = updates.get(node.id);
                return patch ? nodeSchema.parse({ ...node, ...patch, id: node.id }) : node;
              }),
            },
      ),
    };
  }
  private async compositionOperations(
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ): Promise<Operation[]> {
    if (!Array.isArray(edits) || !edits.length || edits.length > 1000)
      throw new VmotionError('OPERATIONS', 'Expected 1–1000 composition edits');
    const scene = snapshot.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
    const scopes = new Map<string, Awaited<ReturnType<Renderer['inspectComposition']>>>(),
      updates = new Map<string, Node>();
    for (const edit of edits) {
      const editFrame = edit.frame ?? frame,
        contextFrames = edit.contextFrames ?? [];
      const key = JSON.stringify([edit.path ?? [], editFrame, contextFrames]);
      if (!scopes.has(key))
        scopes.set(
          key,
          await this.renderer.inspectComposition(
            snapshot,
            sceneId,
            editFrame,
            edit.path ?? [],
            contextFrames,
          ),
        );
      const target = scopes.get(key)!.targets[edit.nodeId];
      if (!target) throw new VmotionError('NOT_FOUND', 'Composition layer not found');
      const id = target.kind === 'node' ? target.nodeId : target.rootNodeId,
        root = updates.get(id) ?? scene.nodes.find((n) => n.id === id);
      if (!root) throw new VmotionError('NOT_FOUND', 'Source layer not found');
      const changed =
        target.kind === 'node'
          ? { ...root, ...edit.patch, id: root.id }
          : {
              ...root,
              overrides: {
                ...root.overrides,
                [target.relativeId]: { ...root.overrides[target.relativeId], ...edit.patch },
              },
            };
      updates.set(id, nodeSchema.parse(changed));
    }
    return [...updates.values()].map((node) => ({
      type: 'updateNode',
      sceneId,
      nodeId: node.id,
      patch: node,
    }));
  }
  async dispatch<M extends RpcMethod>(method: M, params?: unknown): Promise<RpcOutput<M>>;
  async dispatch(method: string, params?: unknown): Promise<unknown>;
  async dispatch(method: string, params: unknown = {}): Promise<unknown> {
    if (method === 'agentToolInvoke') return this.dispatchImpl(method, params);
    if (this.cacheApplying && !['state', 'ping', 'renderStatus', 'cacheInspect'].includes(method))
      throw new VmotionError('CACHE_BUSY', 'Cache cleanup is active; retry after it completes');
    this.activeRequests++;
    try {
      return await this.dispatchImpl(method, params);
    } finally {
      this.activeRequests--;
    }
  }
  async dispatchTyped<M extends RpcMethod>(method: M, params: RpcInput<M>): Promise<RpcOutput<M>> {
    return (await this.dispatch(method, params)) as RpcOutput<M>;
  }
  private async dispatchImpl(method: string, params: unknown = {}): Promise<unknown> {
    if (builtinPlugins.hasMethod(method))
      return builtinPlugins.dispatch(
        {
          root: this.root,
          renderer: this.renderer,
          snapshot: this.service.snapshot,
          audioPreview: this.audioPreview,
          audioLive: this.audioLive,
          renders: this.renders,
          exportState: () => ({
            pendingFiles: !!this.service.pendingFiles,
            diagnostics: this.service.diagnostics,
          }),
          transact: (operations, revision, save) =>
            this.service.transact(operations, revision, save),
          select: (ids) => {
            this.service.selection = ids;
            this.emit('change', this.service.state());
            return this.service.state();
          },
          state: () => this.service.state(),
          drawingService: this.service,
          importAsset: (file, type, copy, metadata) =>
            this.service.importAsset(file, type, copy, metadata),
          reportDiagnostics: (diagnostics) => {
            this.service.diagnostics.push(...diagnostics);
            this.emit('change', this.service.state());
          },
          thumbnail: (id, width, height) => this.assetThumbnail(id, width, height),
          proxies: this.proxies,
          tracking: this.tracking,
          releaseMedia: () => this.releaseMedia(),
          coreService: this.service,
          plugins: this.plugins,
          registry: builtinPlugins,
          definitions: () => [...this.builtinTools, ...this.pluginDefinitions()],
          applicationState: () => this.applicationState(),
          notifyState: () => this.emit('change', this.service.state()),
          applyCache: (params) => this.applyCache(params),
          frame: (params) => this.frame(params),
          candidateSnapshot: (params) => this.candidateSnapshot(params),
          withMediaTask: (work) => this.withMediaTask(work),
          edit: (s, scene, frame, edits) => this.compositionOperations(s, scene, frame, edits),
        },
        method,
        params,
      );
    if (method.startsWith('plugin:')) {
      const [, id, toolId] = method.split(':');
      return callPluginTool(
        this.root,
        this.plugins,
        this.renderer,
        structuredClone(this.service.snapshot),
        id,
        toolId,
        params,
      );
    }
    const input =
      params && typeof params === 'object' && !Array.isArray(params)
        ? (params as Record<string, unknown>)
        : {};
    switch (method) {
      case 'pluginCatalog':
        return pluginCatalog(
          this.plugins,
          this.service.snapshot,
          typeof input.ifHash === 'string' ? input.ifHash : undefined,
        );
      case 'agentDefinitions':
        return pluginCatalog(
          this.plugins,
          this.service.snapshot,
          typeof input.ifHash === 'string' ? input.ifHash : undefined,
        );
      case 'ping':
        // Optional `agent` lets an MCP server announce its client for the Studio's
        // connection pill. Older callers send no params and get the same answer.
        if (input.agent) this.noteAgent(input.agent);
        return {
          revision: this.service.snapshot.revision,
          formatVersion: this.service.snapshot.project.formatVersion,
          aiIntegration: false,
          origins: true,
        };
      case 'agentHold': {
        // Studio-only toggle: pause/resume edits from external MCP clients.
        const hold = z.object({ hold: z.boolean() }).strict().parse(params).hold;
        this.service.setAgentHold(hold);
        const state = this.agentState();
        this.emit('agents', state);
        return state;
      }
      case 'agentStatus':
        return { ...this.agentState(), changeLog: this.changeLog() };
      case 'agentToolInvoke': {
        let request;
        try {
          request = toolCallSchema
            .extend({
              inline: z.boolean().default(true),
              // Optional attribution from newer MCP servers (only sent when ping reports origins).
              agent: agentSchema.optional(),
              intent: z.string().max(240).optional(),
            })
            .parse(params);
        } catch (e) {
          if (e instanceof z.ZodError)
            throw new VmotionError(
              'TOOL_ARGUMENTS',
              'Invalid agent tool invocation',
              e.issues.map((i) => ({ path: '/' + i.path.join('/'), message: i.message })),
            );
          throw e;
        }
        const client = request.agent ? this.noteAgent(request.agent) : undefined,
          origin: ChangeOrigin = {
            kind: 'mcp',
            client: client ?? this.lastActiveClient(),
            tool: request.name,
            intent:
              request.intent ??
              (typeof request.arguments.intent === 'string' ? request.arguments.intent : undefined),
          };
        return withChangeOrigin(origin, () =>
          invokeTool(
            findTool([...this.builtinTools, ...this.pluginDefinitions()], request.name),
            request.arguments,
            (method, args) => this.dispatch(method, args),
            {
              response: request.response,
              inline: request.inline,
              fields: request.fields,
              media: request.media,
            },
          ),
        );
      }
      case 'drawingStroke': {
        const id = randomUUID(),
          file = `assets/drawing-${id}.json`;
        await atomicWrite(safePath(this.root, file), JSON.stringify({ points: input.points }));
        return this.service.transact([
          {
            type: 'addAsset',
            asset: {
              id,
              name: `Drawing ${id.slice(0, 6)}`,
              path: file,
              type: 'drawing',
              managed: true,
              metadata: {},
            },
          },
          {
            type: 'addNode',
            sceneId: typeof input.sceneId === 'string' ? input.sceneId : '',
            node: {
              id,
              type: 'drawing',
              name: 'Brush stroke',
              assetId: id,
              x: 0,
              y: 0,
              width: this.service.snapshot.project.width,
              height: this.service.snapshot.project.height,
              stroke: typeof input.color === 'string' ? input.color : '#c1b6ff',
              strokeWidth: typeof input.width === 'number' ? input.width : 6,
              start: typeof input.start === 'number' ? input.start : 0,
              end: typeof input.end === 'number' ? input.end : 1,
            },
          },
        ]);
      }
      default:
        throw new VmotionError('METHOD_NOT_FOUND', `Unknown method: ${method}`);
    }
  }
  private lastActiveClient() {
    const active = this.agentState().clients.filter((c) => c.active);
    return active.length === 1 ? active[0].client : undefined;
  }
  applicationState() {
    return {
      changeLog: this.changeLog(),
      agents: this.agentState(),
      mediaEpoch: this.mediaEpoch,
      proxyJobs: [...this.proxies.jobs.values()].map((job) => ({ ...job })),
      ...this.service.state(),
      root: this.root,
      connection: this.connection(),
      jobs: Array.from(this.renders.jobs.values()),
      capabilities: {
        formatVersion: 1,
        renderer: 'Rust/Skia CPU (@napi-rs/canvas)',
        nativeAnimation: this.renderer.native.available,
        gpu: false,
        gpuEffects: {
          mode: this.renderer.gpu.mode,
          status: this.renderer.gpu.report().status,
          scope: 'point-effects',
          fullSceneGpu: false,
        },
        workspaces: ['animation', 'editing', 'music', 'drawing','code'],
        agentWorkbench: '/agent/',
        aiIntegration: false,
        animationTools: [
          'timing',
          'spring',
          'stagger',
          'motionPath',
          'pointMorph',
          'gradient',
          'textAnimator',
          'effectStack',
          'particles',
          'trail',
          'projection3D',
          'matrixScene3D',
          'depthRaster3D',
          'temporalMotionBlur',
          'multiFrameCapture',
        ],
      },
    };
  }
  agentDiscovery(raw: unknown) {
    const input = agentDiscoverySchema.parse(raw),
      definitions = [...this.builtinTools, ...this.pluginDefinitions()];
    if (input.kind === 'search')
      return searchTools(definitions, toolSearchSchema.parse(input.request));
    const request = toolSchemaRequestSchema.parse(input.request);
    return toolSchema(definitions, request.name, request);
  }
  private async applyCache(params: unknown) {
    if (
      this.activeRequests > 1 ||
      this.mediaTasks ||
      this.tracking.active ||
      this.renderer.busy ||
      this.audioPreview.busy ||
      this.proxies.active ||
      [...this.renders.jobs.values()].some((j) => ['queued', 'running'].includes(j.status))
    )
      throw new VmotionError(
        'CACHE_BUSY',
        'Finish or cancel active media/render tasks before reclaiming caches',
      );
    this.cacheApplying = true;
    try {
      await this.renderer.clearMediaCache();
      this.audioPreview.clearCache();
      const result = await applyCacheCleanup(this.root, params, this.service.snapshot);
      this.mediaEpoch++;
      this.emit('change', { ...this.service.state(), mediaEpoch: this.mediaEpoch });
      return result;
    } finally {
      this.cacheApplying = false;
    }
  }

  async drawingFrame(params: unknown) {
    const request = z
      .object({
        id: z.string().min(1),
        width: z.number().int().positive().optional(),
        height: z.number().int().positive().optional(),
        draft: drawingDraftSchema.optional(),
      })
      .strict()
      .parse(params);
    return drawingPreview(
      this.service.snapshot,
      request.id,
      request.width,
      request.height,
      request.draft,
    );
  }
  async assetThumbnail(id: string, width = 160, height = 100) {
    if (
      !Number.isInteger(width) ||
      !Number.isInteger(height) ||
      width < 16 ||
      height < 16 ||
      width > 512 ||
      height > 512
    )
      throw new VmotionError('RESOLUTION', '素材缩略图尺寸无效');
    const snapshot = this.service.snapshot,
      asset = snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', '素材不存在');
    const key = `${id}:${await fingerprint(path.resolve(this.root, asset.path))}:${snapshot.revision}:${width}:${height}`;
    if (!this.assetThumbnails.has(key)) {
      if (this.assetThumbnails.size >= 128)
        this.assetThumbnails.delete(this.assetThumbnails.keys().next().value!);
      const promise = (async () => {
        if (asset.type === 'drawing')
          return drawingFrame(
            await drawingFromAsset(this.root, snapshot, id),
            width,
            height,
            true,
          ).encode('png');
        if (asset.type === 'image') {
          const image = await loadImage(path.resolve(this.root, asset.path)),
            canvas = createCanvas(width, height),
            ctx = canvas.getContext('2d'),
            scale = Math.min(width / image.width, height / image.height);
          ctx.drawImage(
            image,
            (width - image.width * scale) / 2,
            (height - image.height * scale) / 2,
            image.width * scale,
            image.height * scale,
          );
          return canvas.encode('png');
        }
        if (asset.type === 'video') {
          const scene = {
            id: 'asset-thumbnail',
            name: asset.name,
            duration: 1,
            background: 'transparent',
            nodes: [
              nodeSchema.parse({
                id: 'thumbnail',
                type: 'video',
                assetId: id,
                width: snapshot.project.width,
                height: snapshot.project.height,
              }),
            ],
          };
          return (
            await this.renderer.render({ ...snapshot, scenes: [scene] }, 0, {
              sceneId: scene.id,
              width,
              height,
            })
          ).encode('png');
        }
        throw new VmotionError('ASSET_TYPE', '此素材没有视觉缩略图');
      })().catch((e) => {
        this.assetThumbnails.delete(key);
        throw e;
      });
      this.assetThumbnails.set(key, promise);
    }
    return this.assetThumbnails.get(key)!;
  }
  private async candidateSnapshot(params: {
    planId?: string;
    revision?: string;
  }): Promise<Snapshot> {
    let snapshot = structuredClone(this.service.snapshot);
    if (params.revision && params.revision !== snapshot.revision)
      throw new VmotionError('REVISION_CONFLICT', 'Project changed before candidate inspection');
    if (params.planId) {
      const input = await resolveAgentPlan(this.root, { planId: params.planId });
      if (input.revision !== snapshot.revision)
        throw new VmotionError('REVISION_CONFLICT', 'Candidate base changed; regenerate it');
      snapshot = applyOperations(this.root, snapshot, [
        ...(input.operations ?? []),
        ...(input.files?.length ? [{ type: 'editFiles', edits: input.files }] : []),
      ]);
      await checkAssets(this.root, snapshot, input.assetChecks ?? []);
    }
    return snapshot;
  }
  private async withMediaTask<T>(work: () => Promise<T>) {
    if (this.cacheApplying) throw new VmotionError('CACHE_BUSY', 'Cache cleanup is active');
    this.mediaTasks++;
    try {
      return await work();
    } finally {
      this.mediaTasks--;
    }
  }
  private async releaseMedia() {
    if (
      this.renderer.busy ||
      this.audioPreview.busy ||
      this.mediaTasks ||
      this.tracking.active ||
      this.proxies.active ||
      [...this.renders.jobs.values()].some((j) => ['queued', 'running'].includes(j.status))
    )
      throw new VmotionError('CACHE_BUSY', 'Preview/media operations are active');
    this.cacheApplying = true;
    try {
      await this.renderer.clearMediaCache();
      return { released: true, projectChanged: false };
    } finally {
      this.cacheApplying = false;
    }
  }
  async audioRange(snapshot: Snapshot, params: unknown, signal?: AbortSignal) {
    return this.withMediaTask(() => this.audioPreview.range(snapshot, params, signal));
  }
  private assetPath(id: string) {
    const asset = this.service.snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
    return path.resolve(this.root, asset.path);
  }
  private async audioAssetPath(id: string) {
    const snapshot = this.service.snapshot,
      asset = snapshot.project.assets.find((a) => a.id === id);
    if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
    return audioSourceFile(this.root, snapshot, asset);
  }
  async close() {
    this.plugins.clear();
    await this.service.close();
    await this.renders.close();
    await this.proxies.close();
    await this.tracking.close();
    await this.audioPreview.close();
    await this.audioLive.close();
    await this.previewQueue;
    this.lastFrame = undefined;
    this.lastRgbaFrame = undefined;
    await this.renderer.close();
  }
}
