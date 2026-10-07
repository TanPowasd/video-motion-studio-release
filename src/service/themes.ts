import { z } from 'zod';
import { createCanvas } from '@napi-rs/canvas';
import {
  themeDocumentSchema,
  themeTokenSchema,
  themeFileSchema,
  themePropertySchema,
  type ThemeDocument,
} from '../core/theme-schema.js';
import { bindTheme, themeSetPath, themePathValue } from '../core/theme.js';
import { VmotionError, type Snapshot, type Node, type Operation } from '../core/model.js';
import { contextFramesSchema } from '../core/content-time.js';
import type { CompositionDraft } from '../core/interaction.js';
import type { Renderer } from '../core/renderer.js';
import { applyOperations } from './operations.js';
import { hash, json } from './project.js';
import { storeAgentPlan } from './agent-plans.js';
const target = {
  sceneId: z.string(),
  nodeId: z.string(),
  path: z.array(z.string()).max(32).default([]),
  contextFrames: contextFramesSchema.default([]),
  frame: z.number().finite().nonnegative().default(0),
};
export const themeInspectSchema = z
  .object({
    source: themeFileSchema.optional(),
    target: z.object(target).strict().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(256).default(24),
    detail: z.boolean().default(false),
  })
  .strict();
export const themePlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    source: themeFileSchema.optional(),
    document: themeDocumentSchema.optional(),
    expectedHash: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .nullable()
      .optional(),
    changes: z
      .array(
        z.discriminatedUnion('type', [
          z.object({ type: z.literal('set'), token: themeTokenSchema }).strict(),
          z.object({ type: z.literal('remove'), id: z.string() }).strict(),
          z.object({ type: z.literal('parent'), source: themeFileSchema.nullable() }).strict(),
        ]),
      )
      .max(256)
      .default([]),
    targets: z
      .array(
        z
          .object({
            ...target,
            action: z.enum(['bind', 'update', 'clearLocal', 'detach', 'toggle']).default('bind'),
            links: z.record(themePropertySchema, z.string()).optional(),
            values: z.record(themePropertySchema, z.unknown()).optional(),
            fields: z.array(themePropertySchema).max(128).default([]),
            enabled: z.boolean().optional(),
            source: themeFileSchema.optional(),
          })
          .strict(),
      )
      .max(100)
      .default([]),
  })
  .strict();
