import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';
export const recoveryPlugin: BuiltinPluginModule = {
  id: 'vmotion.recovery',
  name: '共享历史与冲突恢复',
  version: '1.0.0',
  methods: new Set(['undo', 'redo', 'resolve']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'project_undo',
        description: 'Undo the last accepted transaction.',
        method: 'undo',
        schema: {},

        categories: ['recovery'],
        keywords: '撤销 恢复',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_redo',
        description: 'Redo an undone transaction.',
        method: 'redo',
        schema: {},

        categories: ['recovery'],
        keywords: '重做',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_resolve_conflict',
        description: 'Resolve a conflict while preserving both versions until chosen.',
        method: 'resolve',
        schema: { index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) },

        categories: ['recovery'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(recoveryRpcHandlers, host, method, params);
  },
};

export const recoveryRpcHandlers = {
  undo: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'undo';

      return host.coreService.undo();
    },
  ),
  redo: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'redo';

      return host.coreService.redo();
    },
  ),
  resolve: defineRpcHandler(
    z
      .object({ index: z.number().int().nonnegative(), choice: z.enum(['ours', 'theirs']) })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'resolve';

      return host.coreService.resolve(params.index, params.choice);
    },
  ),
};
