import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { Application } from '../service/application.js';
import { VmotionError } from '../core/model.js';
import { existingService, rpc, servePipe } from '../service/ipc.js';
import { animationReference } from '../sdk/reference.js';
import { toolDefinitions, type ToolDefinition } from './catalog.js';
import {
  coreTools,
  findTool,
  toolCategories,
  toolAnnotations,
  toolSearchSchema,
  searchTools,
  toolSchema,
  toolSchemaRequestSchema,
  toolLoadSchema,
  selectTools,
} from './discovery.js';
import { invokeTool, toolError, toolCallSchema } from './invoke.js';
import { projectPluginTools, type PluginCatalog } from './plugin-tools.js';

export async function startMcp(root: string, options: { tools?: 'compact' | 'all' } = {}) {
  const remote = await existingService(root),
    app = remote ? undefined : await new Application(root).open(),
    pipe = app ? await servePipe(app) : undefined,
    call = (method: string, params?: unknown) =>
      app ? app.dispatch(method, params) : rpc(root, method, params),
    mode = options.tools ?? 'compact',
    server = new McpServer(
      { name: 'vmotion', version: '0.2.0' },
      {
        instructions:
          'Use project_context and agent_guide. tools_search lists concise capabilities; tool_schema gives one exact interface; tool_call executes any capability without loading schemas; tools_load enables direct tools for this connection. Candidate edits still require the shared preflight/apply flow. The application never calls AI models.',
      },
    ),
    builtinDefinitions = toolDefinitions(),
    registered = new Map<string, RegisteredTool>();
  let definitions = builtinDefinitions;
  let definitionsByName = new Map(definitions.map((t) => [t.name, t]));
  const listCache = new Map<string, { schema: unknown; json: Record<string, unknown> }>();
  let enabled = mode === 'all' ? new Set(definitions.map((t) => t.name)) : new Set(coreTools);
  const execute = async (
    tool: ToolDefinition,
    args: unknown,
    response: 'compact' | 'full',
    delivery: { fields?: string[]; media?: boolean } = {},
  ) => {
    if (app) return invokeTool(tool, args, call, { response, ...delivery });
    try {
      return await rpc(root, 'agentToolInvoke', {
        name: tool.name,
        arguments: args,
        response,
        inline: true,
        ...delivery,
      });
    } catch (e) {
      // Older open editors can still serve their existing capabilities through the bridge.
      if ((e as { code?: string }).code === 'METHOD_NOT_FOUND')
        return invokeTool(tool, args, call, { response, ...delivery });
      throw e;
    }
  };
  const register = (tool: ToolDefinition) => {
    const entry = server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Preserve unknown fields for invokeTool's shared strict validation and structured errors.
        inputSchema: z.object(tool.schema).passthrough(),
        annotations: toolAnnotations(tool.name, tool),
      },
      async (params) => {
        try {
          await refresh();
          const current = findTool(definitions, tool.name);
          if (current.plugin?.hash !== tool.plugin?.hash)
            throw new VmotionError(
              'PLUGIN_CHANGED',
              'Plugin changed; refresh tools/list or use tool_schema before calling again',
            );
          const result = await execute(tool, params, mode === 'all' ? 'full' : 'compact');
          await refresh();
          return result.result;
        } catch (e) {
          return toolError(e);
        }
      },
    );
    registered.set(tool.name, entry);
    if (!enabled.has(tool.name)) entry.disable();
  };
  let catalogHash: string | undefined, refreshing: Promise<void> | undefined;
  const refresh = () =>
    (refreshing ??= (async () => {
      let catalog: PluginCatalog;
      try {
        catalog = (await call('pluginCatalog', { ifHash: catalogHash })) as PluginCatalog;
      } catch (e) {
        if ((e as { code?: string }).code !== 'METHOD_NOT_FOUND') throw e;
        catalog = {
          catalogHash: '0'.repeat(64),
          plugins: [],
          ...(catalogHash === '0'.repeat(64) ? { notModified: true } : {}),
        };
      }
      if (catalog.notModified) return;
      const next = [...builtinDefinitions, ...projectPluginTools(catalog)],
        nextNames = new Set(next.map((t) => t.name)),
        nextByName = new Map(next.map((t) => [t.name, t]));
      const notify = server.sendToolListChanged;
      let changed = false;
      server.sendToolListChanged = () => {
        changed = true;
      };
      try {
        for (const tool of definitions) {
          const updated = nextByName.get(tool.name);
          if (!updated || updated.plugin?.hash !== tool.plugin?.hash) {
            registered.get(tool.name)?.remove();
            registered.delete(tool.name);
            listCache.delete(tool.name);
            if (!updated) enabled.delete(tool.name);
          }
        }
        definitions = next;
        definitionsByName = nextByName;
        catalogHash = catalog.catalogHash;
        if (mode === 'all') for (const name of nextNames) enabled.add(name);
        for (const tool of next) if (!registered.has(tool.name)) register(tool);
      } finally {
        server.sendToolListChanged = notify;
      }
      if (changed) server.sendToolListChanged();
    })().finally(() => {
      refreshing = undefined;
    }));
  for (const tool of definitions) register(tool);
  await refresh();
  const discoveryNames = ['tools_search', 'tool_schema', 'tool_call', 'tools_load'];
  registered.set(
    'tools_search',
    server.registerTool(
      'tools_search',
      {
        description:
          'Find capabilities by query/category/plugin with short summaries and read/write hints. detail=true includes argument names and full catalog metadata. Paginated Chinese/English search; no schemas/source. Then tool_schema/tool_call.',
        inputSchema: toolSearchSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (params) => {
        try {
          await refresh();
          const value = searchTools(definitions, params, enabled);
          return {
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        } catch (e) {
          return toolError(e);
        }
      },
    ),
  );
  registered.set(
    'tool_schema',
    server.registerTool(
      'tool_schema',
      {
        description:
          'Read one exact input schema with local refs and conditional ifHash. paths selects property branches; full invocation validation remains. detail=true adds description/plugin/call metadata, format=expanded inlines refs. Avoid loading the full catalog.',
        inputSchema: toolSchemaRequestSchema,
        annotations: { readOnlyHint: true, openWorldHint: false },
      },
      async (params) => {
        try {
          await refresh();
          const value = toolSchema(definitions, params.name, params);
          return {
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        } catch (e) {
          return toolError(e);
        }
      },
    ),
  );
  registered.set(
    'tool_call',
    server.registerTool(
      'tool_call',
      {
        description:
          'Invoke any capability through shared strict schemas/transactions. Default compact JSON/native media; response=full opts into complete results. fields selects result paths while retaining revision/validity metadata, media=false omits inline media. Unknown result paths are marked missing; edits use exact candidates/undo. This gateway can mutate projects.',
        inputSchema: toolCallSchema,
        annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
      },
      async (params) => {
        try {
          await refresh();
          const tool = findTool(definitions, params.name);
          const result = await execute(tool, params.arguments, params.response, {
            fields: params.fields,
            media: params.media,
          });
          await refresh();
          return result.result;
        } catch (e) {
          return toolError(e);
        }
      },
    ),
  );
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refresh();
    const tools = [...registered]
      .filter(([, entry]) => entry.enabled)
      .map(([name, entry]) => {
        let cached = listCache.get(name);
        if (!cached || cached.schema !== entry.inputSchema) {
          // SDK empty raw shapes normalize to Zod 4 Mini; keep the authoritative Zod 3 tool schema.
          const shape = definitionsByName.get(name)?.schema,
            input = shape
              ? z.object(shape).strict()
              : (entry.inputSchema as z.ZodTypeAny | undefined);
          cached = {
            schema: entry.inputSchema,
            json: input
              ? (zodToJsonSchema(input, {
                  $refStrategy: 'root',
                }) as Record<string, unknown>)
              : { type: 'object', properties: {}, additionalProperties: false },
          };
          listCache.set(name, cached);
        }
        return {
          name,
          description: mode==='all' ? entry.description : entry.description?.split(/\.\s/)[0].slice(0,200),
          inputSchema: cached.json as { type: 'object' },
          annotations: entry.annotations,
        };
      });
    return { tools };
  });
  registered.set(
    'tools_load',
    server.registerTool(
      'tools_load',
      {
        description:
          'Enable named/category direct tools in this MCP connection. mode=add preserves currently loaded tools; replace returns to essential tools before adding. All capabilities remain callable through tool_call. Does not edit the project or other agent connections. Sends tools/list_changed; clients without dynamic reload should use tool_call.',
        inputSchema: toolLoadSchema,
        annotations: {
          readOnlyHint: false,
          idempotentHint: true,
          destructiveHint: false,
          openWorldHint: false,
        },
      },
      async (params) => {
        try {
          await refresh();
          const selected = selectTools(definitions, params, enabled);
          let changed = false;
          for (const [name, entry] of registered) {
            if (discoveryNames.includes(name)) continue;
            if (selected.has(name) !== enabled.has(name)) {
              entry.enabled = selected.has(name);
              changed = true;
            }
          }
          enabled = selected;
          if (changed) server.sendToolListChanged();
          const names = [...enabled].sort(),
            value = {
              mode,
              enabled: names,
              permanent: discoveryNames,
              totalAvailable: definitions.length,
              categories: [
                ...new Set(
                  names.flatMap((name) => toolCategories(name, findTool(definitions, name))),
                ),
              ],
              projectChanged: false,
              next: 'Refresh tools/list for direct names, or call tool_call with a capability name.',
            };
          return {
            structuredContent: value,
            content: [{ type: 'text', text: JSON.stringify(value) }],
          };
        } catch (e) {
          return toolError(e);
        }
      },
    ),
  );
  server.resource('project-guide', 'vmotion://guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: 'The default connection lists 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any named capability; tools_load enables direct names for this connection. Start with project_context and agent_guide for workflow routing. Use matrix3d for geometry and scene3d_render for native color/depth/face-ID evidence. Inspect media_sample before sequence_plan; preflight its exact candidate and apply the unchanged payload with assetChecks. Read source ranges through project_file_read. Edits return compact revisions/IDs/diagnostics; response=full or mcp --tools all preserves legacy reads/results. The application contains no AI model integration.',
      },
    ],
  }));
  server.resource('animation-guide', 'vmotion://animation-guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        mimeType: 'application/json',
        text: JSON.stringify(animationReference, null, 2),
      },
    ],
  }));
  const transport = new StdioServerTransport();
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      pipe?.close();
      await app?.close();
    })());
  transport.onclose = () => {
    void close();
  };
  await server.connect(transport);
  process.stdin.on('end', () => {
    void server.close();
    void close();
  });
  return server;
}
