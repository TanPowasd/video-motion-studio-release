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
