import { z } from 'zod';
import type { ToolDefinition } from '../mcp/catalog.js';
import {
  inspectTemplates,
  planTemplates,
  templateInspectSchema,
  templatePlanSchema,
} from '../service/templates.js';
import {
  inspectThemes,
  planTheme,
  themeInspectSchema,
  themePlanSchema,
} from '../service/themes.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginHost } from './types.js';
export const designPlugin = {
  id: 'vmotion.design',
  name: '主题与版本模板',
  version: '1.0.0',
  methods: new Set(['themeInspect', 'themePlan', 'templateInspect', 'templatePlan']),
  tools(): ToolDefinition[] {
    return (
      [
        {
          name: 'theme_inspect',
          description:
            'Read paginated typed/inherited/aliased theme tokens or one layer binding with literal/baseline/effective values and override priority. Native themes resolve before keys/drivers and share preview/selection/export.',
          method: 'themeInspect',
          schema: themeInspectSchema.shape,

          categories: ['effects', 'core', 'animation', 'composition'],
          keywords: '主题 品牌 颜色 字体 排版 令牌 alias token 检查',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: 'theme_plan',
          description:
            'Plan hash-checked theme authoring, token/parent changes and cross-scene bindings/local overrides/reset/detach. Themes remain live, edited literals and keys win, renderer checks value domains and cycles. Returns an exact stored candidate for preflight/apply and one undo.',
          method: 'themePlan',
          schema: themePlanSchema.shape,

          categories: ['effects', 'core', 'animation', 'composition'],
          keywords: '主题 品牌 配色 字体 别名 继承 绑定 参数 统一 调整 批量 候选',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: 'template_inspect',
          description:
            'Discover versioned scene templates or inspect one instance: typed ports/defaults, source version/hash, retained keys/overrides, pinned captured files and declared shared references. Full file hashes are opt-in.',
          method: 'templateInspect',
          schema: templateInspectSchema.shape,

          categories: ['effects', 'core', 'animation', 'composition'],
          keywords: '模板 版本 实例 自定义 参数 覆盖 原型 查询',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
        {
          name: 'template_plan',
          description:
            'Publish a versioned template from sibling layers or explicit JSON nodes; pin captured author code/dependencies, place scene instances, upgrade selected versions preserving customized params/keys/overrides with explicit parameter/layer migrations, or detach a private editable copy. New defaults replace unchanged fields; deleted customized params, conflicts and invalid new constraints stop the plan. Returns short exact preflight/apply and one undo. Shared/dynamic code references need explicit allowSharedCode; originals remain unchanged.',
          method: 'templatePlan',
          schema: templatePlanSchema.shape,

          categories: ['effects', 'core', 'animation', 'composition'],
          keywords: '模板 创建 捕获 源码 固定 实例 发布 升级 迁移 脱离 私有 拷贝 复用 批量',
          annotations: {
            readOnlyHint: true,
            destructiveHint: false,
            idempotentHint: true,
            openWorldHint: false,
          },
        },
      ] satisfies ToolDefinition[]
    ).map((t) => ({
      ...t,
      plugin: { id: 'vmotion.design', version: '1.0.0', origin: 'builtin' as const },
    }));
  },
  dispatch(host: BuiltinPluginHost, method: string, params: unknown) {
    return invokeRpcHandler(designRpcHandlers, host, method, params);
  },
};

export const designRpcHandlers = {
  themeInspect: defineRpcHandler(
    z.object(themeInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'themeInspect';

      return inspectThemes(host.renderer, host.snapshot, params);
    },
  ),
  themePlan: defineRpcHandler(
    z.object(themePlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'themePlan';

      return planTheme(host.root, host.renderer, structuredClone(host.snapshot), params, host.edit);
    },
  ),
  templateInspect: defineRpcHandler(
    z.object(templateInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'templateInspect';

      return inspectTemplates(host.renderer, host.snapshot, params);
    },
  ),
  templatePlan: defineRpcHandler(
    z.object(templatePlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'templatePlan';

      return planTemplates(
        host.root,
        host.renderer,
        structuredClone(host.snapshot),
        params,
        host.edit,
      );
    },
  ),
};
