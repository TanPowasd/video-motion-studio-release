import { field, present } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { PluginRegistry, pluginVersionMatches } from '../src/core/plugins.js';
import { projectPluginTools } from '../src/mcp/plugin-tools.js';
import { toolSchema, searchTools } from '../src/mcp/discovery.js';
import { hash } from '../src/service/project.js';
let root: string, app: Application;
const source = 'components/plugins/lab/plugin.json',
  entry = 'components/plugins/lab/tools.ts',
  component = 'components/plugins/lab/card.ts';
export const parameters = {
  sceneId: { type: 'string', default: 'intro' },
  nodeId: { type: 'string', default: 'title' },
  text: { type: 'string', default: '可编程插件' },
  x: { type: 'number', default: 24, min: 0, max: 300 },
};
export const manifest = {
  kind: 'vmotion-plugin',
  apiVersion: 1,
  id: 'example.lab',
  name: '外部创作包',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0' },
  entry,
  contributions: [{ id: 'card', name: '插件信息卡', kind: 'component', source: component }],
  tools: [
    {
      id: 'title',
      description: '创建独立可编辑标题',
      mode: 'plan',
      parameters,
      categories: ['composition'],
    },
    {
      id: 'count',
      description: '查询所选场景',
      mode: 'query',
      parameters: {},
      reads: { scenes: true },
      categories: ['composition'],
    },
  ],
};
export const code = `import {definePlugin,definePluginTool,node} from '@vmotion/sdk';export default definePlugin({name:'外部创作包',tools:{title:definePluginTool({parameters:${JSON.stringify(parameters)},run(ctx,p){return {operations:[{type:'addNode',sceneId:p.sceneId,node:node({id:p.nodeId,type:'text',text:p.text,x:p.x,y:40,width:270,height:80,fontSize:25})}],samples:[{sceneId:p.sceneId,frame:0}],summary:{nodeId:p.nodeId}}}}),count:definePluginTool({parameters:{},run(ctx){return {count:ctx.scenes.length,ids:ctx.scenes.map(s=>s.id)}}})}});`;
const card = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'信息卡',parameters:{},render(ctx){return [node({id:'fill',type:'rect',width:ctx.width,height:ctx.height,fill:'#5599aa'})]}});`;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-plugin-'));
  await initProject(root, 'Plugins', {
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
async function register(document: any = manifest, script = code) {
  const planned = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    files: [
      { type: 'replace', path: source, expectedHash: null, content: JSON.stringify(document) },
      { type: 'replace', path: entry, expectedHash: null, content: script },
      { type: 'replace', path: component, expectedHash: null, content: card },
    ],
    actions: [{ type: 'register', source }],
  });
  const check = await app.dispatch('projectPreflight', planned.candidate);
  expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true);
  await app.dispatch('projectApply', planned.apply);
  return planned;
}
it('checks semantic versions, disabled/missing dependencies, duplicate IDs and cycles atomically', async () => {
  const builtin = await app.dispatch('pluginsInspect', { id: 'vmotion.math' });
  expect(builtin.items[0]).toMatchObject({ id: 'vmotion.math', runtime: 'module' });
  expect(builtin.capabilities).toEqual(expect.arrayContaining(['linear_algebra', 'matrix3d']));
  const visualBuiltin = await app.dispatch('pluginsInspect', { id: 'vmotion.effects' });
  expect(visualBuiltin.items[0]).toMatchObject({
    id: 'vmotion.effects',
    runtime: 'module',
    moduleTools: 14,
  });
  expect(visualBuiltin.capabilities).toEqual(
    expect.arrayContaining(['effects_inspect', 'visual_templates']),
  );
  const mediaBuiltin = await app.dispatch('pluginsInspect', { id: 'vmotion.media' });
  expect(mediaBuiltin.items[0]).toMatchObject({
    id: 'vmotion.media',
    runtime: 'module',
    moduleTools: 12,
  });
  expect(mediaBuiltin.capabilities).toEqual(
    expect.arrayContaining(['media_status', 'media_sample']),
  );
  const audioBuiltin = await app.dispatch('pluginsInspect', { id: 'vmotion.audio' });
  expect(audioBuiltin.items[0]).toMatchObject({
    id: 'vmotion.audio',
    runtime: 'module',
    moduleTools: 15,
    hostTools: 0,
  });
  expect(audioBuiltin.capabilities).toEqual(
    expect.arrayContaining(['sound_plan', 'sound_preview', 'audio_audit']),
  );
  expect((await app.dispatch('pluginsInspect', { id: 'vmotion.editing' })).items[0]).toMatchObject({
    runtime: 'module',
    moduleTools: 7,
    hostTools: 0,
  });
  expect((await app.dispatch('pluginsInspect', { id: 'vmotion.render' })).items[0]).toMatchObject({
    runtime: 'module',
    moduleTools: 7,
    hostTools: 0,
  });
  expect((await app.dispatch('pluginsInspect', { id: 'vmotion.3d' })).items[0]).toMatchObject({
    runtime: 'module',
    moduleTools: 5,
    hostTools: 0,
  });
  expect((await app.dispatch('pluginsInspect', { id: 'vmotion.vector' })).items[0]).toMatchObject({
    runtime: 'module',
    moduleTools: 6,
    hostTools: 0,
  });
  expect(pluginVersionMatches('1.5.2', '^1.2.0')).toBe(true);
  expect(pluginVersionMatches('2.0.0', '^1.2.0')).toBe(false);
  expect(pluginVersionMatches('0.2.3', '^0.2.0')).toBe(true);
  expect(pluginVersionMatches('0.3.0', '^0.2.0')).toBe(false);
  expect(pluginVersionMatches('1.2.5', '>=1.0.0 <2.0.0')).toBe(true);
  await expect(
    app.dispatch('pluginsPlan', {
      revision: app.service.snapshot.revision,
      files: [
        {
          type: 'replace',
          path: source,
          expectedHash: null,
          content: JSON.stringify({
            ...manifest,
            entry: undefined,
            tools: [],
            contributions: [],
            dependencies: { absent: '*' },
          }),
        },
      ],
      actions: [{ type: 'register', source }],
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_DEPENDENCY' });
  expect(app.service.snapshot.files[source]).toBeUndefined();
  const registry = new PluginRegistry(),
    base = structuredClone(app.service.snapshot);
  base.files[source] = JSON.stringify({
    ...manifest,
    entry: undefined,
    tools: [],
    contributions: [],
    dependencies: { 'example.second': '*' },
  });
  base.files['components/second.json'] = JSON.stringify({
    ...manifest,
    id: 'example.second',
    entry: undefined,
    tools: [],
    contributions: [],
    dependencies: { 'example.lab': '*' },
  });
  base.project.plugins = [
    { source, enabled: true },
    { source: 'components/second.json', enabled: true },
  ];
  expect(() => registry.resolve(base)).toThrow(/cycle/);
  base.project.plugins[1].enabled = false;
  expect(() => registry.resolve(base)).toThrow(/absent/);
  base.project.plugins[0].enabled = false;
  expect(registry.resolve(base)).toHaveLength(2);
});
it('registers typed tools, prepares exact native candidates and preserves shared history/source', async () => {
  const registered = await register(),
    current = app.service.snapshot.revision,
    catalog = await app.dispatch('pluginCatalog'),
    tools = projectPluginTools(catalog);
  expect(tools).toHaveLength(2);
  expect(searchTools(tools, { pluginId: 'example.lab' }).total).toBe(2);
  const schema = toolSchema(tools, 'plugin.example.lab.title');
  expect(
    toolSchema(tools, 'plugin.example.lab.title', { paths: ['_context.sceneIds', 'text'] }),
  ).toMatchObject({ projection: { partial: true } });
  expect(schema.plugin?.id).toBe('example.lab');
  expect(
    toolSchema(tools, 'plugin.example.lab.title', { ifHash: schema.schemaHash }),
  ).toMatchObject({ notModified: true });
  const planned = field(
    await app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.title',
      arguments: { revision: current, text: '插件作者的标题' },
    }),
    'value',
  );
  expect(app.service.snapshot.revision).toBe(current);
  expect(JSON.stringify(planned).length).toBeLessThan(2500);
  const check = await app.dispatch('projectPreflight', {
    ...(field(planned, 'candidate') as Record<string, unknown>),
    inline: true,
  });
  expect(check.valid).toBe(true);
  expect(check.data).toBeTruthy();
  await app.dispatch('projectApply', field(planned, 'apply'));
  expect(app.service.snapshot.scenes[0].nodes[0].text).toBe('插件作者的标题');
  expect(app.service.snapshot.files[entry]).toBe(code);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(current);
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(registered.baseRevision);
});
it('uses explicit bounded read scopes and refuses unknown parameters/stale hashes without mutation', async () => {
  await register();
  const revision = app.service.snapshot.revision;
  const query = field(
    await app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.count',
      arguments: { _context: { sceneIds: ['intro'] } },
    }),
    'value',
  );
  expect(field(query, 'result')).toEqual({ count: 1, ids: ['intro'] });
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.title',
      arguments: { typo: true },
    }),
  ).rejects.toMatchObject({ code: 'TOOL_ARGUMENTS' });
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.count',
      arguments: { expectedPluginHash: '0'.repeat(64) },
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' });
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.title',
      arguments: { _context: { sceneIds: ['intro'] } },
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_CONTEXT' });
  expect(app.service.snapshot.revision).toBe(revision);
});
it('updates tool catalogs only on manifest changes and permits atomic dependency disable/remove without deleting code', async () => {
  await register();
  const before = await app.dispatch('pluginCatalog');
  expect(
    await app.dispatch('pluginCatalog', { ifHash: field(before, 'catalogHash') }),
  ).toMatchObject({
    notModified: true,
  });
  const plan = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [{ type: 'toggle', id: 'example.lab', enabled: false }],
  });
  await app.dispatch('projectApply', plan.apply);
  expect(field(await app.dispatch('pluginCatalog'), 'plugins')).toHaveLength(0);
  expect(app.service.snapshot.files[entry]).toBe(code);
  await app.dispatch('undo');
  expect(field(await app.dispatch('pluginCatalog'), 'catalogHash')).toBe(
    field(before, 'catalogHash'),
  );
  const removed = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [{ type: 'remove', id: 'example.lab' }],
  });
  await app.dispatch('projectApply', removed.apply);
  expect(app.service.snapshot.files[entry]).toBe(code);
});
it('indexes the full plugin package and invalidates tool hashes when entry code changes', async () => {
  await register();
  const first = await app.dispatch('pluginsPackage', { id: 'example.lab', limit: 20 });
  expect(first.totalFiles).toBe(3);
  expect(first.files.map((file: any) => file.path)).toEqual(
    expect.arrayContaining([source, entry, component]),
  );
  expect(first.files.every((file: any) => /^[a-f0-9]{64}$/.test(file.hash))).toBe(true);
  expect(first.packageDigest).toMatch(/^[a-f0-9]{64}$/);
  const catalog = await app.dispatch('pluginCatalog'),
    oldHash = present(field(catalog, 'plugins'))[0].hash;
  const changedPlan = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    files: [
      {
        type: 'replace',
        path: entry,
        expectedHash: hash(code),
        content: code.replace("name:'外部创作包'", "name:'新的实现'"),
      },
    ],
  });
  const changedCheck = await app.dispatch('projectPreflight', changedPlan.candidate);
  expect(changedCheck.valid, JSON.stringify(changedCheck.diagnostics)).toBe(true);
  await app.dispatch('projectApply', changedPlan.apply);
  const next = await app.dispatch('pluginCatalog');
  expect(present(field(next, 'plugins'))[0].hash).not.toBe(oldHash);
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.title',
      arguments: { expectedPluginHash: oldHash },
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' });
});
it('rejects query tools that attempt to return editable candidates', async () => {
  const badManifest = {
    ...manifest,
    id: 'example.query',
    entry,
    tools: [{ id: 'bad', description: 'bad query', mode: 'query', parameters: {} }],
  };
  const badCode = `import {definePlugin,definePluginTool} from '@vmotion/sdk';export default definePlugin({name:'bad',tools:{bad:definePluginTool({parameters:{},run(){return {operations:[]};}})}});`;
  await register(badManifest, badCode);
  await expect(
    app.dispatch('agentToolInvoke', { name: 'plugin.example.query.bad', arguments: {} }),
  ).rejects.toMatchObject({ code: 'PLUGIN_MODE' });
});
it('pins complete plugin contents, explicitly unpins for edits and preserves the pin through undo', async () => {
  await register();
  const pinned = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [{ type: 'toggle', id: 'example.lab', enabled: true, pin: true }],
  });
  await app.dispatch('projectApply', pinned.apply);
  const pinnedRevision = app.service.snapshot.revision,
    signature = app.service.snapshot.project.plugins![0].contentHash;
  expect(signature).toMatch(/^[a-f0-9]{64}$/);
  const change = {
    type: 'replace',
    path: entry,
    expectedHash: hash(code),
    content: code + '\n// editable update',
  };
  await expect(
    app.dispatch('pluginsPlan', { revision: pinnedRevision, files: [change] }),
  ).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' });
  const unpinned = await app.dispatch('pluginsPlan', {
    revision: pinnedRevision,
    files: [change],
    actions: [{ type: 'toggle', id: 'example.lab', enabled: true, pin: false }],
  });
  const checked = await app.dispatch('projectPreflight', unpinned.candidate);
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', unpinned.apply);
  expect(app.service.snapshot.project.plugins![0].contentHash).toBeUndefined();
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(pinnedRevision);
  expect(app.service.snapshot.project.plugins![0].contentHash).toBe(signature);
});
it('verifies declared package file hashes before enabling a plugin', async () => {
  const declared = {
    ...manifest,
    id: 'example.pinned',
    files: [{ path: entry, hash: hash(code) }],
  };
  await register(declared, code);
  await expect(
    app.dispatch('pluginsPlan', {
      revision: app.service.snapshot.revision,
      files: [
        {
          type: 'replace',
          path: entry,
          expectedHash: hash(code),
          content: code.replace("name:'外部创作包'", "name:'已篡改'"),
        },
      ],
    }),
  ).rejects.toMatchObject({ code: 'PLUGIN_CHANGED' });
});
it('rejects mismatched exported schemas, promises and nondeterministic candidates', async () => {
  // Change an actually exported constraint, keeping the manifest fixed.
  const wrong = code.replace('"default":"intro"', '"default":"other"');
  const bad = await app.dispatch('projectPreflight', {
    revision: app.service.snapshot.revision,
    files: [
      { type: 'replace', path: source, expectedHash: null, content: JSON.stringify(manifest) },
      { type: 'replace', path: entry, expectedHash: null, content: wrong },
      { type: 'replace', path: component, expectedHash: null, content: card },
    ],
    operations: [{ type: 'updateProject', patch: { plugins: [{ source, enabled: true }] } }],
  });
  expect(bad.valid).toBe(false);
  expect(bad.diagnostics.some((d: any) => d.code === 'PLUGIN_PARAMETERS')).toBe(true);
  await register(manifest, code.replace('nodeId:p.nodeId', 'nodeId:String(Math.random())'));
  await expect(
    app.dispatch('agentToolInvoke', { name: 'plugin.example.lab.title', arguments: {} }),
  ).rejects.toMatchObject({ code: 'PLUGIN_NONDETERMINISTIC' });
  expect(app.service.snapshot.scenes[0].nodes).toHaveLength(0);
  await app.service.transact([
    { type: 'writeSource', path: entry, content: code.replace('run(ctx,p){', 'async run(ctx,p){') },
  ]);
  await expect(
    app.dispatch('agentToolInvoke', { name: 'plugin.example.lab.title', arguments: {} }),
  ).rejects.toMatchObject({ code: 'PLUGIN_RUNTIME' });
});
it('places contributions and retains ordinary component rendering when the library is disabled', async () => {
  await register();
  const plan = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    placements: [
      {
        pluginId: 'example.lab',
        contributionId: 'card',
        sceneId: 'intro',
        nodeId: 'card',
        width: 120,
        height: 70,
        x: 30,
        y: 50,
      },
    ],
  });
  await app.dispatch('projectApply', plan.apply);
  const before = await app.frame({ sceneId: 'intro', frame: 0 });
  const off = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [{ type: 'toggle', id: 'example.lab', enabled: false }],
  });
  await app.dispatch('projectApply', off.apply);
  expect(hash((await app.frame({ sceneId: 'intro', frame: 0 })).buffer)).toBe(hash(before.buffer));
});
it('preserves plugin media checks in the stored candidate and blocks stale/missing evidence before commit', async () => {
  await register(
    manifest,
    code.replace(
      'samples:[{sceneId:p.sceneId,frame:0}]',
      "assetChecks:[{assetId:'missing',fingerprint:'old'}],samples:[{sceneId:p.sceneId,frame:0}]",
    ),
  );
  const revision = app.service.snapshot.revision,
    planned = field(
      await app.dispatch('agentToolInvoke', { name: 'plugin.example.lab.title', arguments: {} }),
      'value',
    );
  const check = await app.dispatch('projectPreflight', field(planned, 'candidate'));
  expect(check.valid).toBe(false);
  expect(check.diagnostics.some((d: any) => d.code === 'MISSING_ASSET')).toBe(true);
  expect(app.service.snapshot.revision).toBe(revision);
});
it('recovers after a timed-out plugin worker rather than reusing a dead cached module', async () => {
  await register(
    manifest,
    code.replace(
      'run(ctx){return {count:',
      'run(ctx){if(ctx.scenes.length){for(;;){}}return {count:',
    ),
  );
  const revision = app.service.snapshot.revision;
  await expect(
    app.dispatch('agentToolInvoke', {
      name: 'plugin.example.lab.count',
      arguments: { _context: { sceneIds: ['intro'] } },
    }),
  ).rejects.toMatchObject({ code: 'COMPONENT_TIMEOUT' });
  const compiles = app.renderer.components.stats.compiles,
    recovered = await Promise.all(
      [0, 1].map(() =>
        app.dispatch('agentToolInvoke', { name: 'plugin.example.lab.count', arguments: {} }),
      ),
    );
  expect(recovered.map((r) => field(field(field(r, 'value'), 'result'), 'count'))).toEqual([0, 0]);
  expect(app.renderer.components.stats.compiles - compiles).toBe(1);
  expect(app.service.snapshot.revision).toBe(revision);
});
