import { field, present } from './result-assertions.js';
import { beforeEach, afterEach, it, expect } from 'vitest';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { newNode } from '../src/core/model.js';
import { ThemeResolver, bindTheme } from '../src/core/theme.js';
import { evaluateNode } from '../src/core/time.js';
import { hash } from '../src/service/project.js';
let root: string, app: Application;
const baseTheme = {
    kind: 'theme',
    version: 1,
    id: 'brand',
    name: '品牌',
    tokens: [
      { id: 'brand.accent', type: 'color', value: '#55aabb' },
      { id: 'type.size', type: 'number', value: 24, min: 8, max: 80 },
      { id: 'title.color', type: 'color', alias: 'brand.accent' },
    ],
  },
  themeFile = 'components/themes/brand.json';
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-templates-'));
  await initProject(root, 'Templates', {
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
async function commit<M extends 'themePlan' | 'templatePlan'>(method: M, request: unknown) {
  const plan = await app.dispatch(method, {
    revision: app.service.snapshot.revision,
    ...(request as object),
  });
  const checked = await app.dispatch('projectPreflight', {
    ...field(plan, 'candidate'),
    inline: true,
  });
  expect(checked.valid, JSON.stringify(checked.diagnostics)).toBe(true);
  await app.dispatch('projectApply', field(plan, 'apply'));
  return plan;
}
it('resolves live inherited aliases and literal/explicit overrides before numeric keys without mutating cached values', () => {
  const resolver = new ThemeResolver(),
    files: { [key: string]: string } = {
      [themeFile]: JSON.stringify(baseTheme),
      'components/themes/child.json': JSON.stringify({
        ...baseTheme,
        id: 'child',
        parent: themeFile,
        tokens: [{ id: 'brand.accent', type: 'color', value: '#dd8855' }],
      }),
    },
    node = bindTheme(
      newNode({
        id: 'title',
        type: 'text',
        fill: '#333333',
        fontSize: 16,
        animations: [
          {
            property: 'fontSize',
            keys: [
              { frame: 0, value: 20 },
              { frame: 20, value: 40 },
            ],
          },
        ],
      }),
      {
        source: 'components/themes/child.json',
        links: { fill: 'title.color', fontSize: 'type.size' },
      },
    ),
    a = resolver.resolveNode({ files }, node);
  expect(a.fill).toBe('#dd8855');
  expect(a.fontSize).toBe(24);
  expect(evaluateNode(a, 10).fontSize).toBe(30);
  expect(node.fill).toBe('#333333');
  expect(resolver.resolveNode({ files }, { ...node, fill: '#ff00ff' }).fill).toBe('#ff00ff');
  expect(
    resolver.resolveNode(
      { files },
      { ...node, theme: { ...node.theme!, overrides: { fill: '#ffffff' } } },
    ).fill,
  ).toBe('#ffffff');
  files['components/themes/child.json'] = JSON.stringify({
    ...baseTheme,
    id: 'child',
    parent: themeFile,
    tokens: [{ id: 'brand.accent', type: 'color', value: '#11cc44' }],
  });
  expect(resolver.resolveNode({ files }, node).fill).toBe('#11cc44');
  expect(resolver.report().cache.entries).toBeLessThanOrEqual(128);
  expect(resolver.report().resolutions).toBe(2);
});
it('rejects cyclic/missing/type-invalid themes rather than replacing the active project', async () => {
  await expect(
    app.dispatch('themePlan', {
      revision: app.service.snapshot.revision,
      source: themeFile,
      expectedHash: null,
      document: {
        ...baseTheme,
        tokens: [
          { id: 'a', type: 'color', alias: 'b' },
          { id: 'b', type: 'color', alias: 'a' },
        ],
      },
    }),
  ).rejects.toMatchObject({ code: 'THEME_CYCLE' });
  await expect(
    app.dispatch('themePlan', {
      revision: app.service.snapshot.revision,
      source: themeFile,
      expectedHash: null,
      document: {
        ...baseTheme,
        tokens: [{ id: 'a', type: 'color', value: 'invalid native color' }],
      },
    }),
  ).rejects.toMatchObject({ code: 'THEME_COLOR' });
  expect(app.service.snapshot.files[themeFile]).toBeUndefined();
});
it('batches native/generated theme bindings with live updates, literal edits, local reset and one undo', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'brand',parameters:{},render(){return [node({id:'label',type:'text',text:'主题',fontSize:18,fill:'#ffffff',width:150,height:40})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/label.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'code', type: 'component', component: 'components/label.ts' },
    },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: { id: 'native', type: 'rect', x: 200, width: 80, height: 60, fill: '#ffffff' },
    },
  ]);
  const before = app.service.snapshot.revision,
    plan = await commit('themePlan', {
      source: themeFile,
      expectedHash: null,
      document: baseTheme,
      targets: [
        {
          sceneId: 'intro',
          path: ['code'],
          nodeId: 'code/label',
          links: { fill: 'title.color', fontSize: 'type.size' },
        },
        { sceneId: 'intro', nodeId: 'native', links: { fill: 'brand.accent' } },
      ],
    });
  expect(JSON.stringify(plan).length).toBeLessThan(2500);
  const graph = await app.renderer.inspectInteractions(app.service.snapshot, 'intro', 0, [], {
    includeEvaluated: true,
  });
  expect(graph.layers.find((n) => n.node.id === 'code/label')!.evaluatedNode!.fill).toBe('#55aabb');
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    nodeId: 'native',
    patch: { fill: '#ee4455' },
  });
  await commit('themePlan', {
    source: themeFile,
    expectedHash: hash(app.service.snapshot.files[themeFile]),
    changes: [{ type: 'set', token: { id: 'brand.accent', type: 'color', value: '#33dd77' } }],
  });
  expect(
    app.renderer.themes.resolveNode(
      app.service.snapshot,
      app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'native')!,
    ).fill,
  ).toBe('#ee4455');
  await commit('themePlan', {
    targets: [{ sceneId: 'intro', nodeId: 'native', action: 'clearLocal' }],
  });
  expect(
    app.renderer.themes.resolveNode(
      app.service.snapshot,
      app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'native')!,
    ).fill,
  ).toBe('#33dd77');
  expect(await readFile(path.join(root, 'components/label.ts'), 'utf8')).toBe(source);
  await app.dispatch('undo');
  expect(app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'native')!.fill).toBe('#ee4455');
  expect(before).not.toBe(app.service.snapshot.revision);
});
const definition = {
  id: 'card',
  name: '信息卡',
  version: 1,
  width: 320,
  height: 180,
  duration: 60,
  parameters: {
    title: { type: 'string', default: '模板标题' },
    size: { type: 'number', default: 22, min: 10, max: 80 },
  },
  ports: [
    { parameter: 'title', nodeId: 'label', property: 'text' },
    { parameter: 'size', nodeId: 'label', property: 'fontSize' },
  ],
};
const nodes = [
  newNode({ id: 'panel', type: 'rect', width: 310, height: 160, fill: '#223344' }),
  newNode({
    id: 'label',
    type: 'text',
    text: '模板标题',
    x: 14,
    y: 24,
    width: 280,
    height: 90,
    fontSize: 22,
    fill: '#ffffff',
  }),
];
it('rejects overlapping parameter ports before publishing a candidate', async () => {
  const before = app.service.snapshot.revision;
  await expect(
    app.dispatch('templatePlan', {
      revision: before,
      publish: {
        definition: {
          ...definition,
          ports: [
            ...definition.ports,
            { parameter: 'title', nodeId: 'label', property: 'fontSize' },
          ],
        },
        nodes,
      },
    }),
  ).rejects.toMatchObject({ code: 'TEMPLATE_PORT' });
  expect(app.service.snapshot.revision).toBe(before);
});
it('publishes typed instances, keeps customization and internal overrides during selective version upgrades', async () => {
  const a = await commit('templatePlan', {
    publish: { definition, nodes },
    placements: [
      { sceneId: 'intro', nodeId: 'a' },
      { sceneId: 'intro', nodeId: 'b', x: 20, params: { title: '自己的标题' } },
    ],
  });
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'b',
    keys: [
      { path: 'size', frame: 0, value: 24 },
      { path: 'size', frame: 30, value: 32 },
    ],
  });
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['b'],
    nodeId: 'b/label',
    patch: { fill: '#ffaa22' },
  });
  const old = app.service.snapshot.revision,
    b = await commit('templatePlan', {
      publish: {
        definition: {
          ...definition,
          version: 2,
          parameters: {
            ...definition.parameters,
            title: { type: 'string', default: '新版标题' },
            size: { type: 'number', default: 28, min: 10, max: 80 },
          },
        },
        nodes: [nodes[0], newNode({ ...nodes[1], text: '新版标题', fontSize: 28 })],
      },
      upgrades: [
        { sceneId: 'intro', nodeId: 'a' },
        { sceneId: 'intro', nodeId: 'b' },
      ],
    });
  expect(
    present(
      present(present(field(b, 'changes')).find((v: any) => v.nodeId === 'b')).keptParameters,
    ),
  ).toContain('title');
  const rootNodes = app.service.snapshot.scenes[0].nodes;
  expect(rootNodes.find((n) => n.id === 'a')!.params.title).toBe('新版标题');
  expect(rootNodes.find((n) => n.id === 'b')!.params.title).toBe('自己的标题');
  expect(rootNodes.find((n) => n.id === 'b')!.animations[0].keys).toHaveLength(2);
  expect(rootNodes.find((n) => n.id === 'b')!.overrides.label.fill).toBe('#ffaa22');
  const scope = await app.renderer.inspectComposition(
    app.service.snapshot,
    'intro',
    15,
    ['b'],
    [15],
  );
  expect(scope.scene.nodes.find((n) => n.id === 'b/label')!.text).toBe('自己的标题');
  await app.dispatch('undo');
  expect(app.service.snapshot.revision).toBe(old);
  expect(rootNodes.find((n) => n.id === 'a')!.templateInstance?.source).not.toBe(
    field(a, 'published'),
  );
});
// Multiple real compiler/preflight passes take ~33s on the reference machine.
it('pins captured TypeScript and rejects published file changes; detachment creates an editable private copy', async () => {
  const source =
    "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'v',parameters:{},render(){return [node({id:'label',type:'text',text:'版本一',width:200,height:40,fontSize:22})]}});";
  await app.service.transact([
    { type: 'writeSource', path: 'components/source.ts', content: source },
    {
      type: 'addNode',
      sceneId: 'intro',
      node: {
        id: 'origin',
        type: 'component',
        component: 'components/source.ts',
        width: 320,
        height: 180,
      },
    },
  ]);
  const p = await commit('templatePlan', {
    publish: {
      definition: { ...definition, parameters: {}, ports: [] },
      capture: { sceneId: 'intro', nodeIds: ['origin'] },
    },
    placements: [{ sceneId: 'intro', nodeId: 'instance' }],
  });
  await app.service.transact([
    {
      type: 'writeSource',
      path: 'components/source.ts',
      content: source.replace('版本一', '源已修改'),
    },
  ]);
  const frozen = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, [
    'instance',
    'instance/origin',
  ]);
  expect(frozen.scene.nodes[0].text).toBe('版本一');
  const manifest = JSON.parse(app.service.snapshot.files[present(field(p, 'published'))]),
    file = Object.keys(manifest.files).find((f) => f.endsWith('source.ts'))!;
  await expect(
    app.service.transact([
      { type: 'writeSource', path: file, content: source.replace('版本一', '越过版本') },
    ]),
  ).rejects.toMatchObject({ code: 'VALIDATION_FAILED' });
  const d = await commit('templatePlan', { detach: [{ sceneId: 'intro', nodeId: 'instance' }] }),
    local = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'instance')!,
    localManifest = JSON.parse(app.service.snapshot.files[local.templateInstance!.source]),
    localCode = Object.keys(localManifest.files).find((f) => f.endsWith('source.ts'))!;
  await app.service.transact([
    { type: 'writeSource', path: localCode, content: source.replace('版本一', '本地副本') },
  ]);
  const scope = await app.renderer.inspectComposition(app.service.snapshot, 'intro', 0, [
    'instance',
    'instance/origin',
  ]);
  expect(scope.scene.nodes[0].text).toBe('本地副本');
  expect(field(d, 'changes')[0].action).toBe('detach');
}, 60000);

