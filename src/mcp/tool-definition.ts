import { z, type ZodTypeAny } from 'zod';
import type { ToolCategory } from './discovery.js';

/**
 * What a capability does to the project when called with its defaults:
 * - read: inspects only (no project commit; may write caches/evidence files).
 * - plan: returns a stored candidate `plan {planId, candidateRevision, summary}` and never commits;
 *   the next step is project_preflight({planId}) then project_apply({planId}).
 * - write: commits (or produces files/jobs) directly. Write tools with `planMode` accept
 *   mode='plan' and then behave like planners.
 */
export type ToolEffect = 'read' | 'plan' | 'write';

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
  /** Declared effect; derived from the name/annotations when omitted (see deriveToolEffect). */
  effect?: ToolEffect;
  /** Tool that consumes this planner's planId (default project_apply via project_preflight). */
  applyWith?: string;
}

export interface ToolDefinition extends ToolDefinitionInput {
  categories: ToolCategory[];
  keywords: string;
  annotations: NonNullable<ToolDefinitionInput['annotations']>;
  /** Write tool whose single transaction can be captured as a stored candidate (mode=plan). */
  planMode?: 'native' | 'captured';
  /** Contract arguments added by the MCP layer; stripped before the backend handler runs. */
  injected?: string[];
}
export type NormalizedToolDefinition = ToolDefinition;

export const defaultToolAnnotations: NonNullable<ToolDefinition['annotations']> = {
  readOnlyHint: false,
  destructiveHint: false,
  idempotentHint: false,
  openWorldHint: false,
};

/** Read-only by annotation but returning a stored/exact candidate (planner without a _plan name). */
const plannerNames = new Set([
  'mesh_generate',
  'mesh_import',
  'scene3d_materials',
  'plugins_install',
]);
/** Direct writes whose handler commits exactly one host transaction; mode=plan captures it. */
export const capturedPlanTools = new Set([
  'animation_edit',
  'time_edit',
  'component_parameters_edit',
  'composition_edit_layer',
  'composition_structure',
  'composition_structure_batch',
  'scene_place',
  'scene_precompose',
  'scene_reset_instance',
  'asset_place',
  'sequence_edit',
  'captions_import',
  'vector_bake',
  'repeat_create',
  'effect_import_lut',
  'project_transact',
]);
export function deriveToolEffect(tool: ToolDefinitionInput): ToolEffect {
  if (tool.effect) return tool.effect;
  if (/_plan$/.test(tool.name) || plannerNames.has(tool.name)) return 'plan';
  return tool.annotations?.readOnlyHint ? 'read' : 'write';
}
export const planModeSchema = z
  .enum(['apply', 'plan'])
  .optional()
  .describe('plan: stored candidate, no commit');
export const planDetailSchema = z.boolean().optional().describe('Inline plan operations');

export function normalizeToolDefinition(
  tool: ToolDefinitionInput,
  defaults: { categories?: ToolCategory[]; keywords?: string } = {},
): NormalizedToolDefinition {
  const effect = deriveToolEffect(tool),
    schema = { ...tool.schema },
    injected: string[] = [];
  let planMode: ToolDefinition['planMode'];
  if (
    effect === 'write' &&
    Object.hasOwn(schema, 'mode') &&
    tool.name === 'composition_edit_layers'
  )
    planMode = 'native';
  else if (
    effect === 'write' &&
    capturedPlanTools.has(tool.name) &&
    !Object.hasOwn(schema, 'mode')
  ) {
    schema.mode = planModeSchema;
    injected.push('mode');
    planMode = 'captured';
  }
  if (
    (effect === 'plan' || planMode) &&
    !Object.hasOwn(schema, 'detail') &&
    tool.applyWith === undefined
  ) {
    schema.detail = planDetailSchema;
    injected.push('detail');
  }
  return {
    ...tool,
    schema,
    categories: [...(tool.categories ?? defaults.categories ?? ['core'])],
    keywords: tool.keywords ?? defaults.keywords ?? '',
    annotations: { ...defaultToolAnnotations, ...tool.annotations },
    effect,
    ...(planMode ? { planMode } : {}),
    ...(injected.length ? { injected } : {}),
  };
}
