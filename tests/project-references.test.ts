import { it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { initProject } from '../src/service/template.js';
import { parseFiles, loadProject, serialize } from '../src/service/project.js';
import { newNode, sceneSchema, type Snapshot } from '../src/core/model.js';
import { ProjectReferences, referenceKey } from '../src/core/project-references.js';
import { queryProjectReferences } from '../src/service/project-references.js';
import { querySequence } from '../src/service/sequence-query.js';
let root: string, snapshot: Snapshot;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-references-'));
  await initProject(root, 'refs', { template: 'blank', width: 320, height: 180 });
  snapshot = await loadProject(root);
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});
function setup() {
  snapshot.project.assets = [
    {
      id: 'hero',
      name: 'Hero',
      type: 'image',
      path: 'assets/hero.png',
      managed: false,
      metadata: {},
    },
  ];
  snapshot.scenes[0].nodes = [
    newNode({ id: 'direct', type: 'image', assetId: 'hero' }),
    newNode({
      id: 'code',
      type: 'component',
      component: 'components/card.ts',
      overrides: { child: { assetId: 'hero' } },
      structure: {
        removed: [],
        parents: {},
        order: [],
        nested: {},
        added: [newNode({ id: 'added', type: 'image', assetId: 'hero' })],
      },
    }),
  ];
  snapshot.files['components/card.ts'] =
    "import{defineComponent,node}from'@vmotion/sdk';import data from './data';export default defineComponent({name:'Card',parameters:{},render(){return[node({id:'i',type:'image',assetId:'hero'})]}});";
  snapshot.files['components/data.json'] = '{"custom":"uninterpreted"}';
  snapshot.sequences[0].tracks[0].clips = [
    {
      id: 'use',
      assetId: 'hero',
      start: 0,
      duration: 60,
      sourceIn: 0,
      speed: 1,
      volume: 1,
      fadeIn: 0,
      fadeOut: 0,
    },
  ];
  snapshot = parseFiles(serialize(snapshot));
}
it('finds structured, generated override/added and clip sources without claiming dynamic TypeScript coverage', () => {
  setup();
  const cache = new ProjectReferences(),
    query = queryProjectReferences(cache, snapshot, {
      entity: { kind: 'asset', id: 'hero' },
      detail: true,
    });
  expect(query.total).toBe(5);
  expect(query.items).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ relation: 'node-media', stablePath: '/nodes/@direct/assetId' }),
      expect.objectContaining({ relation: 'clip-source', clipId: 'use' }),
    ]),
  );
  expect(query.coverage.runtimeComplete).toBe(false);
  const hints = queryProjectReferences(cache, snapshot, {
    entity: { kind: 'asset', id: 'hero' },
    includeHints: true,
  });
  expect(hints.total).toBe(6);
  expect(hints.items).toContainEqual(
    expect.objectContaining({ relation: 'code-literal', replaceable: false }),
  );
  const reachable = queryProjectReferences(cache, snapshot, {
    section: 'reachable',
    entity: { kind: 'project', id: snapshot.project.id },
    direction: 'outgoing',
    limit: 100,
  });
  expect(reachable.items).toContainEqual(
    expect.objectContaining({ kind: 'file', id: 'assets/hero.png' }),
  );
  expect(reachable.items).toContainEqual(
    expect.objectContaining({ kind: 'file', id: 'components/data.json' }),
  );
  const uncertain = queryProjectReferences(cache, snapshot, { section: 'uncertainties' });
  expect(uncertain.items).toContainEqual(expect.objectContaining({ file: 'components/card.ts' }));
  expect(uncertain.items).toContainEqual(expect.objectContaining({ file: 'components/data.json' }));
  snapshot.files['components/scalar.json'] = 'null';
  snapshot.files['components/array.json'] = '[1,2,3]';
  const shape = queryProjectReferences(cache, snapshot, { section: 'uncertainties' });
  expect(shape.items).toContainEqual(expect.objectContaining({ file: 'components/scalar.json' }));
  expect(shape.items).toContainEqual(expect.objectContaining({ file: 'components/array.json' }));
});
it('uses exact text probes, invalidates one changed scan, handles import resolution changes and preserves stable reference IDs after reordering', () => {
  setup();
  const cache = new ProjectReferences(),
    first = cache.resolve(snapshot),
    indexId = first.references.find((e) => e.to.kind === 'asset' && e.nodeId === 'direct')!.id,
    initial = cache.report();
  expect(cache.resolve(snapshot)).toBe(first);
  expect(cache.report().scans).toBe(initial.scans);
  expect(cache.report().indexHits).toBe(1);
  snapshot.files['components/card.ts'] += '\n// comment';
  cache.resolve(snapshot);
  expect(cache.report().scans).toBe(initial.scans + 1);
  snapshot.scenes[0].nodes.reverse();
  snapshot = parseFiles(serialize(snapshot));
  const reorder = cache.resolve(snapshot);
  expect(reorder.references.find((e) => e.nodeId === 'direct' && e.to.kind === 'asset')!.id).toBe(
    indexId,
  );
  delete snapshot.files['components/data.json'];
  snapshot.files['components/data.ts'] = 'export default 1;';
  const resolved = cache.resolve(snapshot);
  expect(resolved.references.find((e) => e.relation === 'module-import')!.to.id).toBe(
    'components/data.ts',
  );
  const baseline = new ProjectReferences(false).resolve(snapshot);
  expect(resolved.references.map((e) => e.id)).toEqual(baseline.references.map((e) => e.id));
  expect(cache.report().indexAccountedBytes).toBeLessThanOrEqual(24 * 1024 * 1024);
  expect(cache.report().files.accountedBytes).toBeLessThanOrEqual(8 * 1024 * 1024);
});
it('covers known effect/sound/storyboard/plugin/template/tracking resource roles, without rewriting pinned evidence', () => {
  setup();
  Object.assign(snapshot.files, {
    'components/effects/branch.json': JSON.stringify({
      kind: 'effect-graph',
      nodes: [{ id: 'child', type: 'subgraph', source: 'components/effects/child.json' }],
    }),
    'components/effects/child.json': JSON.stringify({ kind: 'effect-graph', nodes: [] }),
    'components/sounds/score.json': JSON.stringify({
      kind: 'sound',
      tracks: [{ id: 'voice', instrument: { type: 'sample', assetId: 'hero' } }],
    }),
    'components/storyboards/film.json': JSON.stringify({
      kind: 'storyboard',
      shots: [
        {
          id: 'one',
          source: { type: 'asset', id: 'hero' },
          narration: [{ id: 'voice', assetId: 'hero' }],
        },
      ],
    }),
    'components/tracking/motion.json': JSON.stringify({
      kind: 'tracking',
      source: { assetId: 'hero' },
    }),
    'components/templates/version.json': JSON.stringify({
      kind: 'scene-template',
      sceneId: 'intro',
      files: { 'components/card.ts': 'a'.repeat(64) },
      shared: [],
    }),
    'components/themes/child.json': JSON.stringify({
      kind: 'theme',
      parent: 'components/themes/base.json',
      tokens: [],
    }),
    'components/themes/base.json': JSON.stringify({ kind: 'theme', tokens: [] }),
    'components/plugins/example.json': JSON.stringify({
      kind: 'vmotion-plugin',
      entry: 'components/card.ts',
      files: [{ path: 'components/card.ts', hash: 'a'.repeat(64) }],
      contributions: [{ source: 'components/effects/branch.json' }],
    }),
  });
  const index = new ProjectReferences().resolve(snapshot);
  expect(
    index.references.filter((e) =>
      ['sound-sample', 'storyboard-source', 'narration'].includes(e.relation),
    ),
  ).toHaveLength(3);
  expect(index.references.find((e) => e.relation === 'tracking-source')!.replaceable).toBe(false);
  expect(index.references.find((e) => e.relation === 'template-pin')!.replaceable).toBe(false);
  expect(index.references.find((e) => e.relation === 'plugin-entry')!.replaceable).toBe(false);
  expect(index.references.find((e) => e.relation === 'theme-parent')!.to.id).toBe(
    'components/themes/base.json',
  );
  expect(
    index.outgoing
      .get(referenceKey({ kind: 'file', id: 'components/effects/branch.json' }))!
      .some((e) => e.to.id === 'components/effects/child.json'),
  ).toBe(true);
});
it('pages large declared use lists and timeline windows with explicit coverage and rejected stale filters', () => {
  snapshot.scenes[0].nodes = Array.from({ length: 180 }, (_, i) =>
    newNode({ id: 'node' + i, type: 'image', assetId: 'registered' }),
  );
  snapshot.project.assets = [
    {
      id: 'registered',
      name: 'Registered',
      type: 'image',
      path: 'assets/image.png',
      managed: false,
      metadata: {},
    },
  ];
  snapshot.sequences[0].tracks[0].clips = Array.from({ length: 100 }, (_, i) => ({
    id: 'clip' + i,
    sceneId: 'intro',
    start: i * 10,
    duration: 10,
    sourceIn: 2.5,
    speed: 0.5,
    volume: 1,
    fadeIn: 0,
    fadeOut: 0,
  }));
  snapshot = parseFiles(serialize(snapshot));
  const cache = new ProjectReferences();
  const page = queryProjectReferences(cache, snapshot, {
    entity: { kind: 'asset', id: 'registered' },
  });
  expect(page.items).toHaveLength(24);
  expect(page.nextOffset).toBe(24);
  expect(page.total).toBe(181);
  const timeline = querySequence(snapshot, { range: [15, 35] });
  expect(timeline.items.map((i) => i.id)).toEqual(['clip1', 'clip2', 'clip3']);
  expect(timeline.items[0].sourceLast).toBe(7);
  expect(timeline.items[0]).not.toHaveProperty('clip');
  const detailed = querySequence(snapshot, { clipIds: ['clip99'], detail: true });
  expect(detailed.items[0].clip!.sourceIn).toBe(2.5);
  expect(() => queryProjectReferences(cache, snapshot, { revision: 'stale' })).toThrow(
    /version changed/,
  );
  expect(() => queryProjectReferences(cache, snapshot, { section: 'reachable' })).toThrow(
    /requires/,
  );
  expect(() => querySequence(snapshot, { trackIds: ['missing'] })).toThrow();
  expect(() => querySequence(snapshot, { range: [40, 20] })).toThrow();
});
