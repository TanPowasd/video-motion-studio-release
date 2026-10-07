import { field, present } from './result-assertions.js';
import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { createGraphNode, graphPorts } from '../src/editor/studio/GraphEditor.js';
import { effectGraphSchema } from '../src/core/effect-graph-schema.js';
import { projectToolResult, invokeTool } from '../src/mcp/invoke.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { searchTools, toolSchema } from '../src/mcp/discovery.js';
let root: string, app: Application;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-studio-'));
  await initProject(root, 'Studio', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 2,
  });
  app = await new Application(root).open(false);
});
afterEach(async () => {
  await app.close();
  await rm(root, { recursive: true, force: true });
});
it('plans a retimed generated scene3d edit without saving source, verifies exact candidate and one undo', async () => {
  const source =
    "import{defineComponent,node,cubeMesh}from'@vmotion/sdk';export default defineComponent({name:'space',parameters:{},render(){return[node({id:'world',type:'scene3d',width:320,height:180,scene3d:{camera:{position:{x:0,y:0,z:6},target:{x:0,y:0,z:0},width:320,height:180},instances:[{id:'cube',mesh:{vertices:cubeMesh(2).vertices.map(v=>({...v})),faces:cubeMesh(2).faces.map(f=>[...f])}}],options:{},samples:4}})]}});";
  await app.service
    .transact([
      { type: 'writeSource', path: 'components/space.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'code',
          type: 'component',
          component: 'components/space.ts',
          width: 320,
          height: 180,
          timeMapping: {
            mode: 'remap',
            anchor: 0,
            offset: 0,
            rate: 1,
            repeat: 'continue',
            frame: 12,
          },
        },
      },
    ])
    .catch((e) => {
      throw new Error(JSON.stringify(e.details ?? e.message));
    });
  const revision = app.service.snapshot.revision,
    scope = await app.renderer.inspectComposition(
      app.service.snapshot,
      'intro',
      12,
      ['code'],
      [30],
    ),
    world = scope.scene.nodes.find((n) => n.id === 'code/world')!;
  const plan = await app.dispatch('compositionTransactBatch', {
    revision,
    mode: 'plan',
    sceneId: 'intro',
    frame: 30,
    edits: [
      {
        nodeId: world.id,
        path: ['code'],
        contextFrames: [30],
        frame: 12,
        patch: {
          scene3d: {
            ...world.scene3d!,
            camera: { ...world.scene3d!.camera, position: { x: 2, y: 1, z: 6 } },
          },
        },
      },
    ],
  });
  expect(app.service.snapshot.revision).toBe(revision);
  expect(field(plan, 'baseRevision')).toBe(revision);
  expect(present(field(plan, 'candidate')).planId).toHaveLength(64);
  const checked = await app.dispatch('projectPreflight', field(plan, 'candidate'));
  expect(checked.valid).toBe(true);
  await app.dispatch('projectApply', field(plan, 'apply'));
  expect(app.service.snapshot.revision).toBe(field(plan, 'candidateRevision'));
  expect(await readFile(path.join(root, 'components/space.ts'), 'utf8')).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(revision);
  await expect(
    app.dispatch('compositionTransactBatch', {
      mode: 'plan',
      revision: 'old',
      sceneId: 'intro',
      edits: [],
    }),
  ).rejects.toMatchObject({ code: 'REVISION_CONFLICT' });
});
it('uses valid node recipes and preserves explicit dependencies for channels and nested resources', () => {
  for (const type of [
    'input',
    'solid',
    'noise',
    'texture',
    'colorMatrix',
    'keyer',
    'channels',
    'blend',
    'mask',
    'transform',
    'displace',
    'blur',
    'glow',
  ]) {
    const node = createGraphNode(type, 'source', 'node'),
      graph = effectGraphSchema.parse({
        kind: 'effect-graph',
        version: 1,
        name: type,
        nodes: [{ id: 'source', type: 'input' }, node],
        output: 'node',
      });
    expect(graph.nodes[1].type).toBe(node.type);
  }
  expect(
    graphPorts({
      type: 'channels',
      red: { input: 'a', channel: 'red' },
      green: 1,
      blue: { input: 'a', channel: 'blue' },
      alpha: { input: 'b', channel: 'alpha' },
    }),
  ).toEqual([
    ['red', 'a'],
    ['blue', 'a'],
    ['alpha', 'b'],
  ]);
  expect(graphPorts({ type: 'subgraph', inputs: { source: 'image', map: 'map' } })).toEqual([
    ['inputs.source', 'image'],
    ['inputs.map', 'map'],
  ]);
});
it('projects own output paths with explicit missing data and retained revision without media duplication', async () => {
  const value = {
    revision: 'current',
    baseRevision: 'base',
    valid: true,
    summary: { mean: 3, large: Array(1000).fill(0) },
    samples: [{ frame: 0, hash: 'pixel' }],
  };
  const selected = projectToolResult(value, ['summary.mean', 'samples.0.hash', 'missing']);
  expect(selected).toMatchObject({
    revision: 'current',
    baseRevision: 'base',
    valid: true,
    summary: { mean: 3 },
    samples: { '0': { hash: 'pixel' } },
    resultProjection: { partial: true, missing: ['missing'] },
  });
  expect(value.summary.large).toHaveLength(1000);
  expect(projectToolResult(value, ['summary.mean', 'summary.large'])).toMatchObject({
    summary: { mean: 3, large: Array(1000).fill(0) },
    resultProjection: { missing: [] },
  });
  expect(
    projectToolResult({ value: { present: undefined, nested: { leaf: 2 } } }, [
      'value.present',
      'value.nested',
      'value.nested.leaf',
    ]),
  ).toMatchObject({
    value: { present: undefined, nested: { leaf: 2 } },
    resultProjection: { missing: [] },
  });
  expect(() => projectToolResult(value, ['__proto__.x'])).toThrow();
  const definitions = toolDefinitions(),
    tool = definitions.find((t) => t.name === 'project_inspect')!;
  const short = await invokeTool(tool, {}, (method, params) => app.dispatch(method, params), {
    fields: ['snapshot.project.name'],
    media: false,
    response: 'full',
  });
  expect((short.value as { snapshot: { project: { name: string } } }).snapshot.project.name).toBe(
    'Studio',
  );
  expect(JSON.stringify(short.value).length).toBeLessThan(500);
  const frame = await invokeTool(
    definitions.find((t) => t.name === 'frame_capture')!,
    { width: 160 },
    (method, params) => app.dispatch(method, params),
    { media: false },
  );
  expect(frame.result.content.every((c) => c.type === 'text')).toBe(true);
  expect((frame.value as { data?: unknown }).data).toBeUndefined();
  let invoked = false;
  await expect(
    invokeTool(
      tool,
      {},
      async () => {
        invoked = true;
        return {};
      },
      { fields: ['prototype.x'] },
    ),
  ).rejects.toThrow();
  expect(invoked).toBe(false);
});
it('keeps typed host RPC calls compatible with the dynamic dispatch boundary', async () => {
  const ping = await app.dispatchTyped('ping', {});
  expect(ping.aiIntegration).toBe(false);
  expect(ping.revision).toBe(app.service.snapshot.revision);
  const state = await app.dispatchTyped('state', {});
  expect(field(state, 'snapshot').revision).toBe(app.service.snapshot.revision);
});
it('preserves complete opt-ins while shortening discovery/schema delivery with equal validation hashes', () => {
  const definitions = toolDefinitions(),
    small = searchTools(definitions, { query: 'graph' }),
    detail = searchTools(definitions, { query: 'graph', detail: true });
  expect(small.items.map((i) => i.name)).toEqual(detail.items.map((i) => i.name));
  expect(JSON.stringify(small).length).toBeLessThan(JSON.stringify(detail).length * 0.8);
  const schema = toolSchema(definitions, 'composition_edit_layers'),
    full = toolSchema(definitions, 'composition_edit_layers', { detail: true });
  if ('notModified' in full) throw new Error('Expected full schema');
  expect(schema.inputSchema).toEqual(full.inputSchema);
  expect(schema.schemaHash).toBe(full.schemaHash);
  expect(schema.description).toBeUndefined();
  expect(full.description).toBeTruthy();
  expect((schema.inputSchema as any).properties.mode).toBeDefined();
});
