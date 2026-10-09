import { z } from 'zod';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from './catalog.js';
import { createHash } from 'node:crypto';

export const categorySchema = z.enum([
  'core',
  'animation',
  'effects',
  'composition',
  'vector',
  'drawing',
  'media',
  'editing',
  'audio',
  '3d',
  'math',
  'render',
  'recovery',
  'image',
  'glyphs',
]);
export type ToolCategory = z.infer<typeof categorySchema>;
export const coreTools = new Set([
  'agent_guide',
  'project_context',
  'project_file_read',
  'project_preflight',
  'project_apply',
  'frame_capture',
]);
const categoryAliases: Record<ToolCategory, string> = {
  effects: '特效 平面 扭曲 波形 旋转膨胀 色散 RGB 转场 擦除 effect warp wipe transition',
  core: '工程 源码 版本 参数 schema transaction file project',
  animation: '动画 关键帧 曲线 时间 动效 animation keyframe time effect',
  composition: '场景 合成 图层 编组 复制 composition layer group scene',
  vector: '矢量 路径 布尔 裁切 重复器 vector path boolean repeater',
  drawing: '绘画 笔迹 图层 画稿 drawing paint brush stroke',
  media: '素材 图片 视频 导入 媒体 asset media video image import',
  editing: '剪辑 时间轴 片段 字幕 二创 电影 timeline clip caption subtitle remix film',
  audio: '音频 音乐 声音 节拍 波形 audio sound music beat waveform',
  '3d': '三维 矩阵 相机 顶点 深度 网格 光照 3d matrix camera mesh depth lighting',
  math: '数学 线性代数 优化 求解 least squares algebra solve',
  render: '导出 渲染 帧 图像序列 编码 render export frame',
  recovery: '撤销 重做 恢复 错误 冲突 修复 undo redo conflict repair recovery',
  image: '图片 海报 封面 缩略图 静态 画板 印刷 出血 导出图片 PNG JPEG WebP still poster cover thumbnail artboard',
  glyphs: '字形 字形库 偏旁 部件 拼字 造字 IDS 笔画 无字体 glyph radical component typeface stroke',
};
const defaultToolAnnotations = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
} as const;
export function toolCategories(name: string, tool?: ToolDefinition): ToolCategory[] {
  return tool?.categories?.length ? [...tool.categories] : ['core'];
}
export function toolAnnotations(name: string, tool?: ToolDefinition) {
  return tool?.annotations ?? defaultToolAnnotations;
}
export const toolSearchSchema = z
  .object({
    query: z.string().max(200).default(''),
    category: categorySchema.optional(),
    pluginId: z.string().max(80).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(12),
    detail: z.boolean().default(false),
  })
  .strict();
const searchIndexes = new WeakMap<
  ToolDefinition[],
  Array<{
    tool: ToolDefinition;
    categories: ToolCategory[];
    name: string;
    own: string;
    text: string;
  }>
