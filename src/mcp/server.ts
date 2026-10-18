import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ListToolsRequestSchema, type CallToolResult } from '@modelcontextprotocol/sdk/types.js';
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
  metaToolNames,
  metaToolDescriptions,
  metaToolSchemas,
  metaToolAnnotations,
  toolNotFound,
} from './discovery.js';
import { parseArguments } from './argument-errors.js';
import { invokeTool, toolError, toolCallSchema } from './invoke.js';
import { withChangeOrigin } from '../service/change-journal.js';
import { projectPluginTools, type PluginCatalog } from './plugin-tools.js';

export type McpToolMode = 'compact' | 'all' | 'auto';
/** SDK-side shape that accepts any value per key, so our own validator reports full fixes. */
const lenient = (shape: z.ZodRawShape) =>
  z.object(Object.fromEntries(Object.keys(shape).map((key) => [key, z.unknown()]))).passthrough();
const AUTO_LOAD_LIMIT = 32;
export async function startMcp(root: string, options: { tools?: McpToolMode } = {}) {
  const remote = await existingService(root),
    app = remote ? undefined : await new Application(root).open(),
    // Attribution for the Studio change feed: the MCP client name from the handshake.
    agent = { client: undefined as string | undefined, pid: process.pid, origins: false },
    pipe = app ? await servePipe(app) : undefined,
    call = (method: string, params?: unknown) =>
      app ? app.dispatch(method, params) : rpc(root, method, params),
    mode = options.tools ?? 'compact',
    server = new McpServer(
      { name: 'vmotion', version: '0.2.0' },
      {
        instructions:
          'Use project_context and agent_guide. Only the tools in tools/list can be called by direct name; call every other capability with tool_call {name,arguments} (or tools_load it first). tools_search lists capabilities with effect read|plan|write; tool_schema gives one exact interface (entry tools included). Planners return plan.planId: project_preflight({planId}) then project_apply({planId}). The application never calls AI models.',
      },
    ),
    builtinDefinitions = toolDefinitions(),
    registered = new Map<string, RegisteredTool>();
  let definitions = builtinDefinitions;
  let definitionsByName = new Map(definitions.map((t) => [t.name, t]));
  const listCache = new Map<string, { schema: unknown; json: Record<string, unknown> }>();
  let enabled = mode === 'all' ? new Set(definitions.map((t) => t.name)) : new Set(coreTools);
  const autoLoaded = new Set<string>();
  /** --tools auto: a capability used through tool_call/tool_schema becomes a direct tool. */
  const autoLoad = (name: string) => {
    if (mode !== 'auto' || enabled.has(name) || autoLoaded.size >= AUTO_LOAD_LIMIT) return;
    const entry = registered.get(name);
    if (!entry || !definitionsByName.has(name)) return;
    autoLoaded.add(name);
    enabled.add(name);
    entry.enable();
  };
  const routing = () => ({
    mode,
    directTools:
      mode === 'all'
        ? ('all' as const)
        : [...registered].filter(([, entry]) => entry.enabled).map(([name]) => name).sort(),
    hidden:
      mode === 'all'
        ? 'Every capability is a direct tool.'
        : 'Only directTools can be called by name; call any other capability with tool_call {"name":"<capability>","arguments":{...}} or tools_load it and refresh tools/list.',
    capabilities: definitions.length,
  });
  /** project_context/agent_guide tell the agent which names its client can call directly. */
  const withRouting = (tool: ToolDefinition, result: CallToolResult, fields?: string[]): CallToolResult => {
    if (fields || !['projectContext', 'agentGuide'].includes(tool.method)) return result;
    const value = result.structuredContent;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return result;
    const next: Record<string, unknown> = { ...(value as Record<string, unknown>), mcp: routing() };
    return {
      ...result,
      structuredContent: next,
      content: result.content.map((block, index) =>
        index === 0 && (block as { type?: string }).type === 'text'
          ? { type: 'text' as const, text: JSON.stringify(next) }
          : block,
      ),
    };
  };
  const execute = async (
    tool: ToolDefinition,
    args: unknown,
    response: 'compact' | 'full',
    delivery: { fields?: string[]; media?: boolean; via?: 'tool_call' | 'direct' } = {},
  ) => {
    if (app)
      return withChangeOrigin({ kind: 'mcp', client: agent.client, tool: tool.name }, () =>
        invokeTool(tool, args, call, { response, ...delivery, root }),
      );
    try {
      const { via: _via, ...bridged } = delivery;
      return await rpc(root, 'agentToolInvoke', {
        name: tool.name,
        arguments: args,
        response,
        inline: true,
        ...bridged,
        // Only editors that advertise origin support accept the extra field.
        ...(agent.origins ? { agent: { client: agent.client, pid: agent.pid } } : {}),
      });
    } catch (e) {
      // Older open editors can still serve their existing capabilities through the bridge.
      if ((e as { code?: string }).code === 'METHOD_NOT_FOUND')
        return invokeTool(tool, args, call, { response, ...delivery, root });
      throw e;
    }
  };
  const register = (tool: ToolDefinition) => {
    const entry = server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Accept any values here; invokeTool's strict validation reports allowed values/examples.
        inputSchema: lenient(tool.schema),
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
          const result = await execute(tool, params, mode === 'all' ? 'full' : 'compact', {
            via: 'direct',
          });
          await refresh();
          return withRouting(tool, result.result);
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
  const discoveryNames: string[] = [...metaToolNames];
  const reply = (value: unknown) => ({
    structuredContent: value as Record<string, unknown>,
    content: [{ type: 'text' as const, text: JSON.stringify(value) }],
  });
  const loadTools = (raw: unknown) => {
    const selected = selectTools(definitions, raw, enabled);
    let changed = false;
    for (const [name, entry] of registered) {
      if (discoveryNames.includes(name)) continue;
      if (selected.has(name) !== enabled.has(name)) {
        entry.enabled = selected.has(name);
        changed = true;
      }
    }
    enabled = selected;
    for (const name of [...autoLoaded]) if (!enabled.has(name)) autoLoaded.delete(name);
    if (changed) server.sendToolListChanged();
    const names = [...enabled].sort();
    return {
      mode,
      enabled: names,
      permanent: discoveryNames,
      totalAvailable: definitions.length,
      categories: [
        ...new Set(names.flatMap((name) => toolCategories(name, findTool(definitions, name)))),
      ],
      projectChanged: false,
      next: 'Refresh tools/list for direct names, or call tool_call with a capability name.',
    };
  };
  /** Meta handlers shared by the direct entry tools and tool_call {name:'tools_search'|...}. */
  const meta: Record<string, (raw: unknown) => unknown> = {
    tools_search: (raw) => searchTools(definitions, raw, enabled),
    tool_schema: (raw) => {
      const request = parseArguments('tool_schema', toolSchemaRequestSchema, raw);
      const value = toolSchema(definitions, request.name, request);
      if (!enabled.has(request.name) && definitionsByName.has(request.name)) {
        const before = enabled.size;
        autoLoad(request.name);
        if (enabled.size !== before) server.sendToolListChanged();
      }
      return value;
    },
    tools_load: (raw) => loadTools(raw),
  };
  const registerMeta = (
    name: (typeof metaToolNames)[number],
    handler: (params: Record<string, unknown>) => Promise<unknown>,
  ) =>
    registered.set(
      name,
      server.registerTool(
        name,
        {
          description: metaToolDescriptions[name],
          inputSchema: lenient(metaToolSchemas[name].shape),
          annotations: metaToolAnnotations[name],
        },
        async (params) => {
          try {
            await refresh();
            return (await handler(params)) as never;
          } catch (e) {
            return toolError(e);
          }
        },
      ),
    );
  registerMeta('tools_search', async (params) => reply(meta.tools_search(params)));
  registerMeta('tool_schema', async (params) => reply(meta.tool_schema(params)));
  registerMeta('tool_call', async (params) => {
    const request = parseArguments('tool_call', toolCallSchema, params);
    if (Object.hasOwn(meta, request.name)) return reply(meta[request.name](request.arguments));
    if (request.name === 'tool_call')
      throw new VmotionError('TOOL_ARGUMENTS', 'tool_call cannot invoke itself; pass the capability name');
    const tool = findTool(definitions, request.name);
    const result = await execute(tool, request.arguments, request.response, {
      fields: request.fields,
      media: request.media,
    });
    const before = enabled.size;
    autoLoad(tool.name);
    if (enabled.size !== before) server.sendToolListChanged();
    await refresh();
    return withRouting(tool, result.result, request.fields);
  });
  server.server.setRequestHandler(ListToolsRequestSchema, async () => {
    await refresh();
    const tools = [...registered]
      .filter(([, entry]) => entry.enabled)
      .map(([name, entry]) => {
        let cached = listCache.get(name);
        if (!cached || cached.schema !== entry.inputSchema) {
          // Registration shapes are lenient; list the authoritative strict Zod 3 schema.
          const shape =
              definitionsByName.get(name)?.schema ??
              (metaToolSchemas as Record<string, z.AnyZodObject>)[name]?.shape,
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
          description:
            mode === 'all'
              ? entry.description
              : entry.description?.split(/\.\s/)[0].slice(0, 200),
          inputSchema: cached.json as { type: 'object' },
          annotations: entry.annotations,
        };
      });
    return { tools };
  });
  registerMeta('tools_load', async (params) => reply(meta.tools_load(params)));
  // A capability that exists but is not loaded in this connection (or an unknown name) gets a
  // structured routing answer instead of the SDK's bare "Tool X disabled/not found".
  const handlers = (
    server.server as unknown as {
      _requestHandlers: Map<string, (request: unknown, extra: unknown) => Promise<unknown>>;
    }
  )._requestHandlers;
  const sdkCall = handlers.get('tools/call');
  if (sdkCall)
    handlers.set('tools/call', async (request, extra) => {
      const name = (request as { params?: { name?: unknown } }).params?.name;
      if (typeof name === 'string' && !registered.get(name)?.enabled) {
        await refresh();
        if (!registered.get(name)?.enabled)
          return toolError(
            definitionsByName.has(name)
              ? new VmotionError(
                  'TOOL_NOT_LOADED',
                  `${name} is a Vmotion capability but not a direct tool in this connection; call tool_call {"name":"${name}","arguments":{...}} or tools_load {"names":["${name}"]} and refresh tools/list`,
                  { name, directTools: routing().directTools },
                )
              : toolNotFound(definitions, name),
          );
      }
      return sdkCall(request, extra);
    });
  server.resource('project-guide', 'vmotion://guide', async (uri) => ({
    contents: [
      {
        uri: uri.href,
        text: 'The default connection lists 10 compact entry tools. Use tools_search for capabilities, tool_schema for one exact interface, and tool_call {name,arguments} for any named capability; tools_load enables direct names for this connection. Start with project_context and agent_guide for workflow routing. Use matrix3d for geometry and scene3d_render for native color/depth/face-ID evidence. Only tools in tools/list are callable by direct name; use tool_call for the rest. Planners and mode=plan writes return plan.planId (committed:false): project_preflight({planId}) then project_apply({planId}). Inspect media_sample before sequence_plan. Read source ranges through project_file_read. Edits return compact revisions/IDs/diagnostics; response=full or mcp --tools all preserves legacy reads/results. The application contains no AI model integration.',
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
  // Presence heartbeat so an open Studio can show "<client> 已连接 · MCP". Older editors
  // ignore ping params; failures are silent because presence is cosmetic.
  const announce = async () => {
    agent.client ??= server.server.getClientVersion()?.name;
    if (app) {
      app.noteAgent({ client: agent.client, pid: agent.pid });
      return;
    }
    try {
      const pong = await rpc(root, 'ping', { agent: { client: agent.client, pid: agent.pid } });
      agent.origins = pong?.origins === true;
    } catch {
      /* editor closed or older */
    }
  };
  if (app) app.service.defaultOrigin = { kind: 'mcp' };
  server.server.oninitialized = () => void announce();
  const heartbeat = setInterval(() => void announce(), 15_000);
  heartbeat.unref();
  await server.connect(transport);
  process.stdin.on('end', () => {
    clearInterval(heartbeat);
    void server.close();
    void close();
  });
  return server;
}
