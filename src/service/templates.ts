import { z } from 'zod';
import ts from 'typescript';
import { randomUUID } from 'node:crypto';
import {
  templateDefinitionSchema,
  templateDocumentSchema,
  templatePortSchema,
  type TemplateDocument,
} from '../core/template-schema.js';
import { templateFileSchema } from '../core/template-instance-schema.js';
import {
  nodeSchema,
  newNode,
  VmotionError,
  type Node,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import {
  resolveParameters,
  validateParameterDefinitions,
  type ParameterDefinitions,
} from '../core/parameters.js';
import { themeEqual, themePathValue, themeSetPath } from '../core/theme.js';
import { hash, json } from './project.js';
import { applyOperations } from './operations.js';
import { compositionStructure } from './structure.js';
import { mergeMotionParameters } from '../core/motion-template.js';
import { storeAgentPlan } from './agent-plans.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
const scope = {
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().finite().nonnegative().default(0),
  },
  target = { ...scope, nodeId: z.string() },
  key = z.string().min(1).max(200);
export const templateInspectSchema = z
  .object({
    source: templateFileSchema.optional(),
    target: z.object(target).strict().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(16),
    detail: z.boolean().default(false),
  })
  .strict();
export const templatePlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    publish: z
      .object({
        definition: templateDefinitionSchema,
        capture: z
          .object({ ...scope, nodeIds: z.array(key).max(4000).default([]) })
          .strict()
          .optional(),
        nodes: z.array(nodeSchema).min(1).max(4000).optional(),
        allowSharedCode: z.boolean().default(false),
        migrations: templateDocumentSchema.shape.migrations.optional(),
      })
      .strict()
      .optional(),
    placements: z
      .array(
        z
          .object({
            ...scope,
            source: templateFileSchema.optional(),
            nodeId: key.optional(),
            name: z.string().optional(),
            x: z.number().finite().default(0),
            y: z.number().finite().default(0),
            width: z.number().finite().positive().optional(),
            height: z.number().finite().positive().optional(),
            params: z.record(z.unknown()).default({}),
          })
          .strict(),
      )
      .max(32)
      .default([]),
    upgrades: z
      .array(
        z
          .object({
            ...target,
            source: templateFileSchema.optional(),
            parameterPolicy: z.enum(['preserve', 'defaults']).default('preserve'),
            removeChannels: z.array(z.string()).max(1000).default([]),
            removeOverrides: z.array(z.string()).max(1000).default([]),
            values: z.record(z.unknown()).default({}),
          })
          .strict(),
      )
      .max(100)
      .default([]),
    detach: z.array(z.object(target).strict()).max(32).default([]),
  })
  .strict();