>();
function searchIndex(definitions: ToolDefinition[]) {
  let index = searchIndexes.get(definitions);
  if (!index) {
    index = definitions.map((tool) => {
      const categories = toolCategories(tool.name, tool),
        name = tool.name.toLowerCase(),
        own = (name + ' ' + tool.description + ' ' + (tool.keywords ?? '')).toLowerCase();
      return {
        tool,
        categories,
        name,
        own,
        text:
          own +
          ' ' +
          categories
            .map((c) => categoryAliases[c])
            .join(' ')
            .toLowerCase(),
      };
    });
    searchIndexes.set(definitions, index);
  }
  return index;
}
export function searchTools(
  definitions: ToolDefinition[],
  raw: unknown = {},
  enabled?: Set<string>,
) {
  const request = toolSearchSchema.parse(raw),
    query = request.query.toLowerCase().trim(),
    terms = query.split(/\s+/).filter(Boolean),
    ranked = searchIndex(definitions)
      .map(({ tool, categories, name, own, text }) => {
        let score = 0;
        for (const term of terms) {
          if (!text.includes(term)) return { tool, categories, score: -1 };
          score += name === term ? 100 : name.includes(term) ? 60 : own.includes(term) ? 30 : 1;
        }
        return { tool, categories, score };
      })
      .filter(
        (item) =>
          item.score >= 0 &&
          (!request.category || item.categories.includes(request.category)) &&
          (!request.pluginId || item.tool.plugin?.id === request.pluginId),
      )
      .sort((a, b) => b.score - a.score || a.tool.name.localeCompare(b.tool.name, 'en')),
    items = ranked
      .slice(request.offset, request.offset + request.limit)
      .map(({ tool, categories }) => ({
        name: tool.name,
        summary: request.detail
          ? tool.description
          : tool.description.split(/\.\s/)[0].slice(0, 160),
        ...(tool.description.split(/\.\s/)[0].length > 160 && !request.detail
          ? { summaryTruncated: true }
          : {}),
        categories,
        annotations: toolAnnotations(tool.name, tool),
        ...(tool.plugin
          ? {
              plugin: request.detail
                ? tool.plugin
                : { id: tool.plugin.id, version: tool.plugin.version },
            }
          : {}),
        ...(enabled ? { enabled: enabled.has(tool.name) } : {}),
        ...(request.detail ? { arguments: Object.keys(tool.schema) } : {}),
      }));
  return {
    query: request.query,
    category: request.category,
    total: ranked.length,
    offset: request.offset,
    items,
    truncated: request.offset + request.limit < ranked.length,
    nextOffset:
      request.offset + request.limit < ranked.length ? request.offset + request.limit : undefined,
    ...(request.detail
      ? {
          categories: (Object.keys(categoryAliases) as ToolCategory[]).map((category) => ({
            category,
            count: definitions.filter((t) => toolCategories(t.name, t).includes(category)).length,
          })),
        }
      : {}),
    next: 'tool_schema for inputs; tool_call to invoke. detail=true adds catalog metadata.',
  };
}
export function findTool(definitions: ToolDefinition[], name: string) {
  const tool = definitions.find((t) => t.name === name);
  if (!tool)
    throw new VmotionError('TOOL_NOT_FOUND', `Unknown Vmotion tool ${name}; use tools_search`);
  return tool;
}
export const toolSchemaRequestSchema = z
  .object({
    name: z.string().min(1),
    format: z.enum(['compact', 'expanded']).default('compact'),
    detail: z.boolean().default(false),
    ifHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    paths: z
      .array(
        z
          .string()
          .min(1)
          .max(200)
          .regex(/^[a-zA-Z_][\w-]*(?:\.[a-zA-Z_][\w-]*)*$/),
      )
      .min(1)
      .max(32)
      .optional(),
  })
  .strict();
const schemaCache = new WeakMap<
  ToolDefinition,
  { compact: Record<string, unknown>; expanded: Record<string, unknown>; hash: string }
