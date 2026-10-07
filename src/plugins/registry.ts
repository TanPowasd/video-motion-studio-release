import { VmotionError } from '../core/model.js';
import { builtinPluginVersions, pluginVersionMatches } from '../core/plugins.js';
import { normalizeToolDefinition, type ToolDefinition } from '../mcp/tool-definition.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from './types.js';

/** Construct once: reject ambiguous tools/handlers before any project is opened. */
export class BuiltinPluginRegistry {
  private readonly byMethod = new Map<string, BuiltinPluginModule>();
  private readonly byTool = new Map<string, BuiltinPluginModule>();
  private readonly byId = new Map<string, BuiltinPluginModule>();
  readonly tools: ToolDefinition[];

  constructor(modules: readonly BuiltinPluginModule[]) {
    const tools: ToolDefinition[] = [];
    for (const module of modules) {
      if (this.byId.has(module.id))
        throw new VmotionError('BUILTIN_PLUGIN_ID', 'Duplicate builtin module ID', {
          id: module.id,
        });
      if (
        !Object.hasOwn(builtinPluginVersions, module.id) ||
        builtinPluginVersions[module.id] !== module.version
      )
        throw new VmotionError(
          'BUILTIN_PLUGIN_VERSION',
          'Builtin module version differs from its public dependency version',
          { id: module.id },
        );
      this.byId.set(module.id, module);
      const definitions = module.tools();
      const provided = new Set(definitions.map((tool) => tool.method));
      if (
        [...provided].some((method) => !module.methods.has(method)) ||
        [...module.methods].some((method) => !provided.has(method))
      )
        throw new VmotionError(
          'BUILTIN_PLUGIN_METHOD',
          'Tool methods and module handlers must match',
          { id: module.id },
        );
      for (const method of module.methods) {
        if (this.byMethod.has(method))
          throw new VmotionError('BUILTIN_PLUGIN_METHOD', 'Duplicate builtin method handler', {
            id: module.id,
            method,
          });
        this.byMethod.set(method, module);
      }
      for (const tool of definitions) {
        if (
          !tool.categories?.length ||
          typeof tool.keywords !== 'string' ||
          !tool.annotations ||
          Object.values(tool.annotations).some((value) => typeof value !== 'boolean')
        )
          throw new VmotionError('BUILTIN_PLUGIN_METADATA', 'Builtin tool metadata is incomplete', {
            name: tool.name,
          });
        if (this.byTool.has(tool.name))
          throw new VmotionError('BUILTIN_PLUGIN_TOOL', 'Duplicate builtin tool name', {
            id: module.id,
            name: tool.name,
          });
        if (tool.plugin && (tool.plugin.id !== module.id || tool.plugin.version !== module.version))
          throw new VmotionError(
            'BUILTIN_PLUGIN_OWNER',
            'Tool owner differs from its dispatch module',
            { id: module.id, name: tool.name },
          );
        const normalized = normalizeToolDefinition(tool);
        this.byTool.set(normalized.name, module);
        tools.push({
          ...normalized,
          plugin: { id: module.id, version: module.version, origin: 'builtin' },
        });
      }
    }
    const active = new Set<string>(),
      done = new Set<string>();
    const visit = (module: BuiltinPluginModule) => {
      if (active.has(module.id))
        throw new VmotionError('BUILTIN_PLUGIN_CYCLE', 'Builtin module dependency cycle', {
          id: module.id,
        });
      if (done.has(module.id)) return;
      active.add(module.id);
      for (const [id, range] of Object.entries(module.dependencies ?? {})) {
        const version = Object.hasOwn(builtinPluginVersions, id)
          ? builtinPluginVersions[id]
          : undefined;
        if (!version || !pluginVersionMatches(version, range))
          throw new VmotionError(
            'BUILTIN_PLUGIN_DEPENDENCY',
            'Builtin module dependency is absent or incompatible',
            { id: module.id, dependency: id, range },
          );
        const dependency = this.byId.get(id);
        if (dependency) visit(dependency);
      }
      active.delete(module.id);
      done.add(module.id);
    };
    for (const module of modules) visit(module);
    this.tools = tools;
  }

  hasMethod(method: string) {
    return this.byMethod.has(method);
  }
  dispatch(host: BuiltinPluginHost, method: string, params: unknown) {
    const module = this.byMethod.get(method);
    if (!module)
      throw new VmotionError('METHOD_NOT_FOUND', 'No builtin module handles this method', {
        method,
      });
    return module.dispatch(host, method, params);
  }
  moduleForTool(name: string) {
    return this.byTool.get(name);
  }
  module(id: string) {
    return this.byId.get(id);
  }

  /** Report actual migration, including groups that still contain host handlers. */
  status(id: string, names: string[]) {
    const migrated = names.filter((name) => this.byTool.get(name)?.id === id);
    return {
      runtime:
        migrated.length === 0 ? 'host' : migrated.length === names.length ? 'module' : 'mixed',
      moduleTools: migrated.length,
      hostTools: names.length - migrated.length,
      dependencies: this.byId.get(id)?.dependencies ?? {},
    };
  }
}
