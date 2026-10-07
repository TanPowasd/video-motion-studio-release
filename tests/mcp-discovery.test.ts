import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import {
  searchTools,
  toolSchema,
  toolCategories,
  selectTools,
  coreTools,
} from '../src/mcp/discovery.js';
import { loadProject } from '../src/service/project.js';
import { agentGuide } from '../src/service/agent-guide.js';
const definitions = toolDefinitions();
it('returns small exact property branches with distinct schema hashes and preserves full validation', () => {
  const full = toolSchema(definitions, 'template_plan'),
    paths = ['revision', 'publish.definition', 'publish.capture'],
    projected = toolSchema(definitions, 'template_plan', { paths });
  if ('notModified' in projected) throw new Error('Expected schema');
  expect(projected.projection?.partial).toBe(true);
  expect(JSON.stringify(projected).length).toBeLessThan(JSON.stringify(full).length * 0.1);
  expect(projected.schemaHash).not.toBe(full.schemaHash);
  expect(
    toolSchema(definitions, 'template_plan', {
      paths: [...paths].reverse(),
      ifHash: projected.schemaHash,
    }),
  ).toMatchObject({ notModified: true });
  expect(() => toolSchema(definitions, 'template_plan', { paths: ['publish.missing'] })).toThrow(
    'missing',
  );
});
it('deduplicates heavy schemas with valid local references and supports stable interface cache checks', () => {
  for (const tool of definitions) {
    const value = toolSchema(definitions, tool.name),
      schema = value.inputSchema as any;
    expect(schema).toBeDefined();
    const scan = (node: any) => {
      if (!node || typeof node !== 'object') return;
      if (typeof node.$ref === 'string') {
        expect(node.$ref.startsWith('#/')).toBe(true);
        let target: any = schema;
        for (const part of node.$ref.slice(2).split('/'))
          target = target?.[part.replace(/~1/g, '/').replace(/~0/g, '~')];
        expect(target, `${tool.name}: ${node.$ref}`).toBeDefined();
      }
      for (const child of Object.values(node)) scan(child);
    };
    scan(schema);
    expect(toolSchema(definitions, tool.name, { ifHash: value.schemaHash })).toEqual({
      name: tool.name,
      schemaHash: value.schemaHash,
      notModified: true,
    });
    const changed = { ...tool, description: tool.description + ' revised' };
    expect(toolSchema([changed], tool.name).schemaHash).not.toBe(value.schemaHash);
  }
  for (const name of ['sound_plan', 'effect_graph_plan']) {
    const compact = toolSchema(definitions, name),
      expanded = toolSchema(definitions, name, { format: 'expanded' });
    expect(compact.schemaHash).toBe(expanded.schemaHash);
    expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(expanded)) * 0.5,
    );
  }
});
it('routes all capabilities through categorized discovery without returning their entire schemas', () => {
  expect(definitions.length).toBeGreaterThan(0);
  expect(new Set(definitions.map((tool) => tool.name)).size).toBe(definitions.length);
  expect(agentGuide().discovery.availableCapabilities).toBe(definitions.length);
  for (const tool of definitions) {
    expect(toolCategories(tool.name).length, tool.name).toBeGreaterThan(0);
    expect(tool.categories?.length, tool.name).toBeGreaterThan(0);
    expect(typeof tool.keywords, tool.name).toBe('string');
    expect(tool.annotations, tool.name).toMatchObject({
      readOnlyHint: expect.any(Boolean),
      destructiveHint: expect.any(Boolean),
      idempotentHint: expect.any(Boolean),
      openWorldHint: expect.any(Boolean),
    });
  }
  const search = searchTools(definitions, { query: '深度', category: '3d' });
  expect(search.items.some((t) => t.name === 'scene3d_render')).toBe(true);
  expect(search.items[0].name).toBe('scene3d_render');
  expect(JSON.stringify(search)).not.toContain('inputSchema');
  const schema = toolSchema(definitions, 'scene3d_render');
  expect((schema.inputSchema as any).properties.source).toBeDefined();
  expect(schema.annotations.readOnlyHint).toBe(true);
  expect(toolSchema(definitions, 'sequence_edit').annotations.readOnlyHint).toBe(false);
  const first = searchTools(definitions, { limit: 10 }),
    second = searchTools(definitions, { offset: 10, limit: 10 });
  expect(new Set([...first.items, ...second.items].map((t) => t.name)).size).toBe(20);
  expect(first.total).toBe(definitions.length);
  expect(first.truncated).toBe(true);
});
it('resolves load selections before changing a connection, preserving core tools', () => {
  const current = new Set(coreTools),
    selected = selectTools(definitions, { categories: ['3d'] }, current);
  expect(selected.has('scene3d_render')).toBe(true);
  expect(current.has('scene3d_render')).toBe(false);
  expect(() => selectTools(definitions, { names: ['scene3d_render', 'typo'] }, current)).toThrow(
    'Unknown',
  );
  expect(selectTools(definitions, { mode: 'replace' }, selected)).toEqual(coreTools);
});
const parsed = (result: any) => JSON.parse(result.content.find((c: any) => c.type === 'text').text);
async function connect(root: string) {
  const client = new Client({ name: 'discovery-test', version: '1.0' }),
    transport = new StdioClientTransport({
      command: process.execPath,
      args: ['--import', 'tsx', 'src/cli/index.ts', 'mcp', '--project', root],
      cwd: path.resolve('.'),
      stderr: 'pipe',
    });
  await client.connect(transport);
  return { client, transport };
}
it('uses a compact catalog, loads tools per connection, and invokes hidden capabilities with native media', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-discovery-'));
  await initProject(root);
  const a = await connect(root),
    b = await connect(root);
  try {
    const initial = await a.client.listTools();
    expect(initial.tools).toHaveLength(10);
    expect(initial.tools.some((t) => t.name === 'matrix3d')).toBe(false);
    expect(initial.tools.some((t) => t.name === 'tool_call')).toBe(true);
    let notifications = 0;
    a.client.setNotificationHandler(ToolListChangedNotificationSchema, () => {
      notifications++;
    });
    const loaded = await a.client.callTool({
      name: 'tools_load',
      arguments: { categories: ['3d'] },
    });
    expect(loaded.isError).not.toBe(true);
    const expanded = await a.client.listTools();
    expect(expanded.tools.some((t) => t.name === 'matrix3d')).toBe(true);
    expect(notifications).toBe(1);
    await a.client.callTool({ name: 'tools_load', arguments: { categories: ['3d'] } });
    await a.client.listTools();
    expect(notifications).toBe(1);
    expect((await b.client.listTools()).tools).toHaveLength(10);
    const invalid = await a.client.callTool({
      name: 'tools_load',
      arguments: { names: ['animation_edit', 'made_up'] },
    });
    expect(invalid.isError).toBe(true);
    expect(parsed(invalid).code).toBe('TOOL_NOT_FOUND');
    expect((await a.client.listTools()).tools).toHaveLength(expanded.tools.length);
    const projected = await b.client.callTool({
      name: 'tool_call',
      arguments: {
        name: 'matrix3d',
        arguments: {
          request: {
            operation: 'project',
            camera: {
              position: { x: 0, y: 0, z: 5 },
              target: { x: 0, y: 0, z: 0 },
              width: 160,
              height: 90,
            },
            points: [{ x: 0, y: 0, z: 0 }],
          },
        },
      },
    });
    expect(projected.isError).not.toBe(true);
    expect((projected.structuredContent as any).result.points[0].x).toBe(80);
    const picture = await b.client.callTool({
      name: 'tool_call',
      arguments: { name: 'frame_sample', arguments: { frames: [0, 90], width: 160 } },
    });
    expect(picture.isError).not.toBe(true);
    expect((picture.structuredContent as any).samples).toHaveLength(2);
    expect((picture.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(true);
    expect(JSON.stringify(picture.structuredContent)).not.toContain('base64');
    await a.client.callTool({ name: 'tools_load', arguments: { mode: 'replace' } });
    expect((await a.client.listTools()).tools).toHaveLength(10);
    const context = await b.client.callTool({ name: 'project_context', arguments: {} });
    expect(parsed(context).revision).toBe((await loadProject(root)).revision);
    const remoteEdit = await b.client.callTool({
      name: 'tool_call',
      arguments: {
        name: 'project_transact',
        arguments: {
          revision: parsed(context).revision,
          operations: [
            {
              type: 'updateNode',
              sceneId: 'intro',
              nodeId: 'subtitle',
              patch: { text: 'Remote compact edit' },
            },
          ],
        },
      },
    });
    expect(remoteEdit.isError).not.toBe(true);
    expect(parsed(remoteEdit).snapshot).toBeUndefined();
    expect(parsed(remoteEdit).revision).not.toBe(parsed(context).revision);
    const badRemote = await b.client.callTool({
      name: 'tool_call',
      arguments: { name: 'sequence_edit', arguments: { actions: [{ type: 'not-a-real-edit' }] } },
    });
    expect(badRemote.isError).toBe(true);
    expect(parsed(badRemote).code).toBe('TOOL_ARGUMENTS');
    const undoRemote = await a.client.callTool({
      name: 'tool_call',
      arguments: { name: 'project_undo', arguments: {} },
    });
    expect(parsed(undoRemote).revision).toBe(parsed(context).revision);
  } finally {
    await b.client.close();
    await b.transport.close();
    await a.client.close();
    await a.transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
it('commits and undoes hidden mutations with concise state, keeps full reads available and rejects malformed arguments before mutation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-discovery-edit-'));
  await initProject(root);
  const { client, transport } = await connect(root);
  try {
    const before = (await loadProject(root)).revision,
      operations = [
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: 'title',
          patch: { text: 'Gateway edited' },
        },
      ],
      edited = await client.callTool({
        name: 'tool_call',
        arguments: { name: 'project_transact', arguments: { revision: before, operations } },
      });
    expect(edited.isError).not.toBe(true);
    expect(parsed(edited).snapshot).toBeUndefined();
    expect(parsed(edited).revision).not.toBe(before);
    expect(JSON.stringify(edited.structuredContent)).not.toContain('defineComponent');
    const whole = await client.callTool({
      name: 'tool_call',
      arguments: { name: 'project_inspect', arguments: {}, response: 'full' },
    });
    expect(parsed(whole).snapshot.scenes[0].nodes.find((n: any) => n.id === 'title').text).toBe(
      'Gateway edited',
    );
    expect(Buffer.byteLength(JSON.stringify(edited))).toBeLessThan(
      Buffer.byteLength(JSON.stringify(whole)) * 0.2,
    );
    const bad = await client.callTool({
      name: 'tool_call',
      arguments: {
        name: 'project_transact',
        arguments: { revision: parsed(edited).revision, operations, typo: true },
      },
    });
    expect(bad.isError).toBe(true);
    expect(parsed(bad).code).toBe('TOOL_ARGUMENTS');
    expect(parsed(bad).recovery).toContain('tool_schema');
    const badSemantic = await client.callTool({
      name: 'tool_call',
      arguments: {
        name: 'project_preflight',
        arguments: {
          operations: [
            { type: 'updateNode', sceneId: 'intro', nodeId: 'title', patch: { width: -1 } },
          ],
        },
      },
    });
    expect(badSemantic.isError).toBe(true);
    expect(parsed(badSemantic).code).toBe('TOOL_ARGUMENTS');
    expect(parsed(badSemantic).details[0].path).toBe('/operations/0/patch/width');
    expect((await loadProject(root)).revision).toBe(parsed(edited).revision);
    const stale = await client.callTool({
      name: 'tool_call',
      arguments: { name: 'project_transact', arguments: { revision: before, operations } },
    });
    expect(stale.isError).toBe(true);
    expect(parsed(stale).code).toBe('REVISION_CONFLICT');
    expect(parsed(stale).recovery).toContain('project_context');
    const undo = await client.callTool({
      name: 'tool_call',
      arguments: { name: 'project_undo', arguments: {} },
    });
    expect(undo.isError, JSON.stringify(undo.content)).not.toBe(true);
    expect(parsed(undo).revision).toBe(before);
    expect(parsed(undo).snapshot).toBeUndefined();
    expect((await loadProject(root)).revision).toBe(before);
    const restored = await client.callTool({
      name: 'tool_call',
      arguments: { name: 'project_redo', arguments: {}, response: 'full' },
    });
    expect(restored.isError, JSON.stringify(restored.content)).not.toBe(true);
    expect(parsed(restored).snapshot).toBeDefined();
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 60000);