function rewritePaths(value: unknown, map: Map<string, string>, keepTheme = false): any {
  if (typeof value === 'string') return !keepTheme && map.has(value) ? map.get(value) : value;
  if (Array.isArray(value)) return value.map((v) => rewritePaths(v, map, keepTheme));
  if (value && typeof value === 'object')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [
        k,
        rewritePaths(
          v,
          map,
          k === 'theme' ||
            (k === 'parent' && typeof v === 'string' && v.startsWith('components/themes/')),
        ),
      ]),
    );
  return value;
}
async function captureCode(
  renderer: Renderer,
  snapshot: Snapshot,
  nodes: Node[],
  prefix: string,
  allowShared: boolean,
) {
  const pending = new Set<string>(),
    walk = (value: unknown) => {
      if (
        typeof value === 'string' &&
        value.startsWith('components/') &&
        !value.startsWith('components/templates/') &&
        snapshot.files[value] !== undefined
      )
        pending.add(value);
      else if (value && typeof value === 'object') for (const v of Object.values(value)) walk(v);
    };
  nodes.forEach(walk);
  const visited = new Set<string>();
  for (const file of pending) {
    if (visited.has(file)) continue;
    visited.add(file);
    if (file.endsWith('.ts') || file.endsWith('.tsx'))
      for (const dep of await renderer.components.sourceDependencies(snapshot, file))
        pending.add(dep);
    else if (file.endsWith('.json')) walk(JSON.parse(snapshot.files[file]));
    if (pending.size > 512)
      throw new VmotionError('TEMPLATE_BUNDLE', 'Template capture exceeds 512 author dependencies');
  }
  const files = [...pending].filter((f) => !f.startsWith('components/templates/'));
  if (files.length > 512)
    throw new VmotionError('TEMPLATE_BUNDLE', 'Template capture exceeds 512 author files');
  const map = new Map(files.map((f) => [f, `${prefix}/code/${f}`])),
    output = new Map<string, string>(),
    shared = new Set<string>();
  let bytes = 0;
  for (const file of files) {
    const text = snapshot.files[file];
    bytes += Buffer.byteLength(text);
    if (bytes > 8 * 1024 * 1024)
      throw new VmotionError('TEMPLATE_BUNDLE', 'Template author source exceeds 8MiB');
    if (file.endsWith('.json')) {
      output.set(map.get(file)!, json(rewritePaths(JSON.parse(text), map)));
      continue;
    }
    const source = ts.createSourceFile(
        file,
        text,
        ts.ScriptTarget.Latest,
        true,
        file.endsWith('.tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
      ),
      changes: Array<{ start: number; end: number; text: string }> = [];
    const visit = (n: ts.Node) => {
      if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
        const value = n.text,
          parent = n.parent,
          name = ts.isPropertyAssignment(parent)
            ? parent.name.getText(source).replace(/^['"]|['"]$/g, '')
            : '';
        if (
          map.has(value) &&
          !value.startsWith('components/themes/') &&
          ['component', 'source', 'meshSource'].includes(name)
        )
          changes.push({
            start: n.getStart(source),
            end: n.end,
            text: JSON.stringify(map.get(value)),
          });
        else if (value.startsWith('components/') && !value.startsWith('components/themes/'))
          shared.add(value);
      }
      if (ts.isTemplateExpression(n) && n.head.text.startsWith('components/'))
        shared.add(n.getText(source));
      n.forEachChild(visit);
    };
    visit(source);
    let code = text;
    for (const c of changes.sort((a, b) => b.start - a.start))
      code = code.slice(0, c.start) + c.text + code.slice(c.end);
    output.set(map.get(file)!, code);
  }
  if (shared.size && !allowShared)
    throw new VmotionError(
      'TEMPLATE_SHARED_CODE',
      'Some project-relative code references cannot be pinned automatically; use explicit allowSharedCode or rewrite author references',
      { references: [...shared].slice(0, 24) },
    );
  return { map, output, shared: [...shared] };
}
function migratePath(path: string, map: Record<string, string>) {
  const match = Object.keys(map)
    .sort((a, b) => b.length - a.length)
    .find((k) => path === k || path.startsWith(k + '.') || path.startsWith(k + '/'));
  return match ? map[match] + path.slice(match.length) : path;
}
function migrateExpression(
  text: string,
  parameters: Record<string, string>,
  layers: Record<string, string>,
  owner: string,
) {
  const prefix = 'const value=',
    source = ts.createSourceFile('expression.ts', prefix + text, ts.ScriptTarget.Latest, true),
    changes: Array<{ start: number; end: number; text: string }> = [];
  const chain = (n: ts.Node): { root: ts.Node; parts: string[] } | undefined => {
    if (ts.isIdentifier(n) || ts.isCallExpression(n)) return { root: n, parts: [] };
    if (ts.isPropertyAccessExpression(n)) {
      const p = chain(n.expression);
      return p ? { root: p.root, parts: [...p.parts, n.name.text] } : undefined;
    }
    if (
      ts.isElementAccessExpression(n) &&
      (ts.isStringLiteral(n.argumentExpression) || ts.isNumericLiteral(n.argumentExpression))
    ) {
      const p = chain(n.expression);
      return p ? { root: p.root, parts: [...p.parts, n.argumentExpression.text] } : undefined;
    }
  };
  const visit = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) || ts.isElementAccessExpression(n)) {
      const c = chain(n),
        isOwn =
          c &&
          ((ts.isIdentifier(c.root) && ['self', 'base'].includes(c.root.text)) ||
            (ts.isCallExpression(c.root) &&
              ts.isIdentifier(c.root.expression) &&
              c.root.expression.text === 'layer' &&
              c.root.arguments[0] &&
              ts.isStringLiteral(c.root.arguments[0]) &&
              c.root.arguments[0].text === owner));
      if (c && isOwn && c.parts[0] === 'params') {
        const old = c.parts.slice(1).join('.'),
          next = migratePath(old, parameters);
        if (next !== old) {
          changes.push({
            start: n.getStart(source) - prefix.length,
            end: n.end - prefix.length,
            text:
              c.root.getText(source) +
              '.params' +
              next
                .split('.')
                .map((p) => (/^\d+$/.test(p) ? `[${p}]` : '.' + p))
                .join(''),
          });
          return;
        }
      }
    }
    if (
      ts.isCallExpression(n) &&
      ts.isIdentifier(n.expression) &&
      n.expression.text === 'layer' &&
      n.arguments[0] &&
      ts.isStringLiteral(n.arguments[0])
    ) {
      const arg = n.arguments[0],
        id = arg.text,
        next = id.startsWith(owner + '/')
          ? owner + '/' + migratePath(id.slice(owner.length + 1), layers)
          : migratePath(id, layers);
      if (next !== id)
        changes.push({
          start: arg.getStart(source) - prefix.length,
          end: arg.end - prefix.length,
          text: JSON.stringify(next),
        });
    }
    n.forEachChild(visit);
  };
  source.forEachChild(visit);
  let output = text;
  for (const c of changes.sort((a, b) => b.start - a.start))
    output = output.slice(0, c.start) + c.text + output.slice(c.end);
  return output;
}
function migrateLayerPatch<T extends Node | Partial<Node>>(
  input: T,
  layers: Record<string, string>,
  owner: string,
): T {
  const node = structuredClone(input);
  if (node.parentId) node.parentId = migratePath(node.parentId, layers);
  if (node.maskId) node.maskId = migratePath(node.maskId, layers);
  if (node.layout && typeof node.layout.reference === 'object')
    node.layout.reference.nodeId = migratePath(node.layout.reference.nodeId, layers);
  if (node.motionPath?.nodeId) node.motionPath.nodeId = migratePath(node.motionPath.nodeId, layers);
  if (node.expressions)
    node.expressions = Object.fromEntries(
      Object.entries(node.expressions).map(([p, s]) => [
        p,
        migrateExpression(s, {}, layers, owner),
      ]),
    );
  return node;
}
function mergeDefaults(
  old: unknown,
  current: unknown,
  next: unknown,
  path: string,
  kept: string[],
): unknown {
  if (themeEqual(old, current)) return structuredClone(next);
  if (
    old &&
    current &&
    next &&
    typeof old === 'object' &&
    typeof current === 'object' &&
    typeof next === 'object' &&
    !Array.isArray(old) &&
    !Array.isArray(current) &&
    !Array.isArray(next)
  ) {
    const result: Record<string, unknown> = {};
    for (const key of new Set([...Object.keys(current), ...Object.keys(next)])) {
      if (!Object.hasOwn(next, key)) {
        if (!themeEqual((old as any)[key], (current as any)[key]))
          throw new VmotionError(
            'TEMPLATE_CONFLICT',
            'Customized parameter was removed; provide a parameter migration or explicit value',
            { path: path ? path + '.' + key : key },
          );
      } else
        result[key] = mergeDefaults(
          (old as any)[key],
          (current as any)[key],
          (next as any)[key],
          path ? path + '.' + key : key,
          kept,
        );
    }
    return result;
  }
  kept.push(path);
  return structuredClone(current);
}
function migrateValues(source: Record<string, unknown>, mapping: Record<string, string>) {
  const result = structuredClone(source),
    read = (path: string) => themePathValue(source, path),
    write = (path: string, value: unknown) => {
      let at: any = result;
      const parts = path.split('.');
      for (const p of parts.slice(0, -1)) {
        if (!Object.hasOwn(at, p)) at[p] = {};
        at = at[p];
      }
      at[parts.at(-1)!] = structuredClone(value);
    },
    remove = (path: string) => {
      const parts = path.split('.');
      const parents: any[] = [result];
      for (const p of parts.slice(0, -1)) parents.push(parents.at(-1)![p]);
      delete parents.at(-1)![parts.at(-1)!];
      for (let i = parts.length - 2; i >= 0; i--)
        if (parents[i + 1] && !Array.isArray(parents[i + 1]) && !Object.keys(parents[i + 1]).length)
          delete parents[i][parts[i]];
    };
  const keys = Object.keys(mapping).sort((a, b) => b.length - a.length);
  if (keys.some((k, i) => keys.slice(i + 1).some((p) => k.startsWith(p + '.'))))
    throw new VmotionError(
      'TEMPLATE_MIGRATION',
      'Parameter migrations must not overlap parent/child paths',
    );
  const entries = keys.map((from) => ({ from, to: mapping[from], value: read(from) }));
  for (const e of entries) remove(e.from);
  for (const e of entries) {
    let existing = true;
    try {
      themePathValue(result, e.to);
    } catch {
      existing = false;
    }
    if (existing)
      throw new VmotionError(
        'TEMPLATE_MIGRATION',
        'Parameter migration collides with an existing value',
        { path: e.to },
      );
    write(e.to, e.value);
  }
  return result;
}
export async function inspectTemplates(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = templateInspectSchema.parse(raw),
    sources = Object.entries(snapshot.files)
      .filter(([f, s]) => f.startsWith('components/templates/') && f.endsWith('.json'))
      .flatMap(([file, text]) => {
        try {
          const d = JSON.parse(text);
          return d.kind === 'scene-template'
            ? [
                {
                  file,
                  id: d.id,
                  name: d.name,
                  version: d.version,
                  hash: hash(text),
                  sceneId: d.sceneId,
                },
              ]
            : [];
        } catch {
          return [];
        }
      });
  let node: Node | undefined;
  if (p.target) {
    const t = p.target,
      scope = await renderer.inspectComposition(
        snapshot,
        t.sceneId,
        t.frame,
        t.path,
        t.contextFrames,
      );
    node = scope.scene.nodes.find((n) => n.id === t.nodeId);
    if (!node?.templateInstance)
      throw new VmotionError('TEMPLATE_TYPE', 'Target is not a template instance');
  }
  const source = p.source ?? node?.templateInstance?.source;
  if (!source)
    return {
      revision: snapshot.revision,
      templates: {
        total: sources.length,
        offset: p.offset,
        items: sources.slice(p.offset, p.offset + p.limit),
        nextOffset: p.offset + p.limit < sources.length ? p.offset + p.limit : null,
      },
    };
  const resolved = renderer.templates.resolve(snapshot, source),
    d = resolved.document;
  return {
    revision: snapshot.revision,
    source,
    template: {
      id: d.id,
      name: d.name,
      version: d.version,
      hash: resolved.hash,
      width: d.width,
      height: d.height,
      duration: d.duration,
      sceneId: d.sceneId,
      parameters: d.parameters,
      ports: d.ports,
      capturedFiles: Object.keys(d.files).length,
      shared: d.shared,
      ...(p.detail ? { files: d.files } : {}),
      migrations: d.migrations,
    },
    ...(node
      ? {
          instance: {
            nodeId: node.id,
            mode: node.templateInstance!.mode,
            params: node.params,
            channels: node.animations.map((a) => ({ property: a.property, keys: a.keys.length })),
            overrides: Object.keys(node.overrides),
            structure: !!node.structure,
            theme: node.theme?.source,
          },
        }
      : {}),
    cache: renderer.templates.report(),
  };
}
export async function planTemplates(
  root: string,
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
  edit: (
    s: Snapshot,
    scene: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>,
) {
  const p = templatePlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before template planning');
  let candidate = structuredClone(snapshot),
    published: string | undefined;
  const operations: Operation[] = [],
    reports = [],
    samples: Array<{ sceneId: string; path: string[]; contextFrames: number[]; frame: number }> =
      [];
  const apply = (ops: Operation[]) => {
    operations.push(...ops);
    candidate = applyOperations(root, candidate, ops);
  };
  if (p.publish) {
    const pub = p.publish,
      d = pub.definition;
    validateParameterDefinitions(d.parameters as ParameterDefinitions);
    if (!!pub.capture === !!pub.nodes)
      throw new VmotionError('TEMPLATE_CAPTURE', 'Choose exactly one capture or explicit nodes');
    const prefix = `components/templates/${d.id}/v${d.version}`,
      file = prefix + '/manifest.json';
    if (snapshot.files[file] !== undefined)
      throw new VmotionError(
        'TEMPLATE_VERSION_EXISTS',
        'Publish a new version; existing versions are immutable',
        { file },
      );
    let nodes: Node[], camera: Snapshot['scenes'][number]['camera'];
    if (pub.capture) {
      const c = pub.capture,
        scope = await renderer.inspectComposition(
          candidate,
          c.sceneId,
          c.frame,
          c.path,
          c.contextFrames,
        );
      const selected = new Set(
        c.nodeIds.length
          ? c.nodeIds
          : scope.scene.nodes.filter((n) => !n.parentId).map((n) => n.id),
      );
      if ([...selected].some((id) => !scope.scene.nodes.some((n) => n.id === id)))
        throw new VmotionError('TEMPLATE_CAPTURE', 'Capture layer is missing');
      const parents = new Set(
        scope.scene.nodes.filter((n) => selected.has(n.id)).map((n) => n.parentId),
      );
      if (parents.size > 1)
        throw new VmotionError('TEMPLATE_CAPTURE', 'Select sibling roots in one composition');
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of scope.scene.nodes)
          if (n.parentId && selected.has(n.parentId) && !selected.has(n.id)) {
            selected.add(n.id);
            changed = true;
          }
      }
      const strip = (id: string) =>
        scope.componentPrefix && id.startsWith(scope.componentPrefix + '/')
          ? id.slice(scope.componentPrefix.length + 1)
          : id;
      nodes = scope.scene.nodes
        .filter((n) => selected.has(n.id))
        .map((n) =>
          nodeSchema.parse({
            ...n,
            id: strip(n.id),
            parentId: n.parentId && selected.has(n.parentId) ? strip(n.parentId) : undefined,
            maskId: n.maskId && selected.has(n.maskId) ? strip(n.maskId) : undefined,
          }),
        );
      camera = scope.scene.camera;
    } else nodes = pub.nodes!;
    const code = await captureCode(renderer, snapshot, nodes, prefix, pub.allowSharedCode),
      copied = nodes.map((n) => rewritePaths(n, code.map) as Node),
      sceneId = `template-${d.id}-v${d.version}`,
      scene = {
        id: sceneId,
        name: `${d.name} · v${d.version}`,
        duration: d.duration,
        width: d.width,
        height: d.height,
        background: 'transparent',
        nodes: copied,
        camera,
      },
      sceneFile = `scenes/${sceneId}.json`;
    const sourceOps: Operation[] = [...code.output].map(([path, content]) => ({
      type: 'writeSource',
      path,
      content,
    }));
    apply([...sourceOps, { type: 'addScene', scene }]);
    const files = Object.fromEntries(
        [...code.output.keys(), sceneFile].map((file) => [file, hash(candidate.files[file])]),
      ),
      shared = [
        ...new Set([
          ...code.shared,
          ...copied.flatMap((n) => (n.sceneId ? [`scene:${n.sceneId}`] : [])),
        ]),
      ],
      manifest = templateDocumentSchema.parse({
        ...d,
        kind: 'scene-template',
        formatVersion: 1,
        sceneId,
        fps: snapshot.project.fps,
        files,
        shared,
        migrations: pub.migrations,
      });
    apply([{ type: 'writeSource', path: file, content: json(manifest) }]);
    published = file;
    reports.push({
      action: 'publish',
      source: file,
      id: d.id,
      version: d.version,
      capturedLayers: nodes.length,
      capturedFiles: code.output.size,
      shared,
    });
    const test = newNode({
      id: 'template-check',
      type: 'scene',
      sceneId,
      params: resolveParameters(d.parameters as ParameterDefinitions, {}),
      templateInstance: { source: file, hash: hash(candidate.files[file]) },
    });
    renderer.templates.apply(candidate, test, copied);
  }
  for (const place of p.placements) {
    const source = place.source ?? published;
    if (!source) throw new VmotionError('TEMPLATE_SOURCE', 'Placement needs a template source');
    const entry = renderer.templates.resolve(candidate, source),
      d = entry.document,
      params = resolveParameters(d.parameters as ParameterDefinitions, place.params),
      node = newNode({
        id: place.nodeId ?? randomUUID(),
        type: 'scene',
        name: place.name ?? d.name,
        sceneId: d.sceneId,
        x: place.x,
        y: place.y,
        width: place.width ?? d.width,
        height: place.height ?? d.height,
        params,
        templateInstance: { source, hash: entry.hash },
      }),
      added = await compositionStructure(
        renderer,
        candidate,
        place.sceneId,
        place.frame,
        place.path,
        { type: 'add', node },
        place.contextFrames,
      );
    apply(added.operations);
    reports.push({
      action: 'place',
      sceneId: place.sceneId,
      path: place.path,
      nodeId: node.id,
      source,
    });
    samples.push({
      sceneId: place.sceneId,
      path: place.path,
      contextFrames: place.contextFrames,
      frame: place.frame,
    });
  }
  const seen = new Set<string>();
  for (const t of p.upgrades) {
    const key = JSON.stringify([t.sceneId, t.path, t.nodeId]);
    if (seen.has(key)) throw new VmotionError('TEMPLATE_TARGET', 'One upgrade per instance');
    seen.add(key);
    const source = t.source ?? published;
    if (!source) throw new VmotionError('TEMPLATE_SOURCE', 'Upgrade needs a version source');
    const scope = await renderer.inspectComposition(
        candidate,
        t.sceneId,
        t.frame,
        t.path,
        t.contextFrames,
      ),
      node = scope.scene.nodes.find((n) => n.id === t.nodeId);
    if (!node?.templateInstance || node.templateInstance.mode !== 'linked')
      throw new VmotionError('TEMPLATE_TYPE', 'Only linked instances can be upgraded');
    const old = renderer.templates.metadata(candidate, node),
      next = renderer.templates.resolve(candidate, source),
      d = next.document;
    if (old.template.id !== d.id)
      throw new VmotionError('TEMPLATE_ID', 'Choose a version of the same template');
    const kept: string[] = [],
      migrations = d.migrations.parameters,
      current = resolveParameters(old.parameters, node.params),
      movedOld = migrateValues(old.defaults, migrations),
      movedCurrent = migrateValues(current, migrations);
    let params =
      t.parameterPolicy === 'defaults'
        ? structuredClone(next.defaults)
        : (mergeDefaults(movedOld, movedCurrent, next.defaults, '', kept) as Record<
            string,
            unknown
          >);
    params = mergeMotionParameters(params, t.values);
    params = resolveParameters(d.parameters as ParameterDefinitions, params);
    const animations = node.animations
        .filter((a) => !t.removeChannels.includes(a.property))
        .map((a) =>
          a.property.startsWith('params.')
            ? { ...a, property: 'params.' + migratePath(a.property.slice(7), migrations) }
            : a,
        ),
      overrides: Node['overrides'] = Object.create(null);
    for (const [id, value] of Object.entries(node.overrides)) {
      if (t.removeOverrides.includes(id)) continue;
      const nextId = migratePath(id, d.migrations.layers);
      if (Object.hasOwn(overrides, nextId))
        throw new VmotionError('TEMPLATE_MIGRATION', 'Layer migration collides');
      overrides[nextId] = migrateLayerPatch(value, d.migrations.layers, node.id);
    }
    const structure = node.structure ? structuredClone(node.structure) : undefined;
    if (structure) {
      const migrateEdit = (edit: Omit<NonNullable<Node['structure']>, 'nested'>) => {
        edit.removed = edit.removed.map((id) => migratePath(id, d.migrations.layers));
        edit.order = edit.order.map((id) => migratePath(id, d.migrations.layers));
        edit.parents = Object.fromEntries(
          Object.entries(edit.parents).map(([k, v]) => [
            migratePath(k, d.migrations.layers),
            v ? migratePath(v, d.migrations.layers) : v,
          ]),
        );
        edit.added = edit.added.map((n) =>
          migrateLayerPatch(n as Node, d.migrations.layers, node.id),
        );
      };
      migrateEdit(structure);
      for (const v of Object.values(structure.nested)) migrateEdit(v);
      structure.nested = Object.fromEntries(
        Object.entries(structure.nested).map(([k, v]) => [migratePath(k, d.migrations.layers), v]),
      );
    }
    let theme = node.theme ? structuredClone(node.theme) : node.theme;
    if (theme) {
      const ren = (field: string) =>
        field.startsWith('params.') ? 'params.' + migratePath(field.slice(7), migrations) : field;
      theme.links = Object.fromEntries(Object.entries(theme.links).map(([k, v]) => [ren(k), v]));
      theme.overrides = Object.fromEntries(
        Object.entries(theme.overrides).map(([k, v]) => [ren(k), v]),
      );
      theme.baseline = Object.fromEntries(
        Object.entries(theme.baseline).map(([k, v]) => {
          const field = ren(k),
            oldValue = themePathValue({ ...node, params: current }, k),
            newValue = themePathValue({ ...node, params }, field);
          return [field, themeEqual(oldValue, v) ? newValue : v];
        }),
      );
    }
    const patch: Partial<Node> = {
      sceneId: d.sceneId,
      params,
      animations,
      overrides,
      structure,
      theme,
      templateInstance: { source, hash: next.hash, mode: 'linked' },
      expressions: Object.fromEntries(
        Object.entries(node.expressions ?? {}).map(([p, s]) => [
          p.startsWith('params.') ? 'params.' + migratePath(p.slice(7), migrations) : p,
          migrateExpression(s, migrations, d.migrations.layers, node.id),
        ]),
      ),
    };
    apply(
      await edit(candidate, t.sceneId, t.frame, [
        { path: t.path, contextFrames: t.contextFrames, nodeId: t.nodeId, patch },
      ]),
    );
    reports.push({
      action: 'upgrade',
      sceneId: t.sceneId,
      path: t.path,
      nodeId: t.nodeId,
      from: old.template.version,
      to: d.version,
      keptParameters: kept,
      keptOverrides: Object.keys(overrides),
      migrations: d.migrations,
    });
    samples.push({
      sceneId: t.sceneId,
      path: t.path,
      contextFrames: t.contextFrames,
      frame: t.frame,
    });
  }
  for (const t of p.detach) {
    const scope = await renderer.inspectComposition(
        candidate,
        t.sceneId,
        t.frame,
        t.path,
        t.contextFrames,
      ),
      node = scope.scene.nodes.find((n) => n.id === t.nodeId);
    if (!node?.templateInstance)
      throw new VmotionError('TEMPLATE_TYPE', 'Detach requires an instance');
    const meta = renderer.templates.metadata(candidate, node),
      prefix = `components/templates/local-${randomUUID()}`,
      map = new Map(
        Object.keys(meta.template.files)
          .filter((f) => f.startsWith('components/'))
          .map((f) => [f, prefix + '/code/' + f]),
      ),
      privateSceneId = 'template-local-' + randomUUID(),
      srcScene = candidate.scenes.find((s) => s.id === node.sceneId)!,
      copies: Operation[] = [];
    for (const [old, file] of map) {
      const text = candidate.files[old];
      if (old.endsWith('.json'))
        copies.push({
          type: 'writeSource',
          path: file,
          content: json(rewritePaths(JSON.parse(text), map)),
        });
      else {
        let body = text;
        for (const [from, to] of map)
          body = body
            .split(JSON.stringify(from))
            .join(JSON.stringify(to))
            .split("'" + from + "'")
            .join(JSON.stringify(to));
        copies.push({ type: 'writeSource', path: file, content: body });
      }
    }
    const scene = {
      ...srcScene,
      id: privateSceneId,
      name: srcScene.name + ' · 本地副本',
      nodes: srcScene.nodes.map((n) => rewritePaths(n, map) as Node),
    };
    apply([...copies, { type: 'addScene', scene }]);
    const file = prefix + '/manifest.json',
      manifest = {
        ...meta.template,
        sceneId: privateSceneId,
        files: Object.fromEntries(
          [...map.values(), `scenes/${privateSceneId}.json`].map((f) => [
            f,
            hash(candidate.files[f]),
          ]),
        ),
      };
    apply([{ type: 'writeSource', path: file, content: json(manifest) }]);
    apply(
      await edit(candidate, t.sceneId, t.frame, [
        {
          path: t.path,
          contextFrames: t.contextFrames,
          nodeId: t.nodeId,
          patch: {
            sceneId: privateSceneId,
            templateInstance: { source: file, hash: hash(candidate.files[file]), mode: 'local' },
          },
        },
      ]),
    );
    reports.push({
      action: 'detach',
      sceneId: t.sceneId,
      path: t.path,
      nodeId: t.nodeId,
      source: file,
    });
    samples.push({
      sceneId: t.sceneId,
      path: t.path,
      contextFrames: t.contextFrames,
      frame: t.frame,
    });
  }
  if (!operations.length)
    throw new VmotionError('TEMPLATE_EMPTY', 'Provide publish, placements, upgrades or detach');
  const unique = [...new Map(samples.map((s) => [JSON.stringify(s), s])).values()],
    input = {
      revision: snapshot.revision,
      operations,
      samples: unique.slice(0, 12),
      width: 480,
      visual: true,
      determinism: true,
    },
    stored = p.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    published,
    changes: reports,
    sampleCoverage: {
      included: Math.min(12, unique.length),
      total: unique.length,
      incomplete: unique.length > 12,
    },
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
  };
}
