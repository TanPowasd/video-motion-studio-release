import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import {
  cacheApplySchema,
  cacheInspectSchema,
  cachePlanSchema,
  inspectCaches,
  planCacheCleanup,
} from '../service/cache-management.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';
export const cachePlugin: BuiltinPluginModule = {
  id: 'vmotion.cache',
  name: '缓存与空间管理',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0' },
  methods: new Set(['cacheInspect', 'cachePlan', 'cacheApply']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'cache_inspect',
        method: 'cacheInspect',
        schema: cacheInspectSchema.shape,
        description:
          'Inspect named regenerable project-cache groups with byte totals, leased/project-reference protection and optional file paging. Does not scan/delete source/assets/history/candidate plans/render checkpoints or loaded component bundles. Links are skipped and scan work is bounded.',

        categories: ['media', 'render', 'recovery'],
        keywords: '缓存 空间 磁盘 大小 检查 性能',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'cache_plan',
        method: 'cachePlan',
        schema: cachePlanSchema.shape,
        description:
          'Plan oldest eligible regenerable-cache files toward an explicit byte budget and minimum age without deleting. Fixed SHA-256 plan includes exact paths/size/mtime, excludes live leases and registered project media, and reports incomplete quotas. Stored candidates, source/history, render checkpoints and compiled modules stay protected.',

        categories: ['media', 'render'],
        keywords: '缓存 空间 配额 计划 清理 保护 磁盘',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'cache_apply',
        method: 'cacheApply',
        schema: cacheApplySchema.shape,
        description:
          'Apply a reviewed fixed cache-cleanup plan. Rejects active media/render/proxy work, revalidates resolved paths against named cache roots and skips changed/leased/newly referenced targets. Clears inactive preview readers first; returns actual reclaimed bytes and omissions. Only regenerable caches are removed, with no source/history/candidate/checkpoint deletion.',

        categories: ['media', 'render'],
        keywords: '缓存 空间 清理 回收 磁盘 保护',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(cacheRpcHandlers, host, method, params);
  },
};

export const cacheRpcHandlers = {
  cacheInspect: defineRpcHandler(
    z.object(cacheInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'cacheInspect';

      return inspectCaches(host.root, params, host.snapshot);
    },
  ),
  cachePlan: defineRpcHandler(
    z.object(cachePlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'cachePlan';

      return planCacheCleanup(host.root, params, host.snapshot);
    },
  ),
  cacheApply: defineRpcHandler(
    z.object(cacheApplySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'cacheApply';

      return host.applyCache(params);
    },
  ),
};
