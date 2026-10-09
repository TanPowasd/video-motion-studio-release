import type { ParameterDefinitions, ParameterValues } from '../core/parameters.js';
import type { Operation, Project, Scene, Sequence, Asset } from '../core/model.js';
import type { FileEdit } from '../core/file-edits.js';
export interface PluginContext {
  revision: string;
  project: Pick<
    Project,
    'id' | 'name' | 'width' | 'height' | 'fps' | 'sampleRate' | 'activeSequence'
  >;
  scenes: Scene[];
  sequences: Sequence[];
  assets: Asset[];
  files: Record<string, string>;
}
export interface PluginCandidate {
  operations?: Operation[];
  files?: FileEdit[];
  assetChecks?: Array<{ assetId: string; fingerprint: string }>;
  samples?: Array<{
    sceneId?: string;
    sequenceId?: string;
    frame: number;
    path?: string[];
    contextFrames?: number[];
  }>;
  summary?: Record<string, unknown>;
}
export interface PluginToolImplementation<P extends ParameterDefinitions = ParameterDefinitions> {
  parameters: P;
  run: (context: PluginContext, params: ParameterValues<P>) => unknown;
}
export function definePluginTool<const P extends ParameterDefinitions>(
  tool: PluginToolImplementation<P>,
) {
  return tool;
}
export function definePlugin<T extends Record<string, PluginToolImplementation<any>>>(plugin: {
  name: string;
  tools: T;
}) {
  return plugin;
}
export type { PluginBundleManifest, PluginManifest } from '../core/plugin-schema.js';
/** Result summary of plugins_install (candidate.summary.install). */
export interface PluginInstallSummary {
  origin: { type: 'bundle' | 'folder' | 'git' | string; [key: string]: unknown };
  digest: string;
  root: string;
  plugins: Array<{
    id: string;
    name: string;
    role: 'root' | 'dependency';
    change: 'install' | 'upgrade' | 'downgrade' | 'reinstall' | 'unchanged';
    from?: string;
    to: string;
    source: string;
    previousSource?: string;
    contentHash: string;
    enabled: boolean;
    pinned: boolean;
    files: { added: number; changed: number; unchanged: number; stale: string[] };
    tools: { added: string[]; removed: string[] };
    contributions: { added: string[]; removed: string[] };
    dependencies?: Record<string, { from: string | null; to: string | null }>;
  }>;
  dependencies: Array<{
    from: string;
    id: string;
    range: string;
    status: 'builtin' | 'installed' | 'enable' | 'bundled' | 'upgrade' | 'missing' | 'conflict';
    version?: string;
    bundledVersion?: string;
    installedVersion?: string;
  }>;
  skipped: string[];
  fileEdits: number;
}