export function validateThemeColors(document: ThemeDocument) {
  const ctx = createCanvas(1, 1).getContext('2d');
  for (const t of document.tokens)
    if (t.type === 'color' && t.value !== undefined) {
      ctx.fillStyle = '#010203';
      ctx.fillStyle = t.value;
      const a = ctx.fillStyle;
      ctx.fillStyle = '#040506';
      ctx.fillStyle = t.value;
      const b = ctx.fillStyle;
      if (a === '#010203' && b === '#040506')
        throw new VmotionError('THEME_COLOR', 'Color token is not valid native CSS paint', {
          tokenId: t.id,
        });
    }
}
export async function inspectThemes(renderer: Renderer, snapshot: Snapshot, raw: unknown) {
  const p = themeInspectSchema.parse(raw),
    sources = Object.entries(snapshot.files)
      .filter(([file, text]) => file.startsWith('components/themes/') && file.endsWith('.json'))
      .map(([file, text]) => ({ file, hash: hash(text) }));
  if (!p.source && !p.target)
    return {
      revision: snapshot.revision,
      themes: {
        total: sources.length,
        offset: p.offset,
        items: sources.slice(p.offset, p.offset + p.limit),
        nextOffset: p.offset + p.limit < sources.length ? p.offset + p.limit : null,
      },
    };
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
    if (!node) throw new VmotionError('NOT_FOUND', 'Theme target was not found');
  }
  const source = p.source ?? node?.theme?.source;
  if (!source) return { revision: snapshot.revision, nodeId: node?.id, linked: false };
  const prepared = renderer.themes.prepare(snapshot, source),
    tokens = [...prepared.tokens.entries()];
  return {
    revision: snapshot.revision,
    source,
    dependencies: [...prepared.probes.keys()],
    tokens: {
      total: tokens.length,
      offset: p.offset,
      items: tokens.slice(p.offset, p.offset + p.limit).map(([id, e]) => ({
        id,
        type: e.token.type,
        value: e.value,
        inheritedFrom: e.file,
        ...(p.detail ? { definition: e.token } : {}),
      })),
      nextOffset: p.offset + p.limit < tokens.length ? p.offset + p.limit : null,
    },
    ...(node
      ? {
          nodeId: node.id,
          enabled: node.theme?.enabled,
          fields: renderer.themes.inspectBinding(snapshot, node),
        }
      : {}),
    cache: renderer.themes.report(),
  };
}
export async function planTheme(
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
  const p = themePlanSchema.parse(raw);
  if (p.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before theme planning');
  let candidate = structuredClone(snapshot);
  const operations: Operation[] = [],
    reports = [],
    samples = [];
  if (p.document || p.changes.length) {
    if (!p.source)
      throw new VmotionError('THEME_SOURCE', 'Document edits require a theme source path');
    const before = snapshot.files[p.source];
    if (
      p.expectedHash === undefined ||
      (before === undefined ? null : hash(before)) !== p.expectedHash
    )
      throw new VmotionError(
        'FILE_HASH_CONFLICT',
        'Theme edit requires the exact current hash or null for creation',
        { file: p.source },
      );
    let d = themeDocumentSchema.parse(p.document ?? JSON.parse(before ?? 'null'));
    for (const c of p.changes) {
      if (c.type === 'parent') d = { ...d, parent: c.source ?? undefined };
      else if (c.type === 'set') {
        const at = d.tokens.findIndex((t) => t.id === c.token.id);
        if (at < 0) d.tokens.push(c.token);
        else d.tokens[at] = c.token;
      } else {
        if (!d.tokens.some((t) => t.id === c.id))
          throw new VmotionError('THEME_TOKEN', 'Token to remove is missing', { tokenId: c.id });
        d.tokens = d.tokens.filter((t) => t.id !== c.id);
      }
    }
    d = themeDocumentSchema.parse(d);
    validateThemeColors(d);
    const op: Operation = { type: 'writeSource', path: p.source, content: json(d) };
    operations.push(op);
    candidate = applyOperations(root, candidate, [op]);
    renderer.themes.prepare(candidate, p.source);
  }
  const seen = new Set<string>();
  for (const t of p.targets) {
    const key = JSON.stringify([t.sceneId, t.path, t.nodeId]);
    if (seen.has(key)) throw new VmotionError('THEME_TARGET', 'Use one theme edit per layer');
    seen.add(key);
    const scope = await renderer.inspectComposition(
        candidate,
        t.sceneId,
        t.frame,
        t.path,
        t.contextFrames,
      ),
      rawNode = scope.scene.nodes.find((n) => n.id === t.nodeId);
    if (!rawNode) throw new VmotionError('NOT_FOUND', 'Theme target is outside this scope');
    let node = rawNode;
    if (t.action === 'bind') {
      if (rawNode.theme)
        throw new VmotionError(
          'THEME_BOUND',
          'Layer already has a theme; update or detach it explicitly',
        );
      const source = t.source ?? p.source;
      if (!source || !t.links)
        throw new VmotionError('THEME_BINDING', 'Bind needs a source and links');
      if (node.type === 'component' && node.component) {
        const metadata = await renderer.components.describe(candidate, node.component);
        const { resolveParameters } = await import('../core/parameters.js');
        node = { ...node, params: resolveParameters(metadata.parameters, node.params) };
      }
      if (node.templateInstance) {
        const metadata = renderer.templates.metadata(candidate, node);
        const { resolveParameters } = await import('../core/parameters.js');
        node = { ...node, params: resolveParameters(metadata.parameters, node.params) };
      }
      node = bindTheme(node, { source, links: t.links, overrides: t.values, enabled: t.enabled });
    } else {
      if (!node.theme) throw new VmotionError('THEME_BINDING', 'Layer has no theme binding');
      if (t.action === 'detach') {
        node = renderer.themes.resolveNode(candidate, node);
        node = { ...node, theme: null };
      } else if (t.action === 'toggle')
        node = { ...node, theme: { ...node.theme, enabled: t.enabled ?? !node.theme.enabled } };
      else if (t.action === 'clearLocal') {
        const b = structuredClone(node.theme);
        for (const field of t.fields.length ? t.fields : Object.keys(b.links)) {
          if (!Object.hasOwn(b.links, field))
            throw new VmotionError('THEME_PROPERTY', 'Field is not linked', { property: field });
          delete b.overrides[field];
          node = themeSetPath(node, field, b.baseline[field]);
        }
        node = { ...node, theme: b };
      } else {
        const b = structuredClone(node.theme);
        if (t.source) b.source = t.source;
        if (t.links) {
          for (const [field, token] of Object.entries(t.links)) {
            b.links[field] = token;
            if (!Object.hasOwn(b.baseline, field))
              b.baseline[field] = structuredClone(themePathValue(node, field));
          }
        }
        for (const [field, value] of Object.entries(t.values ?? {})) {
          if (!Object.hasOwn(b.links, field))
            throw new VmotionError('THEME_PROPERTY', 'Override addresses an unlinked field', {
              property: field,
            });
          b.overrides[field] = value;
        }
        node = { ...node, theme: b };
      }
    }
    renderer.themes.resolveNode(candidate, node);
    const patch: Partial<Node> = {
      theme: node.theme,
      ...(node.params !== rawNode.params ? { params: node.params } : {}),
    };
    if (t.action === 'detach' || t.action === 'clearLocal')
      for (const field of Object.keys(rawNode.theme!.links)) {
        const first = field.split('.')[0] as keyof Node;
        (patch as any)[first] = (node as any)[first];
      }
    const ops = await edit(candidate, t.sceneId, t.frame, [
      { path: t.path, nodeId: t.nodeId, contextFrames: t.contextFrames, patch },
    ]);
    operations.push(...ops);
    candidate = applyOperations(root, candidate, ops);
    reports.push({
      sceneId: t.sceneId,
      path: t.path,
      nodeId: t.nodeId,
      action: t.action,
      fields: node.theme ? Object.keys(node.theme.links) : [],
    });
    samples.push({
      sceneId: t.sceneId,
      path: t.path,
      contextFrames: t.contextFrames,
      frame: t.frame,
    });
  }
  if (!operations.length) throw new VmotionError('THEME_EMPTY', 'Provide theme edits or bindings');
  if (p.document || p.changes.length)
    for (const scene of candidate.scenes)
      for (const frame of new Set([0, Math.floor((scene.duration - 1) / 2), scene.duration - 1]))
        samples.push({ sceneId: scene.id, path: [], contextFrames: [], frame });
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
    source: p.source,
    layers: reports,
    sampleCoverage: {
      included: Math.min(unique.length, 12),
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
