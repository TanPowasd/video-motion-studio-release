import type { ZodTypeAny } from 'zod';
import type { ToolCategory } from './discovery.js';

export interface ToolDefinitionInput {
  name: string;
  description: string;
  method: string;
  schema: Record<string, ZodTypeAny>;
  plugin?: { id: string; version: string; origin: 'builtin' | 'project'; hash?: string };
  categories?: ToolCategory[];
  keywords?: string;
  annotations?: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}

export interface ToolDefinition extends ToolDefinitionInput {
  categories: ToolCategory[];
  keywords: string;
  annotations: NonNullable<ToolDefinitionInput['annotations']>;
}
export type NormalizedToolDefinition = ToolDefinition;

export const defaultToolAnnotations: NonNullable<ToolDefinition['annotations']> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

export function normalizeToolDefinition(
  tool: ToolDefinitionInput,
  defaults: { categories?: ToolCategory[]; keywords?: string } = {},
): NormalizedToolDefinition {
  return {
    ...tool,
    categories: [...(tool.categories ?? defaults.categories ?? ['core'])],
    keywords: tool.keywords ?? defaults.keywords ?? '',
    annotations: { ...defaultToolAnnotations, ...tool.annotations },
  };
}
