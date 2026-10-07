import path from 'node:path';
import ts from 'typescript';
import { GeometryCache } from './geometry-cache.js';
import { VmotionError, type Snapshot } from './model.js';
import { hash } from '../platform/project-files.js';

export type ReferenceKind = 'project' | 'scene' | 'sequence' | 'asset' | 'drawing' | 'file';
export type ReferenceEntity = { kind: ReferenceKind; id: string };
export type IndexedEntity = ReferenceEntity & {
  name?: string;
  file?: string;
  mediaType?: string;
  availability: 'tracked' | 'registered-unprobed' | 'missing-reference';
};
export type ProjectReference = {
  id: string;
  from: ReferenceEntity;
  to: ReferenceEntity;
  file: string;
  pointer: string[];
  stablePath: string;
  relation: string;
  evidence: 'declared' | 'literal';
  replaceable: boolean;
  sceneId?: string;
  nodeId?: string;
  sequenceId?: string;
  trackId?: string;
  clipId?: string;
  locked?: boolean;
  line?: number;
  column?: number;
};
export type ReferenceIndex = {
  entities: Map<string, IndexedEntity>;
  references: ProjectReference[];
  incoming: Map<string, ProjectReference[]>;
  outgoing: Map<string, ProjectReference[]>;
  uncertainties: Array<{ file: string; reason: string; line?: number; column?: number }>;
  signature: string;
};
export const referenceKey = (e: ReferenceEntity) => e.kind + ':' + e.id;
type Scan = {
  edges: Array<Omit<ProjectReference, 'id'>>;
  literals: Array<{ value: string; line: number; column: number }>;
  uncertainties: ReferenceIndex['uncertainties'];
};
const escape = (s: string) => s.replaceAll('~', '~0').replaceAll('/', '~1');
const declaredKinds = new Set([
  'sound',
  'effect-graph',
  'theme',
  'scene-template',
  'vmotion-plugin',
  'storyboard',
  'tracking',
  'mesh',
]);
export class ProjectReferences {
  private scans = new GeometryCache<{ text: string; role: string; data: Scan }>(
    8 * 1024 * 1024,
    128,
  );
  private previous?: { probes: Map<string, string>; index: ReferenceIndex };
  private indexBytes = 0;
  private stats = {
    scans: 0,
    scanHits: 0,
    indexBuilds: 0,
    indexHits: 0,
    parsedJson: 0,
    parsedTypeScript: 0,
  };
  constructor(readonly enabled = true) {}
  resolve(snapshot: Snapshot): ReferenceIndex {
    const entries = Object.entries(snapshot.files).sort(([a], [b]) => a.localeCompare(b, 'en'));
    if (
      this.enabled &&
      this.previous &&
      entries.length === this.previous.probes.size &&
      entries.every(([f, t]) => this.previous!.probes.get(f) === t)
    ) {
      this.stats.indexHits++;
      return this.previous.index;
    }
    const entities = new Map<string, IndexedEntity>();
    const addEntity = (e: IndexedEntity) => {
      const key = referenceKey(e),
        old = entities.get(key);
      if (!old || old.availability === 'missing-reference') entities.set(key, e);
    };
    const root: ReferenceEntity = { kind: 'project', id: snapshot.project.id };
    addEntity({
      ...root,
      name: snapshot.project.name,
      file: 'project.vmotion.json',
      availability: 'tracked',
    });
    for (const [file] of entries)
      addEntity({ kind: 'file', id: file, file, availability: 'tracked' });
    snapshot.scenes.forEach((s, i) =>
      addEntity({
        kind: 'scene',
        id: s.id,
        name: s.name,
        file: snapshot.project.scenes[i],
        availability: 'tracked',
      }),
    );
    snapshot.sequences.forEach((s, i) =>
      addEntity({
        kind: 'sequence',
        id: s.id,
        name: s.name,
        file: snapshot.project.sequences[i],
        availability: 'tracked',
      }),
    );
    snapshot.project.assets.forEach((a) => {
      addEntity({
        kind: 'asset',
        id: a.id,
        name: a.name,
        file: a.path,
        mediaType: a.type,
        availability: 'registered-unprobed',
      });
      addEntity({
        kind: 'file',
        id: a.path,
        file: a.path,
        availability: Object.hasOwn(snapshot.files, a.path) ? 'tracked' : 'registered-unprobed',
      });
    });
    snapshot.project.drawings.forEach((d) =>
      addEntity({ kind: 'drawing', id: d.id, name: d.name, file: d.path, availability: 'tracked' }),
    );
    const byValue = new Map<string, IndexedEntity[]>();
    for (const entity of entities.values()) {
      const list = byValue.get(entity.id) ?? [];
      list.push(entity);
      byValue.set(entity.id, list);
    }
    const edges: ProjectReference[] = [],
      uncertainties: ReferenceIndex['uncertainties'] = [];
    const append = (edge: Omit<ProjectReference, 'id'>) => {
      if (edges.length >= 100000)
        throw new VmotionError('REFERENCE_BUDGET', 'Reference index exceeds 100000 edges');
      addEntity({ ...edge.to, availability: 'missing-reference' });
      edges.push({
        ...edge,
        id: hash(
          JSON.stringify([
            edge.file,
            edge.stablePath,
            edge.relation,
            referenceKey(edge.to),
            edge.evidence,
          ]),
        ).slice(0, 32),
      });
    };
    const sceneByFile = new Map(snapshot.scenes.map((s, i) => [snapshot.project.scenes[i], s.id])),
      seqByFile = new Map(snapshot.sequences.map((s, i) => [snapshot.project.sequences[i], s.id])),
      fontSignature = snapshot.project.assets
        .filter((a) => a.type === 'font')
        .map((a) => [a.id, a.name]);
    for (const [file, text] of entries) {
      const old = this.enabled ? this.scans.get(file) : undefined;
      const role = JSON.stringify([
        sceneByFile.get(file),
        seqByFile.get(file),
        snapshot.project.drawings.some((d) => d.path === file),
        fontSignature,
      ]);
      let scan: Scan;
      if (old?.text === text && old.role === role) {
        scan = old.data;
        this.stats.scanHits++;
      } else {
        try {
          scan = this.scan(snapshot, file, text, sceneByFile.get(file), seqByFile.get(file));
        } catch (error) {
          scan = {
            edges: [],
            literals: [],
            uncertainties: [
              {
                file,
                reason:
                  'Static resource shape could not be interpreted: ' +
                  (error as Error).message.slice(0, 240),
              },
            ],
          };
        }
        this.stats.scans++;
        if (this.enabled)
          this.scans.put(
            file,
            { text, role, data: scan },
            text.length * 2 + JSON.stringify(scan).length * 2,
          );
      }
      scan.edges.forEach((edge) => {
        if (edge.relation === 'module-import') {
          const base = edge.to.id,
            options = [
              base,
              base + '.ts',
              base + '.tsx',
              base + '.json',
              base + '/index.ts',
              base + '/index.tsx',
            ],
            resolved = options.find((p) => Object.hasOwn(snapshot.files, p)) ?? base;
          append({ ...edge, to: { kind: 'file', id: resolved } });
        } else append(edge);
      });
      uncertainties.push(...scan.uncertainties);
      for (const literal of scan.literals) {
        const candidates = (byValue.get(literal.value) ?? []).filter((e) => e.kind !== 'project');
        for (const to of candidates)
          append({
            from: { kind: 'file', id: file },
            to: { kind: to.kind, id: to.id },
            file,
            pointer: [],
            stablePath: `line:${literal.line}:${literal.column}`,
            relation: 'code-literal',
            evidence: 'literal',
            replaceable: false,
            line: literal.line,
            column: literal.column,
          });
      }
    }
    const incoming = new Map<string, ProjectReference[]>(),
      outgoing = new Map<string, ProjectReference[]>();
    for (const edge of edges) {
      const a = referenceKey(edge.from),
        b = referenceKey(edge.to);
      if (!outgoing.has(a)) outgoing.set(a, []);
      outgoing.get(a)!.push(edge);
      if (!incoming.has(b)) incoming.set(b, []);
      incoming.get(b)!.push(edge);
    }
    const index = {
      entities,
      references: edges,
      incoming,
      outgoing,
      uncertainties,
      signature: hash(JSON.stringify(edges.map((e) => e.id))),
    };
    this.stats.indexBuilds++;
    const estimated =
      JSON.stringify(edges).length * 4 +
      JSON.stringify([...entities.values()]).length * 2 +
      entries.reduce((n, [f, t]) => n + (f.length + t.length) * 2, 0);
    if (this.enabled && estimated <= 24 * 1024 * 1024) {
      this.previous = { probes: new Map(entries), index };
      this.indexBytes = estimated;
    } else {
      this.previous = undefined;
      this.indexBytes = 0;
    }
    return index;
  }
  private scan(
    snapshot: Snapshot,
    file: string,
    text: string,
    sceneId?: string,
    sequenceId?: string,
  ): Scan {
    const data: Scan = { edges: [], literals: [], uncertainties: [] },
      from: ReferenceEntity = sceneId
        ? { kind: 'scene', id: sceneId }
        : sequenceId
          ? { kind: 'sequence', id: sequenceId }
          : { kind: 'file', id: file };
    if (Buffer.byteLength(text) > 8 * 1024 * 1024) {
      data.uncertainties.push({
        file,
        reason: 'Source exceeds 8MiB static indexing budget; inspect this source explicitly',
      });
      return data;
    }
    const edge = (
      kind: ReferenceKind,
      id: unknown,
      pointer: string[],
      relation: string,
      replaceable = true,
      meta: Partial<ProjectReference> = {},
    ) => {
      if (typeof id !== 'string' || !id) return;
      data.edges.push({
        from,
        to: { kind, id },
        file,
        pointer,
        stablePath: '/' + pointer.map(escape).join('/'),
        relation,
        evidence: 'declared',
        replaceable,
        ...meta,
      });
    };
    if (/\.tsx?$/.test(file)) {
      this.stats.parsedTypeScript++;
      const ast = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      );
      const imports = new Set<ts.Node>();
      const module = (node: ts.StringLiteralLike) => {
        imports.add(node);
        const value = node.text;
        if (!value.startsWith('.')) return;
        const base = path.posix.normalize(path.posix.join(path.posix.dirname(file), value)),
          resolved = base;
        const pos = ast.getLineAndCharacterOfPosition(node.getStart(ast));
        edge('file', resolved, [], 'module-import', false, {
          line: pos.line + 1,
          column: pos.character + 1,
          stablePath: `import:${pos.line + 1}:${pos.character + 1}`,
        });
      };
      const visit = (node: ts.Node) => {
        if (
          (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) &&
          node.moduleSpecifier &&
          ts.isStringLiteralLike(node.moduleSpecifier)
        )
          module(node.moduleSpecifier);
        if (ts.isStringLiteralLike(node) && !imports.has(node) && node.text.length <= 400) {
          const p = ast.getLineAndCharacterOfPosition(node.getStart(ast));
          data.literals.push({ value: node.text, line: p.line + 1, column: p.character + 1 });
        }
        ts.forEachChild(node, visit);
      };
      visit(ast);
      data.uncertainties.push({
        file,
        reason:
          'TypeScript can generate references dynamically; imports and exact literals are evidence, not complete runtime usage',
      });
      return data;
    }
    if (!file.endsWith('.json')) return data;
    if (snapshot.project.drawings.some((d) => d.path === file)) return data;
    this.stats.parsedJson++;
    let doc: any;
    try {
      doc = JSON.parse(text);
    } catch {
      data.uncertainties.push({
        file,
        reason: 'Invalid JSON source is preserved and cannot be indexed',
      });
      return data;
    }
    if (!doc || typeof doc !== 'object' || Array.isArray(doc)) {
      data.uncertainties.push({
        file,
        reason: 'Scalar/array JSON is data; no arbitrary reference semantics are assumed',
      });
      return data;
    }
    const fonts = snapshot.project.assets.filter((a) => a.type === 'font');
    const node = (n: any, p: string[], meta: Partial<ProjectReference>, depth = 0) => {
      if (!n || depth > 32) {
        if (depth > 32)
          data.uncertainties.push({ file, reason: 'Declared node reference nesting exceeds 32' });
        return;
      }
      const info = { ...meta, ...(typeof n.id === 'string' ? { nodeId: n.id } : {}) };
      edge('asset', n.assetId, [...p, 'assetId'], 'node-media', true, info);
      edge('asset', n.audioAssetId, [...p, 'audioAssetId'], 'node-audio', true, info);
      edge('scene', n.sceneId, [...p, 'sceneId'], 'node-scene', true, info);
      edge('file', n.component, [...p, 'component'], 'node-component', true, info);
      edge('file', n.programSource, [...p, 'programSource'], 'render-program', true, info);
      for (const font of fonts.filter(
        (a) =>
          a.type === 'font' &&
          (n.fontFamily === a.name || n.fontFamily === a.name.replace(/\.[^.]+$/, '')),
      ))
        edge('asset', font.id, [...p, 'fontFamily'], 'font-family', false, info);
      if (n.type === 'image' || n.type === 'video')
        edge('file', n.source, [...p, 'source'], 'node-media-source', false, info);
      for (const [i, id] of (n.sceneDependencies ?? []).entries())
        edge('scene', id, [...p, 'sceneDependencies', String(i)], 'scene-dependency', true, info);
      if (n.theme)
        edge('file', n.theme.source, [...p, 'theme', 'source'], 'theme-binding', true, info);
      if (n.templateInstance)
        edge(
          'file',
          n.templateInstance.source,
          [...p, 'templateInstance', 'source'],
          'template-instance',
          false,
          info,
        );
      for (const [i, fx] of (n.effects ?? []).entries())
        if (fx.type === 'program')
          edge(
            'file',
            fx.source,
            [...p, 'effects', String(i), 'source'],
            'render-program',
            true,
            info,
          );
        else if (fx.type === 'effectGraph') {
          edge(
            'file',
            fx.source,
            [...p, 'effects', String(i), 'source'],
            'effect-graph',
            true,
            info,
          );
          if (fx.graph) graph(fx.graph, [...p, 'effects', String(i), 'graph'], info);
        }
      for (const [i, instance] of (n.scene3d?.instances ?? []).entries())
        edge(
          'file',
          instance.meshSource,
          [...p, 'scene3d', 'instances', String(i), 'meshSource'],
          'mesh-resource',
          true,
          info,
        );
      for (const [id, patch] of Object.entries(n.overrides ?? {}))
        node(patch, [...p, 'overrides', id], info, depth + 1);
      for (const [i, added] of (n.structure?.added ?? []).entries())
        node(added, [...p, 'structure', 'added', String(i)], info, depth + 1);
      for (const [id, edit] of Object.entries(n.structure?.nested ?? {}))
        for (const [i, added] of ((edit as any).added ?? []).entries())
          node(added, [...p, 'structure', 'nested', id, 'added', String(i)], info, depth + 1);
    };
    const graph = (g: any, p: string[], meta: Partial<ProjectReference> = {}) => {
      for (const [i, n] of (g.nodes ?? []).entries())
        if (n.type === 'subgraph')
          edge('file', n.source, [...p, 'nodes', String(i), 'source'], 'subgraph', true, meta);
    };
    if (file === 'project.vmotion.json') {
      const root: ReferenceEntity = { kind: 'project', id: doc.id },
        push = (to: ReferenceEntity, p: string[], relation: string, replaceable = false) => {
          edge(to.kind, to.id, p, relation, replaceable);
          data.edges.at(-1)!.from = root;
        };
      push(
        { kind: 'sequence', id: doc.activeSequence },
        ['activeSequence'],
        'active-sequence',
        true,
      );
      for (const [i, f] of (doc.scenes ?? []).entries())
        push({ kind: 'file', id: f }, ['scenes', String(i)], 'scene-registration');
      snapshot.scenes.forEach((scene, i) =>
        push({ kind: 'scene', id: scene.id }, ['scenes', String(i)], 'scene-membership'),
      );
      for (const [i, f] of (doc.sequences ?? []).entries())
        push({ kind: 'file', id: f }, ['sequences', String(i)], 'sequence-registration');
      snapshot.sequences.forEach((sequence, i) =>
        push(
          { kind: 'sequence', id: sequence.id },
          ['sequences', String(i)],
          'sequence-membership',
        ),
      );
      for (const [i, a] of (doc.assets ?? []).entries()) {
        push({ kind: 'asset', id: a.id }, ['assets', String(i), 'id'], 'asset-registration');
        edge('file', a.path, ['assets', String(i), 'path'], 'asset-file', false);
        data.edges.at(-1)!.from = { kind: 'asset', id: a.id };
        if (a.soundSource) {
          edge('file', a.soundSource, ['assets', String(i), 'soundSource'], 'sound-source', false);
          data.edges.at(-1)!.from = { kind: 'asset', id: a.id };
        }
        if (a.type === 'drawing' && typeof a.metadata?.sourceDocumentId === 'string') {
          edge(
            'drawing',
            a.metadata.sourceDocumentId,
            ['assets', String(i), 'metadata', 'sourceDocumentId'],
            'drawing-origin',
            false,
          );
          data.edges.at(-1)!.from = { kind: 'asset', id: a.id };
        }
      }
      for (const [i, d] of (doc.drawings ?? []).entries()) {
        push({ kind: 'drawing', id: d.id }, ['drawings', String(i), 'id'], 'drawing-registration');
        edge('file', d.path, ['drawings', String(i), 'path'], 'drawing-file', false);
        data.edges.at(-1)!.from = { kind: 'drawing', id: d.id };
      }
      for (const [i, plugin] of (doc.plugins ?? []).entries())
        push(
          { kind: 'file', id: plugin.source },
          ['plugins', String(i), 'source'],
          'plugin-registration',
        );
    } else if (sceneId) {
      edge('file', file, [], 'scene-document', false, { sceneId });
      for (const [i, n] of (doc.nodes ?? []).entries()) node(n, ['nodes', String(i)], { sceneId });
    } else if (sequenceId) {
      edge('file', file, [], 'sequence-document', false, { sequenceId });
      for (const [i, t] of (doc.tracks ?? []).entries())
        for (const [j, c] of (t.clips ?? []).entries()) {
          const meta = { sequenceId, trackId: t.id, clipId: c.id, locked: !!t.locked };
          for (const [kind, field] of [
            ['asset', 'assetId'],
            ['scene', 'sceneId'],
            ['sequence', 'sequenceId'],
          ] as const)
            edge(
              kind,
              c[field],
              ['tracks', String(i), 'clips', String(j), field],
              'clip-source',
              true,
              meta,
            );
        }
    } else if (doc.kind === 'effect-graph') graph(doc, []);
    else if (doc.kind === 'sound') {
      for (const [i, t] of (doc.tracks ?? []).entries())
        if (t.instrument?.type === 'sample')
          edge(
            'asset',
            t.instrument.assetId,
            ['tracks', String(i), 'instrument', 'assetId'],
            'sound-sample',
          );
    } else if (doc.kind === 'storyboard') {
      for (const [i, shot] of (doc.shots ?? []).entries()) {
        edge(
          shot.source.type,
          shot.source.id,
          ['shots', String(i), 'source', 'id'],
          'storyboard-source',
        );
        for (const [j, n] of (shot.narration ?? []).entries())
          edge(
            'asset',
            n.assetId,
            ['shots', String(i), 'narration', String(j), 'assetId'],
            'narration',
          );
      }
    } else if (doc.kind === 'tracking')
      edge('asset', doc.source?.assetId, ['source', 'assetId'], 'tracking-source', false);
    else if (doc.kind === 'render-program') {
      edge('file', doc.entry, ['entry'], 'render-program-entry', false);
      for (const [i, file] of (doc.files ?? []).entries())
        edge('file', file, ['files', String(i)], 'render-program-dependency', false);
      for (const [i, id] of (doc.assets ?? []).entries())
        edge('asset', id, ['assets', String(i)], 'render-program-asset', false);
    } else if (doc.kind === 'theme') edge('file', doc.parent, ['parent'], 'theme-parent');
    else if (doc.kind === 'scene-template') {
      edge('scene', doc.sceneId, ['sceneId'], 'template-scene', false);
      for (const f of Object.keys(doc.files ?? {}))
        edge('file', f, ['files', f], 'template-pin', false);
      for (const [i, f] of (doc.shared ?? []).entries())
        edge('file', f, ['shared', String(i)], 'template-shared', false);
    } else if (doc.kind === 'vmotion-plugin') {
      edge('file', doc.entry, ['entry'], 'plugin-entry', false);
      for (const [i, c] of (doc.contributions ?? []).entries())
        edge(
          'file',
          c.source,
          ['contributions', String(i), 'source'],
          'plugin-contribution',
          false,
        );
      for (const [i, f] of (doc.files ?? []).entries())
        edge('file', f.path, ['files', String(i), 'path'], 'plugin-pin', false);
    } else if ((!doc.kind || !declaredKinds.has(doc.kind)) && doc.kind !== 'motion-template')
      data.uncertainties.push({
        file,
        reason: 'Unrecognized resource kind; custom reference semantics are not assumed',
      });
    for (const edge of data.edges) {
      if (edge.pointer.length) {
        let value = doc;
        const stable: string[] = [];
        for (const part of edge.pointer) {
          const child = value?.[part];
          stable.push(
            Array.isArray(value) && child && typeof child.id === 'string' ? '@' + child.id : part,
          );
          value = child;
        }
        edge.stablePath = '/' + stable.map(escape).join('/');
      }
    }
    return data;
  }
  report() {
    return {
      ...this.stats,
      files: this.scans.report(),
      indexCached: !!this.previous,
      indexAccountedBytes: this.indexBytes,
      indexRetainedBudgetBytes: 24 * 1024 * 1024,
      interpretation:
        'Text probes and cached static declarations; source/serialized JS byte estimates, not total RAM. No media decoding or component execution.',
    };
  }
  clear() {
    this.scans.clear();
    this.previous = undefined;
    this.indexBytes = 0;
  }
}
