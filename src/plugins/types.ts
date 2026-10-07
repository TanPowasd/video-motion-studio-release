import type { CompositionDraft } from '../core/interaction.js';
import type { Diagnostic, Operation, Snapshot } from '../core/model.js';
import type { PluginRegistry } from '../core/plugins.js';
import type { Renderer } from '../core/renderer.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import type { AudioPreview } from '../media/audio-preview.js';
import type { AudioLiveService } from '../service/audio-live.js';
import type { RenderManager } from '../media/export.js';
import type { ProxyManager } from '../media/proxy-cache.js';
import type { applyCacheCleanup } from '../service/cache-management.js';
import type { ApplicationState, FrameRequest } from '../service/rpc-contract.js';
import type { ProjectService } from '../service/service.js';
import type { TrackingManager } from '../service/tracking-jobs.js';
import type { BuiltinPluginRegistry } from './registry.js';

/** Services owned by the application; builtin modules neither own nor close them. */
export interface BuiltinPluginHost {
  root: string;
  renderer: Renderer;
  snapshot: Snapshot;
  audioPreview: AudioPreview;
  audioLive: AudioLiveService;
  renders: RenderManager;
  exportState: () => { pendingFiles: boolean; diagnostics: Diagnostic[] };
  transact: ProjectService['transact'];
  select: (ids: string[]) => ReturnType<ProjectService['state']>;
  state: ProjectService['state'];
  drawingService: Pick<ProjectService, 'snapshot' | 'transact'>;
  importAsset: ProjectService['importAsset'];
  reportDiagnostics: (diagnostics: Diagnostic[]) => void;
  thumbnail: (id: string, width?: number, height?: number) => Promise<Buffer>;
  proxies: ProxyManager;
  tracking: TrackingManager;
  releaseMedia: () => Promise<{ released: boolean; projectChanged: boolean }>;
  coreService: Pick<
    ProjectService,
    | 'snapshot'
    | 'pendingFiles'
    | 'diagnostics'
    | 'conflicts'
    | 'selection'
    | 'state'
    | 'exclusive'
    | 'reload'
    | 'validate'
    | 'transact'
    | 'save'
    | 'undo'
    | 'redo'
    | 'resolve'
  >;
  plugins: PluginRegistry;
  definitions: () => ToolDefinition[];
  registry: BuiltinPluginRegistry;
  applicationState: () => ApplicationState;
  notifyState: () => void;
  applyCache: (params: unknown) => ReturnType<typeof applyCacheCleanup>;
  frame: (params: FrameRequest) => Promise<{ buffer: Buffer; revision: string; frame: number }>;
  candidateSnapshot: (params: { planId?: string; revision?: string }) => Promise<Snapshot>;
  withMediaTask: <T>(work: () => Promise<T>) => Promise<T>;
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>;
}

export interface BuiltinPluginModule {
  id: string;
  name: string;
  version: string;
  dependencies?: Record<string, string>;
  methods: ReadonlySet<string>;
  tools: () => ToolDefinition[];
  dispatch: (host: BuiltinPluginHost, method: string, params: unknown) => unknown;
}