>();
type ToolSchemaView = {
  plugin?: ToolDefinition['plugin'];
  projection?: { paths: string[]; partial: true; validation: 'full-tool-schema' };
  name: string;
  schemaHash: string;
  format: 'compact' | 'expanded';
  description?: string;
  categories: ToolCategory[];
  annotations: ReturnType<typeof toolAnnotations>;
  inputSchema: Record<string, unknown>;
  call?: { tool: string; arguments: { name: string; arguments: Record<string, unknown> } };
  response?: string;
};
type ToolSchemaCached = { name: string; schemaHash: string; notModified: true };
export function toolSchema(definitions: ToolDefinition[], name: string): ToolSchemaView;
export function toolSchema(
  definitions: ToolDefinition[],
  name: string,
  options: { format?: 'compact' | 'expanded'; ifHash?: string; paths?: string[]; detail?: boolean },
): ToolSchemaView | ToolSchemaCached;
export function toolSchema(
  definitions: ToolDefinition[],
  name: string,
  options: {
    format?: 'compact' | 'expanded';
    ifHash?: string;
    paths?: string[];
    detail?: boolean;
  } = {},
): ToolSchemaView | ToolSchemaCached {
  const tool = findTool(definitions, name);
  let entry = schemaCache.get(tool);
  if (!entry) {
    const object = z.object(tool.schema).strict(),
      expanded = zodToJsonSchema(object, { $refStrategy: 'none' }) as Record<string, unknown>,
      references = zodToJsonSchema(object, { $refStrategy: 'root' }) as Record<string, unknown>,
      compact =
        JSON.stringify(references).length < JSON.stringify(expanded).length ? references : expanded,
      hash = createHash('sha256')
        .update(JSON.stringify([name, tool.description, expanded]))
        .digest('hex');
    entry = { compact, expanded, hash };
    schemaCache.set(tool, entry);
  }
  let schemaHash = entry.hash,
    inputSchema = options.format === 'expanded' ? entry.expanded : entry.compact;
  const paths = options.paths ? [...new Set(options.paths)].sort() : undefined;
  if (paths) {
    const select = (schema: z.ZodTypeAny, chosen: string[], prefix: string): z.ZodTypeAny => {
      if (chosen.includes('')) return schema;
      if (schema instanceof z.ZodOptional)
        return select(schema.unwrap(), chosen, prefix).optional();
      if (schema instanceof z.ZodNullable)
        return select(schema.unwrap(), chosen, prefix).nullable();
      if (schema instanceof z.ZodDefault)
        return select(schema._def.innerType, chosen, prefix).default(schema._def.defaultValue);
      if (!(schema instanceof z.ZodObject))
        throw new VmotionError(
          'TOOL_SCHEMA_PATH',
          'Select a whole non-object field instead of descending into it',
          { path: prefix },
        );
      const shape: z.ZodRawShape = {};
      for (const head of new Set(chosen.map((p) => p.split('.')[0]))) {
        if (!Object.hasOwn(schema.shape, head))
          throw new VmotionError('TOOL_SCHEMA_PATH', 'Schema path is missing', {
            path: prefix ? prefix + '.' + head : head,
          });
        shape[head] = select(
          schema.shape[head],
          chosen
            .filter((p) => p === head || p.startsWith(head + '.'))
            .map((p) => (p === head ? '' : p.slice(head.length + 1))),
          prefix ? prefix + '.' + head : head,
        );
      }
      return z.object(shape).strict();
    };
    const object = select(z.object(tool.schema).strict(), paths, '');
    inputSchema = zodToJsonSchema(object, {
      $refStrategy: options.format === 'expanded' ? 'none' : 'root',
    }) as Record<string, unknown>;
    schemaHash = createHash('sha256')
      .update(JSON.stringify([entry.hash, paths]))
      .digest('hex');
  }
  if (options.ifHash === schemaHash) return { name, schemaHash, notModified: true };
  return {
    name,
    schemaHash,
    format: options.format ?? 'compact',
    ...(options.detail ? { description: tool.description } : {}),
    categories: toolCategories(name, tool),
    annotations: toolAnnotations(name, tool),
    ...((options.detail || tool.plugin?.origin === 'project') && tool.plugin
      ? { plugin: tool.plugin }
      : {}),
    inputSchema,
    ...(paths
      ? { projection: { paths, partial: true as const, validation: 'full-tool-schema' as const } }
      : {}),
    ...(options.detail
      ? {
          call: { tool: 'tool_call', arguments: { name, arguments: {} } },
          response:
            'response=full preserves complete results. fields selects result paths; media=false omits inline media.',
        }
      : {}),
  };
}
export const toolLoadSchema = z
  .object({
    names: z.array(z.string()).max(1000).default([]),
    categories: z.array(categorySchema).max(32).default([]),
    mode: z.enum(['add', 'replace']).default('add'),
  })
  .strict();
export function selectTools(definitions: ToolDefinition[], raw: unknown, current: Set<string>) {
  const request = toolLoadSchema.parse(raw);
  request.names.forEach((name) => findTool(definitions, name));
  const selected = request.mode === 'add' ? new Set(current) : new Set(coreTools);
  for (const tool of definitions)
    if (
      request.names.includes(tool.name) ||
      toolCategories(tool.name, tool).some((c) => request.categories.includes(c))
    )
      selected.add(tool.name);
  coreTools.forEach((name) => selected.add(name));
  return selected;
}
