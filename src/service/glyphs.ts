import { createHash } from 'node:crypto';
import { createCanvas } from '@napi-rs/canvas';
import { z } from 'zod';
import { VmotionError, type Node, type Operation, type Snapshot } from '../core/model.js';
import { nativeTextFont } from '../core/bundled-fonts.js';
import { GlyphComposer, isGlyphProblem, type ComposedGlyph } from '../core/glyphs/compose.js';
import { drawComposedGlyph, drawTofu } from '../core/glyphs/glyph-draw.js';
import {
  GlyphSetResolver,
  builtinGlyphSet,
  builtinGlyphSetIds,
  glyphSetFiles,
  type PreparedGlyphSet,
} from '../core/glyphs/glyph-resources.js';
import {
  glyphAdjustSchema,
  glyphComponentSchema,
  glyphEntrySchema,
  glyphFallbackSchema,
  glyphMetricsSchema,
  glyphSetFile,
  glyphSetIdSchema,
  glyphSetRefSchema,
  glyphSetSchema,
  glyphStyleSchema,
  glyphBoxSchema,
  idsOperators,
  type GlyphSetDocument,
} from '../core/glyphs/glyph-schema.js';
import { formatIds, idsLeaves, parseIds } from '../core/glyphs/ids.js';
import { captionsSchema } from '../core/captions.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
import { atomicWrite, safePath, validateSnapshot } from './project.js';

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const chars = (text: string) => Array.from(graphemes.segment(text), (s) => s.segment);
const unique = (text: string) => [...new Set(chars(text).filter((c) => !/^\s+$/u.test(c)))];

/* ---------- schemas ---------- */

const previewFields = {
  preview: z
    .string()
    .max(200)
    .optional()
    .describe('Characters to render as a native preview sheet (max 200 graphemes)'),
  previewSize: z.number().int().min(16).max(256).default(96),
};
export const glyphsInspectSchema = z
  .object({
    set: glyphSetRefSchema.optional().describe('Glyph set: project ID or builtin:<id>'),
    text: z.string().max(100000).optional().describe('Coverage report for this text'),
    project: z
      .boolean()
      .optional()
      .describe('Coverage of every text layer and caption that uses a glyph set (or `set`)'),
    chars: z.string().max(400).optional().describe('Per-character composition details'),
    expression: z
      .string()
      .max(400)
      .optional()
      .describe('Compose an IDS expression (live preview); combine with adjust/preview'),
    adjust: z.record(z.string().regex(/^$|^\d(\.\d)*$/), glyphAdjustSchema).optional(),
    components: z.boolean().optional().describe('List component IDs/names (paginated)'),
    glyphs: z.boolean().optional().describe('List glyph characters/IDS (paginated)'),
    offset: z.number().int().min(0).default(0),
    limit: z.number().int().min(1).max(500).default(48),
    ...previewFields,
  })
  .strict();

const styleInput = glyphStyleSchema.partial().strict();
const metricsInput = glyphMetricsSchema.partial().strict();
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      id: glyphSetIdSchema,
      name: z.string().min(1).max(100),
      description: z.string().max(2000).optional(),
      extends: glyphSetRefSchema.optional().describe('Inherit components/glyphs (e.g. builtin:demo)'),
      copyFrom: glyphSetRefSchema
        .optional()
        .describe('Copy all components/glyphs into the new file so they become editable'),
      metrics: metricsInput.optional(),
      style: styleInput.optional(),
    })
    .strict(),
  z
    .object({ action: z.literal('setStyle'), style: styleInput.optional(), metrics: metricsInput.optional() })
    .strict(),
  z
    .object({
      action: z.literal('setComponent'),
      name: z.string().min(1).max(40),
      component: glyphComponentSchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('setGlyph'),
      char: z.string().min(1).max(16),
      glyph: glyphEntrySchema.nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('setOperator'),
      operator: z.enum(idsOperators),
      ratio: z.union([z.number().min(0.05).max(0.95), z.array(z.number().min(0.05).max(0.95)).min(2).max(3)]).optional(),
      inner: glyphBoxSchema.optional(),
    })
    .strict(),
  z
    .object({
      action: z.literal('setKerning'),
      pair: z.string().min(2).max(16),
      value: z.number().finite().min(-2000).max(2000).nullable(),
    })
    .strict(),
  z
    .object({
      action: z.literal('assign'),
      sceneId: z.string().min(1),
      nodeIds: z.array(z.string().min(1)).min(1).max(500),
      glyphSet: glyphSetRefSchema.nullable(),
      fallback: glyphFallbackSchema.optional(),
    })
    .strict(),
]);
export const glyphsPlanSchema = z
  .object({
    revision: z.string().optional(),
    set: glyphSetIdSchema
      .optional()
      .describe('Project glyph set the file actions edit (defaults to the create action ID)'),
    actions: z.array(actionSchema).min(1).max(500),
    ...previewFields,
  })
  .strict();

