import type { z } from 'zod';
import type { CompositionDraft } from '../core/interaction.js';
import type { invokeTool } from '../mcp/invoke.js';
import type { builtinRpcHandlers } from '../plugins/rpc-handlers.js';
import type { Application } from './application.js';
import type { pluginCatalog } from './plugins.js';
import type { ProjectService } from './service.js';

export type EmptyRequest = Record<string, never>;

export interface FrameRequest {
  frame?: number;
  width?: number;
  height?: number;
  sceneId?: string;
  path?: string[];
  contextFrames?: number[];
  output?: string;
  fallback?: boolean;
  draft?: CompositionDraft | CompositionDraft[];
  format?: 'png' | 'rgba';
  mediaQuality?: 'original' | 'auto';
}

export interface FrameResult {
  buffer: Buffer;
  stale: boolean;
  revision: string;
  frame: number;
  format: 'png' | 'rgba';
  width?: number;
  height?: number;
  renderMs?: number;
  encodeMs?: number;
  media?: { quality: string; proxyCount: number; decodePixels: number };
  error?: string;
}

export type ApplicationState = ReturnType<Application['applicationState']>;
type BuiltinRpcMethodMap = {
  [M in keyof typeof builtinRpcHandlers]: {
    input: z.input<(typeof builtinRpcHandlers)[M]['schema']>;
    output: Awaited<ReturnType<(typeof builtinRpcHandlers)[M]['run']>>;
  };
};

export interface HostRpcMethodMap {
  drawingStroke: {
    input: {
      sceneId: string;
      points: unknown;
      color: string;
      width: number;
      start: number;
      end: number;
    };
    output: ReturnType<ProjectService['state']>;
  };
  pluginCatalog: { input: { ifHash?: string }; output: ReturnType<typeof pluginCatalog> };
  agentDefinitions: { input: { ifHash?: string }; output: ReturnType<typeof pluginCatalog> };
  agentToolInvoke: {
    input: Record<string, unknown>;
    output: Awaited<ReturnType<typeof invokeTool>>;
  };
  ping: {
    input: EmptyRequest;
    output: { revision: string; formatVersion: number; aiIntegration: false };
  };
}
export type RpcMethodMap = BuiltinRpcMethodMap & HostRpcMethodMap;

export type RpcMethod = keyof RpcMethodMap;
export type RpcInput<M extends RpcMethod> = RpcMethodMap[M]['input'];
export type RpcOutput<M extends RpcMethod> = RpcMethodMap[M]['output'];
