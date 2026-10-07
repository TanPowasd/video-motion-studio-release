import { builtinPlugins } from '../plugins/index.js';
import type { ToolDefinition } from './tool-definition.js';
export type { ToolDefinition, NormalizedToolDefinition } from './tool-definition.js';
export function toolDefinitions(): ToolDefinition[] {
  return [...builtinPlugins.tools];
}