/* ---------- helpers ---------- */

type Host = { root: string; glyphSets?: GlyphSetResolver };
const resolverFor = (host: Host) => host.glyphSets ?? new GlyphSetResolver();

function describeChar(set: PreparedGlyphSet, char: string) {
  const g = set.composer.glyph(char),
    entry = set.document.glyphs[char];
  const base = {
    char,
    defined: entry !== undefined ? 'glyph' : set.document.components[char] ? 'component' : 'missing',
  };
  if (isGlyphProblem(g)) return { ...base, ok: false, code: g.code, message: g.message, missing: g.missing };
  return {
    ...base,
    ok: true,
    ids: g.ids,
    advance: g.advance,
    strokes: g.strokes.length,
    fills: g.fills.length,
    parts: g.parts.map((p) => ({ ref: p.ref, path: p.path, box: [p.box.x, p.box.y, p.box.w, p.box.h].map((v) => Math.round(v)) })),
  };
}

export function coverageReport(set: PreparedGlyphSet, text: string) {
  const counts = new Map<string, number>();
  for (const c of chars(text)) if (!/^\s+$/u.test(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
  const covered: string[] = [],
    missing: Array<{ char: string; count: number; reason: string; needs?: string[] }> = [];
  for (const [char, count] of counts) {
    const g = set.composer.has(char) ? set.composer.glyph(char) : undefined;
    if (g && !isGlyphProblem(g)) covered.push(char);
    else
      missing.push({
        char,
        count,
        reason: g ? g.code : 'GLYPH_MISSING',
        ...(g && isGlyphProblem(g) && g.missing ? { needs: g.missing } : {}),
      });
  }
  missing.sort((a, b) => b.count - a.count || a.char.localeCompare(b.char));
  const total = [...counts.values()].reduce((s, v) => s + v, 0),
    coveredCount = covered.reduce((s, c) => s + counts.get(c)!, 0);
  return {
    unique: counts.size,
    total,
    coveredUnique: covered.length,
    coveredTotal: coveredCount,
    ratio: total ? Math.round((coveredCount / total) * 10000) / 10000 : 1,
    missing,
  };
}

type Usage = { set: string; text: string; where: string };
/** Every text layer (and caption track) that uses a glyph set. */
export function projectGlyphUsage(snapshot: Snapshot, only?: string): Usage[] {
  const out: Usage[] = [];
  for (const scene of snapshot.scenes)
    for (const node of scene.nodes)
      if (node.type === 'text' && node.glyphSet && (!only || node.glyphSet === only))
        out.push({ set: node.glyphSet, text: node.text, where: `${scene.id}/${node.id}` });
  for (const [file, source] of Object.entries(snapshot.files)) {
    const m = /^components\/captions-([\w-]+)\.ts$/.exec(file);
    if (!m) continue;
    const declared = /glyphSet:\{type:'string',default:("[^"]*")\}/.exec(source);
    if (!declared) continue;
    let set: string;
    try {
      set = JSON.parse(declared[1]);
    } catch {
      continue;
    }
    // Component nodes may override the declared default.
    const node = snapshot.scenes
      .flatMap((s) => s.nodes)
      .find((n) => n.type === 'component' && n.component === file);
    const override = node?.params?.glyphSet;
    if (typeof override === 'string') set = override;
    if (!set || (only && set !== only)) continue;
    const data = snapshot.files[`components/captions-${m[1]}.json`];
    if (!data) continue;
    try {
      const doc = captionsSchema.parse(JSON.parse(data));
      out.push({ set, text: doc.cues.map((c) => c.text).join('\n'), where: `captions:${file}` });
    } catch {
      /* reported by project validation */
    }
  }
  return out;
}

function sheet(set: GlyphSetDocument | undefined, items: Array<{ char: string; glyph?: ComposedGlyph; label?: string }>, size: number) {
  const cols = Math.min(12, Math.max(1, items.length)),
    rows = Math.ceil(items.length / cols),
    label = Math.max(12, Math.round(size * 0.18)),
    canvas = createCanvas(cols * size, rows * (size + label)),
    ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  items.forEach((item, i) => {
    const x = (i % cols) * size,
      y = Math.floor(i / cols) * (size + label),
      advance = item.glyph?.advance ?? set?.metrics.advance ?? 1000,
      em = set?.metrics.em ?? 1000;
    ctx.strokeStyle = '#e3e6ee';
    ctx.lineWidth = 1;
    ctx.strokeRect(x + 0.5, y + 0.5, size - 1, size - 1);
    ctx.save();
    ctx.translate(x + (size - (advance / em) * size) / 2, y);
    ctx.fillStyle = '#16181d';
    if (item.glyph && set) drawComposedGlyph(ctx, item.glyph, set, size);
    else {
      ctx.fillStyle = '#d2263b';
      drawTofu(ctx, set, size, advance);
    }
    ctx.restore();
    ctx.fillStyle = item.glyph ? '#5b6170' : '#d2263b';
    ctx.font = nativeTextFont(400, label * 0.75, 'Microsoft YaHei');
    ctx.textBaseline = 'top';
    ctx.fillText((item.label ?? item.char).slice(0, 14), x + 3, y + size + 1);
  });
  return canvas;
}

async function writePreview(
  root: string,
  set: GlyphSetDocument | undefined,
  items: Array<{ char: string; glyph?: ComposedGlyph; label?: string }>,
  size: number,
  inline: boolean,
) {
  const canvas = sheet(set, items, size),
    buffer = await canvas.encode('png'),
    key = createHash('sha256').update(buffer).digest('hex').slice(0, 16),
    output = safePath(root, `.vmotion/glyphs/preview-${key}.png`);
  await atomicWrite(output, buffer);
  return {
    output,
    width: canvas.width,
    height: canvas.height,
    pixelHash: key,
    ...(inline ? { data: buffer.toString('base64') } : {}),
  };
}

const previewItems = (set: PreparedGlyphSet, text: string) =>
  unique(text)
    .slice(0, 200)
    .map((char) => {
      const g = set.composer.has(char) ? set.composer.glyph(char) : undefined;
      return { char, glyph: g && !isGlyphProblem(g) ? g : undefined };
    });

/* ---------- inspect ---------- */

export async function inspectGlyphs(host: Host, snapshot: Snapshot, raw: unknown, inline = false) {
  const request = glyphsInspectSchema.parse(raw),
    resolver = resolverFor(host),
    sets = resolver.list(snapshot);
  const result: Record<string, unknown> = {
    revision: snapshot.revision,
    sets,
    builtin: builtinGlyphSetIds.map((id) => `builtin:${id}`),
  };
  const wantsSet = request.set ?? (request.text || request.chars || request.expression || request.preview || request.components || request.glyphs ? 'builtin:demo' : undefined);
  let set: PreparedGlyphSet | undefined;
  if (wantsSet) {
    set = resolver.resolve(snapshot, wantsSet);
    result.set = {
      id: wantsSet,
      name: set.document.name,
      file: set.file,
      extends: set.document.extends,
      metrics: set.document.metrics,
      style: set.document.style,
      operators: set.document.operators,
      components: Object.keys(set.document.components).length,
      glyphs: Object.keys(set.document.glyphs).length,
      hash: set.hash,
    };
  }
  if (set && request.components) {
    const entries = Object.entries(set.document.components);
    result.components = {
      total: entries.length,
      offset: request.offset,
      items: entries.slice(request.offset, request.offset + request.limit).map(([id, c]) => ({
        id,
        ...(c.name ? { name: c.name } : {}),
        ...(c.ids ? { ids: c.ids } : {}),
        strokes: c.strokes.length,
        fills: c.fills.length,
        ...(c.prefer ? { prefer: c.prefer } : {}),
        ...(c.inner ? { inner: c.inner } : {}),
      })),
    };
  }
  if (set && request.glyphs) {
    const entries = Object.entries(set.document.glyphs);
    result.glyphs = {
      total: entries.length,
      offset: request.offset,
      items: entries.slice(request.offset, request.offset + request.limit).map(([char, g]) =>
        typeof g === 'string' ? { char, ids: g } : { char, ...(g.ids ? { ids: g.ids } : {}), explicit: Boolean(g.strokes?.length || g.fills?.length), ...(g.advance !== undefined ? { advance: g.advance } : {}), ...(g.adjust ? { adjust: g.adjust } : {}) },
      ),
    };
  }
  if (set && request.text !== undefined) {
    const report = coverageReport(set, request.text);
    result.coverage = { ...report, missing: report.missing.slice(request.offset, request.offset + request.limit), missingTotal: report.missing.length };
  }
  if (request.project) {
    const usage = projectGlyphUsage(snapshot, request.set),
      bySet = new Map<string, Usage[]>();
    for (const u of usage) bySet.set(u.set, [...(bySet.get(u.set) ?? []), u]);
    result.project = [...bySet].map(([id, items]) => {
      const prepared = resolver.tryResolve(snapshot, id);
      if (!prepared) return { set: id, error: 'GLYPH_SET_MISSING', layers: items.map((i) => i.where) };
      const report = coverageReport(prepared, items.map((i) => i.text).join('\n')),
        where = (char: string) => items.filter((i) => i.text.includes(char)).map((i) => i.where).slice(0, 8);
      return {
        set: id,
        layers: items.length,
        ...report,
        missingTotal: report.missing.length,
        missing: report.missing.slice(request.offset, request.offset + request.limit).map((m) => ({ ...m, where: where(m.char) })),
      };
    });
  }
  if (set && request.chars) result.chars = unique(request.chars).slice(0, 64).map((c) => describeChar(set!, c));
  let expressionGlyph: ComposedGlyph | undefined;
  if (set && request.expression) {
    try {
      expressionGlyph = set.composer.composeExpression(request.expression, { adjust: request.adjust });
      const tree = parseIds(request.expression);
      result.expression = {
        ok: true,
        ids: formatIds(tree),
        leaves: idsLeaves(tree),
        strokes: expressionGlyph.strokes.length,
        parts: expressionGlyph.parts.map((p) => ({ ref: p.ref, path: p.path, box: [p.box.x, p.box.y, p.box.w, p.box.h].map((v) => Math.round(v)) })),
      };
    } catch (e) {
      result.expression = { ok: false, code: (e as VmotionError).code ?? 'GLYPH_IDS', message: (e as Error).message, details: (e as VmotionError).details };
    }
  }
  if (set && (request.preview || expressionGlyph)) {
    const items = request.preview ? previewItems(set, request.preview) : [];
    if (expressionGlyph) items.unshift({ char: request.expression!, glyph: expressionGlyph });
    Object.assign(result, await writePreview(host.root, set.document, items, request.previewSize, inline));
    result.mimeType = 'image/png';
  }
  return result;
}

/* ---------- plan ---------- */

export async function planGlyphs(host: Host, snapshot: Snapshot, raw: unknown, inline = false) {
  const request = glyphsPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before glyph planning');
  const files = glyphSetFiles(snapshot),
    createAction = request.actions.find((a) => a.action === 'create') as Extract<z.infer<typeof actionSchema>, { action: 'create' }> | undefined,
    target = request.set ?? createAction?.id;
  const fileActions = request.actions.filter((a) => a.action !== 'assign' && a.action !== 'create');
  if (fileActions.length && !target)
    throw new VmotionError('GLYPH_SET', 'Name the project glyph set to edit with `set` (builtin sets are read-only; create one with copyFrom/extends)');
  if (createAction && files.has(createAction.id))
    throw new VmotionError('GLYPH_SET_EXISTS', `Glyph set "${createAction.id}" already exists`, { file: files.get(createAction.id) });
  if (request.actions.filter((a) => a.action === 'create').length > 1)
    throw new VmotionError('GLYPH_PLAN', 'Create one glyph set per plan');
  let document: GlyphSetDocument | undefined;
  let raw0: Record<string, unknown> | undefined;
  if (createAction) {
    const copy = createAction.copyFrom ? new GlyphSetResolver(0).resolve(snapshot, createAction.copyFrom).document : undefined;
    raw0 = {
      kind: 'glyph-set',
      version: 1,
      id: createAction.id,
      name: createAction.name,
      ...(createAction.description ? { description: createAction.description } : {}),
      ...(createAction.extends ? { extends: createAction.extends } : {}),
      // With extends, store only what the user changed so the parent's values keep applying.
      metrics: { ...(copy?.metrics ?? (createAction.extends ? {} : glyphMetricsSchema.parse({}))), ...(createAction.metrics ?? {}) },
      style: { ...(copy?.style ?? (createAction.extends ? {} : glyphStyleSchema.parse({}))), ...(createAction.style ?? {}) },
      operators: { ...(copy?.operators ?? {}) },
      components: { ...(copy?.components ?? {}) },
      glyphs: { ...(copy?.glyphs ?? {}) },
      kerning: { ...(copy?.kerning ?? {}) },
    };
  } else if (target) {
    const file = files.get(target);
    if (!file) {
      if (builtinGlyphSet(target) || target.startsWith('builtin'))
        throw new VmotionError('GLYPH_READONLY', 'Built-in glyph sets are read-only; create a project set with copyFrom or extends');
      throw new VmotionError('GLYPH_SET', `Glyph set "${target}" does not exist; add a create action`);
    }
    try {
      raw0 = JSON.parse(snapshot.files[file]);
    } catch (e) {
      throw new VmotionError('GLYPH_DOCUMENT', `Invalid glyph set JSON: ${(e as Error).message}`, { file });
    }
  }
  const summary: Array<Record<string, unknown>> = [],
    touchedChars = new Set<string>();
  if (raw0) {
    const doc = raw0 as Record<string, any>;
    for (const key of ['metrics', 'style', 'operators', 'components', 'glyphs', 'kerning']) doc[key] ??= {};
    for (const action of request.actions) {
      switch (action.action) {
        case 'create':
          summary.push({ action: 'create', id: action.id, copied: Object.keys(doc.glyphs).length });
          break;
        case 'setStyle':
          Object.assign(doc.style, action.style ?? {});
          Object.assign(doc.metrics, action.metrics ?? {});
          summary.push({ action: 'setStyle', style: action.style, metrics: action.metrics });
          break;
        case 'setComponent':
          if (action.component === null) delete doc.components[action.name];
          else doc.components[action.name] = action.component;
          summary.push({ action: 'setComponent', name: action.name, removed: action.component === null });
          for (const [char, g] of Object.entries(doc.glyphs as Record<string, unknown>)) {
            const ids = typeof g === 'string' ? g : (g as { ids?: string })?.ids;
            if (ids && ids.includes(action.name)) touchedChars.add(char);
          }
          if (Array.from(action.name).length === 1) touchedChars.add(action.name);
          break;
        case 'setGlyph':
          if (chars(action.char).length !== 1)
            throw new VmotionError('GLYPH_CHAR', 'A glyph key must be exactly one character (grapheme)', { char: action.char });
          if (action.glyph === null) delete doc.glyphs[action.char];
          else {
            const ids = typeof action.glyph === 'string' ? action.glyph : action.glyph.ids;
            if (ids) parseIds(ids);
            doc.glyphs[action.char] = action.glyph;
          }
          touchedChars.add(action.char);
          summary.push({ action: 'setGlyph', char: action.char, removed: action.glyph === null });
          break;
        case 'setOperator':
          doc.operators[action.operator] = {
            ...(action.ratio !== undefined ? { ratio: action.ratio } : {}),
            ...(action.inner ? { inner: action.inner } : {}),
          };
          summary.push({ action: 'setOperator', operator: action.operator });
          break;
        case 'setKerning':
          if (action.value === null) delete doc.kerning[action.pair];
          else doc.kerning[action.pair] = action.value;
          summary.push({ action: 'setKerning', pair: action.pair });
          break;
        default:
          break;
      }
    }
    try {
      document = glyphSetSchema.parse(doc);
    } catch (e) {
      throw new VmotionError('GLYPH_DOCUMENT', `Glyph set is invalid after the plan: ${(e as Error).message}`, { issues: (e as z.ZodError).issues?.slice(0, 20) });
    }
  }
  const operations: Operation[] = [];
  if (document && target)
    // Write the edited JSON (validated above) rather than the parsed form, so schema defaults
    // never shadow inherited values.
    operations.push({ type: 'writeSource', path: glyphSetFile(target), content: JSON.stringify(raw0, null, 2) + '\n' });
  let candidate = operations.length ? applyOperations(host.root, structuredClone(snapshot), operations) : snapshot;
  const samples: Array<{ sceneId: string; frame: number }> = [];
  for (const action of request.actions) {
    if (action.action !== 'assign') continue;
    const scene = candidate.scenes.find((s) => s.id === action.sceneId);
    if (!scene) throw new VmotionError('NOT_FOUND', `Scene ${action.sceneId} not found`);
    const step: Operation[] = [];
    for (const nodeId of action.nodeIds) {
      const node = scene.nodes.find((n) => n.id === nodeId);
      if (!node) throw new VmotionError('NOT_FOUND', `Layer ${nodeId} not found in ${scene.id}`);
      if (node.type !== 'text' && node.type !== 'component')
        throw new VmotionError('GLYPH_TARGET', 'Glyph sets apply to text layers (or caption components)', { nodeId });
      const patch: Partial<Node> =
        node.type === 'text'
          ? action.glyphSet === null
            ? { glyphSet: null }
            : { glyphSet: action.glyphSet, ...(action.fallback ? { glyphFallback: action.fallback } : {}) }
          : { params: { ...node.params, glyphSet: action.glyphSet ?? '', ...(action.fallback ? { glyphFallback: action.fallback } : {}) } };
      step.push({ type: 'updateNode', sceneId: scene.id, nodeId, patch });
    }
    candidate = applyOperations(host.root, candidate, step);
    operations.push(...step);
    summary.push({ action: 'assign', sceneId: scene.id, nodeIds: action.nodeIds, glyphSet: action.glyphSet });
    if (samples.length < 12 && !samples.some((s) => s.sceneId === scene.id)) samples.push({ sceneId: scene.id, frame: 0 });
  }
  if (!operations.length) return { baseRevision: snapshot.revision, unchanged: true, summary };
  const diagnostics = await validateSnapshot(host.root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Glyph candidate is invalid', diagnostics);
  // Re-resolve against the candidate to report broken glyphs and render the preview.
  let preview: Record<string, unknown> | undefined, broken: string[] = [];
  const set = target ? new GlyphSetResolver(0).tryResolve(candidate, target) : undefined;
  if (set) {
    broken = Object.keys(set.document.glyphs).filter((c) => isGlyphProblem(set.composer.glyph(c)));
    const text = request.preview ?? [...touchedChars].join('');
    if (text) preview = { ...(await writePreview(host.root, set.document, previewItems(set, text), request.previewSize, inline)), mimeType: 'image/png' };
  }
  const input = {
      revision: snapshot.revision,
      operations,
      samples,
      width: 320,
      determinism: false,
      visual: samples.length > 0,
    },
    plan = await storeAgentPlan(host.root, input);
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    summary,
    ...(target ? { file: glyphSetFile(target) } : {}),
    ...(set ? { glyphs: Object.keys(set.document.glyphs).length, components: Object.keys(set.document.components).length } : {}),
    ...(broken.length ? { brokenGlyphs: broken.slice(0, 50), brokenTotal: broken.length } : {}),
    warnings: diagnostics.filter((d) => d.severity === 'warning' && d.code.startsWith('GLYPH')).map((d) => d.message),
    ...(preview ?? {}),
    plan: { planId: plan.planId, bytes: plan.bytes },
    candidate: { planId: plan.planId },
    apply: { planId: plan.planId, expectedCandidateRevision: candidate.revision },
  };
}

/** Pure composition helper for SDK users and tests. */
export function composeWithSet(document: GlyphSetDocument, char: string) {
  return new GlyphComposer(document).glyph(char);
}