it('migrates nested parameter keys, theme links and renamed layer overrides without losing motion', async () => {
  await commit('themePlan', { source: themeFile, expectedHash: null, document: baseTheme });
  const one = {
    ...definition,
    parameters: {
      layout: {
        type: 'object',
        properties: { gap: { type: 'number', default: 22, min: 10, max: 80 } },
      },
    },
    ports: [{ parameter: 'layout.gap', nodeId: 'label', property: 'fontSize' }],
  };
  await commit('templatePlan', {
    publish: { definition: one, nodes },
    placements: [{ sceneId: 'intro', nodeId: 'linked' }],
  });
  await commit('themePlan', {
    source: themeFile,
    targets: [{ sceneId: 'intro', nodeId: 'linked', links: { 'params.layout.gap': 'type.size' } }],
  });
  await app.dispatch('componentParametersEdit', {
    sceneId: 'intro',
    nodeId: 'linked',
    keys: [
      { path: 'layout.gap', frame: 0, value: 24 },
      { path: 'layout.gap', frame: 30, value: 32 },
    ],
  });
  await app.dispatch('compositionTransact', {
    sceneId: 'intro',
    path: ['linked'],
    nodeId: 'linked/label',
    patch: { fill: '#dd9944' },
  });
  const two = {
    ...definition,
    version: 2,
    parameters: {
      dimensions: {
        type: 'object',
        properties: { size: { type: 'number', default: 28, min: 10, max: 80 } },
      },
    },
    ports: [{ parameter: 'dimensions.size', nodeId: 'headline', property: 'fontSize' }],
  };
  await commit('templatePlan', {
    publish: {
      definition: two,
      nodes: [nodes[0], newNode({ ...nodes[1], id: 'headline' })],
      migrations: {
        parameters: { 'layout.gap': 'dimensions.size' },
        layers: { label: 'headline' },
      },
    },
    upgrades: [{ sceneId: 'intro', nodeId: 'linked' }],
  });
  const rootNode = app.service.snapshot.scenes[0].nodes.find((n) => n.id === 'linked')!;
  expect(rootNode.animations[0].property).toBe('params.dimensions.size');
  expect(rootNode.theme?.links['params.dimensions.size']).toBe('type.size');
  expect(rootNode.overrides.headline.fill).toBe('#dd9944');
  const inspected = await app.dispatch('componentParameters', {
    sceneId: 'intro',
    nodeId: 'linked',
    frame: 15,
  });
  expect(field(inspected.evaluated.dimensions, 'size')).toBe(28);
});
it('reports removed customized parameters and duplicate version publication before changing active files', async () => {
  const p = await commit('templatePlan', {
      publish: { definition, nodes },
      placements: [{ sceneId: 'intro', nodeId: 'custom', params: { title: '自己的标题' } }],
    }),
    before = app.service.snapshot.revision;
  await expect(
    app.dispatch('templatePlan', { revision: before, publish: { definition, nodes } }),
  ).rejects.toMatchObject({ code: 'TEMPLATE_VERSION_EXISTS' });
  await expect(
    app.dispatch('templatePlan', {
      revision: before,
      publish: { definition: { ...definition, version: 2, parameters: {}, ports: [] }, nodes },
      upgrades: [{ sceneId: 'intro', nodeId: 'custom' }],
    }),
  ).rejects.toMatchObject({ code: 'TEMPLATE_CONFLICT' });
  expect(app.service.snapshot.revision).toBe(before);
  expect(app.service.snapshot.files['components/templates/card/v2/manifest.json']).toBeUndefined();
});
