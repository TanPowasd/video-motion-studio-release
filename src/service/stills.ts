import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { createCanvas, type Canvas } from '@napi-rs/canvas';
import { z } from 'zod';
import {
  VmotionError,
  sceneSchema,
  type Operation,
  type Scene,
  type Snapshot,
} from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import type { CompositionDraft } from '../core/interaction.js';
import {
  STILL_MAX_PIXELS,
  STILL_MAX_SIDE,
  alignDrafts,
  alignModes,
  findStillPreset,
  renderSizeIssue,
  stillGuides,
  stillPresetIds,
  stillPresets,
  stillSchema,
  stillTemplateIds,
  stillTemplateNodes,
  stillTemplates,
  stillVariantSchema,
  type AlignMode,
  type StillSettings,
} from '../core/still.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
import { atomicWrite, validateSnapshot } from './project.js';

const sceneId = z.string().min(1).max(200);
const side = z.number().int().min(16).max(STILL_MAX_SIDE);
const stillFields = {
  preset: z.enum(stillPresetIds).optional(),
  width: side.optional(),
  height: side.optional(),
  background: z.string().min(1).max(200).optional(),
  dpi: z.number().int().min(36).max(2400).optional(),
  bleed: z.number().finite().min(0).max(1024).optional(),
  safeArea: z.number().finite().min(0).max(4096).optional(),
  transparent: z.boolean().optional(),
};
const actionSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('create'),
      sceneId: sceneId.regex(/^[\w-]+$/, 'Scene ID may contain letters, digits, _ and -').optional(),
      name: z.string().min(1).max(120).default('图片 1'),
      template: z.enum(stillTemplateIds).default('blank'),
      variants: z.array(stillVariantSchema).max(16).optional(),
      ...stillFields,
    })
    .strict(),
  z
    .object({
      action: z.literal('update'),
      sceneId,
      name: z.string().min(1).max(120).optional(),
      ...stillFields,
    })
    .strict(),
  z
    .object({
      action: z.literal('unmark'),
      sceneId,
      duration: z.number().int().positive().max(1_000_000),
    })
    .strict(),
  z
    .object({
      action: z.literal('variants'),
      sceneId,
      variants: z.array(stillVariantSchema).max(16),
    })
    .strict(),
  z
    .object({
      action: z.literal('align'),
      sceneId,
      nodeIds: z.array(z.string().min(1).max(400)).min(1).max(200),
      mode: z.enum(alignModes as [AlignMode, ...AlignMode[]]),
      relativeTo: z.enum(['selection', 'canvas', 'trim', 'safe']).optional(),
      path: z.array(z.string()).max(32).default([]),
    })
    .strict(),
]);
export const stillPlanSchema = z
  .object({
    revision: z.string().optional(),
    actions: z.array(actionSchema).min(1).max(16),
  })
  .strict();
export const stillInspectSchema = z
  .object({
    sceneId: sceneId.optional(),
    presets: z.boolean().default(false),
    templates: z.boolean().default(false),
  })
  .strict();
export const imageExportSchema = z
  .object({
    sceneId: sceneId.optional(),
    revision: z.string().optional(),
    planId: z.string().optional(),
    format: z.enum(['png', 'jpeg', 'webp']).default('png'),
    quality: z.number().int().min(1).max(100).default(92),
    scale: z.number().finite().min(0.1).max(4).default(1),
    transparent: z.boolean().optional(),
    trim: z.boolean().default(false),
    variants: z
      .union([z.literal('all'), z.array(z.string().min(1).max(200)).max(16)])
      .optional(),
    main: z.boolean().default(true),
    dpi: z.number().int().min(36).max(2400).optional(),
    output: z.string().max(4096).optional(),
    preview: z
      .object({ maxSide: z.number().int().min(32).max(1024).default(320) })
      .strict()
      .optional(),
  })
  .strict();

type Host = {
  root: string;
  renderer: Renderer;
  edit: (
    snapshot: Snapshot,
    sceneId: string,
    frame: number,
    edits: CompositionDraft[],
  ) => Promise<Operation[]>;
};

const stillScenes = (snapshot: Snapshot) => snapshot.scenes.filter((s) => s.still);
function resolveStillScene(snapshot: Snapshot, id?: string): Scene {
  const scene = id
    ? snapshot.scenes.find((s) => s.id === id)
    : (stillScenes(snapshot)[0] ??
      (snapshot.project.kind === 'still' ? snapshot.scenes[0] : undefined));
  if (!scene)
    throw new VmotionError(
      id ? 'MISSING_SCENE' : 'NO_STILL',
      id ? 'Scene not found' : 'No still scene; pass sceneId or create one with still_plan',
      { sceneId: id },
    );
  return scene;
}
function describeStill(snapshot: Snapshot, scene: Scene) {
  const g = stillGuides(scene, snapshot.project);
  return {
    sceneId: scene.id,
    name: scene.name,
    width: g.width,
    height: g.height,
    background: scene.background,
    nodes: scene.nodes.length,
    still: g.still,
    trim: g.trim,
    safe: g.safe,
    pixels: g.width * g.height,
  };
}

export function inspectStills(snapshot: Snapshot, raw: unknown) {
  const request = stillInspectSchema.parse(raw);
  const scenes = request.sceneId
    ? [resolveStillScene(snapshot, request.sceneId)]
    : stillScenes(snapshot);
  return {
    revision: snapshot.revision,
    projectKind: snapshot.project.kind ?? 'video',
    stills: scenes.map((scene) => ({
      ...describeStill(snapshot, scene),
      isStill: !!scene.still,
    })),
    otherScenes: request.sceneId
      ? undefined
      : snapshot.scenes.filter((s) => !s.still).length,
    budget: {
      maxSide: STILL_MAX_SIDE,
      maxPixels: STILL_MAX_PIXELS,
      formats: ['png', 'jpeg', 'webp'],
    },
    ...(request.presets ? { presets: stillPresets } : { presetIds: stillPresetIds }),
    ...(request.templates
      ? { templates: stillTemplates }
      : { templateIds: stillTemplates.map((t) => t.id) }),
  };
}

function settingsFrom(
  base: Partial<StillSettings> | undefined,
  fields: z.infer<typeof actionSchema> & { action: 'create' | 'update' },
) {
  const preset = findStillPreset(fields.preset);
  return stillSchema.parse({
    ...(base ?? {}),
    ...(preset
      ? { preset: preset.id, dpi: preset.dpi, bleed: preset.bleed, safeArea: preset.safeArea }
      : {}),
    ...(fields.dpi !== undefined ? { dpi: fields.dpi } : {}),
    ...(fields.bleed !== undefined ? { bleed: fields.bleed } : {}),
    ...(fields.safeArea !== undefined ? { safeArea: fields.safeArea } : {}),
    ...(fields.transparent !== undefined ? { transparent: fields.transparent } : {}),
    ...(fields.width !== undefined || fields.height !== undefined
      ? fields.preset
        ? {}
        : { preset: undefined }
      : {}),
  });
}
const animatedNodes = (scene: Scene) =>
  scene.nodes.filter(
    (n) => n.animations.length || n.animationLayers?.length || n.textMotion || n.motionPath,
  ).length;

export async function planStill(host: Host, snapshot: Snapshot, raw: unknown) {
  const request = stillPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before still planning');
  let candidate = structuredClone(snapshot);
  const operations: Operation[] = [],
    summary: Record<string, unknown>[] = [],
    warnings: string[] = [],
    touched = new Set<string>();
  const push = (step: Operation[]) => {
    if (!step.length) return;
    candidate = applyOperations(host.root, candidate, step);
    operations.push(...step);
  };
  for (const action of request.actions) {
    if (action.action === 'create') {
      const preset = findStillPreset(action.preset),
        width = action.width ?? preset?.width ?? 1080,
        height = action.height ?? preset?.height ?? 1080,
        id = action.sceneId ?? `still-${randomUUID().slice(0, 8)}`;
      if (candidate.scenes.some((s) => s.id === id))
        throw new VmotionError('STILL_SCENE', 'Scene ID already exists', { sceneId: id });
      const still = settingsFrom(undefined, action);
      if (action.variants) still.variants = action.variants;
      const content = stillTemplateNodes(action.template, width, height, still),
        scene = sceneSchema.parse({
          id,
          name: action.name,
          duration: 1,
          width,
          height,
          background: action.background ?? content.background,
          nodes: content.nodes,
          still,
        });
      push([{ type: 'addScene', scene }]);
      touched.add(id);
      summary.push({
        action: 'create',
        sceneId: id,
        width,
        height,
        template: action.template,
        preset: still.preset,
        layers: scene.nodes.length,
      });
    } else if (action.action === 'update') {
      const scene = resolveStillScene(candidate, action.sceneId),
        preset = findStillPreset(action.preset),
        wasStill = !!scene.still,
        still = settingsFrom(scene.still ?? undefined, action);
      const patch: Partial<Scene> = {
        still,
        duration: 1,
        ...(action.name ? { name: action.name } : {}),
        ...(action.background ? { background: action.background } : {}),
        ...(action.width ?? preset?.width ? { width: action.width ?? preset!.width } : {}),
        ...(action.height ?? preset?.height ? { height: action.height ?? preset!.height } : {}),
      };
      if (!wasStill && scene.duration > 1) {
        const animated = animatedNodes(scene);
        warnings.push(
          `${scene.name}: became a 1-frame still; ${animated} animated top-level layer(s) now show frame 0`,
        );
      }
      push([{ type: 'updateScene', sceneId: scene.id, patch }]);
      touched.add(scene.id);
      summary.push({
        action: 'update',
        sceneId: scene.id,
        marked: !wasStill,
        width: patch.width ?? scene.width ?? candidate.project.width,
        height: patch.height ?? scene.height ?? candidate.project.height,
      });
    } else if (action.action === 'unmark') {
      const scene = resolveStillScene(candidate, action.sceneId);
      if (!scene.still)
        throw new VmotionError('NOT_STILL', 'Scene is not a still', { sceneId: scene.id });
      const issue = renderSizeIssue(
        scene.width ?? candidate.project.width,
        scene.height ?? candidate.project.height,
        false,
      );
      if (issue)
        throw new VmotionError(
          'SCENE_SIZE',
          `Resize the artboard before converting it to an animated scene: ${issue}`,
          { sceneId: scene.id },
        );
      push([
        {
          type: 'updateScene',
          sceneId: scene.id,
          patch: { still: null, duration: action.duration } as Partial<Scene>,
        },
      ]);
      touched.add(scene.id);
      summary.push({ action: 'unmark', sceneId: scene.id, duration: action.duration });
    } else if (action.action === 'variants') {
      const scene = resolveStillScene(candidate, action.sceneId);
      if (!scene.still)
        throw new VmotionError('NOT_STILL', 'Mark the scene as a still first', {
          sceneId: scene.id,
        });
      push([
        {
          type: 'updateScene',
          sceneId: scene.id,
          patch: { still: stillSchema.parse({ ...scene.still, variants: action.variants }) },
        },
      ]);
      touched.add(scene.id);
      summary.push({
        action: 'variants',
        sceneId: scene.id,
        variants: action.variants.map((v) => `${v.id} ${v.width}×${v.height} ${v.fit}`),
      });
    } else {
      const scene = resolveStillScene(candidate, action.sceneId);
      const graph = await host.renderer.inspectInteractions(candidate, scene.id, 0, action.path);
      const missing = action.nodeIds.filter((id) => !graph.layers.some((l) => l.node.id === id));
      if (missing.length)
        throw new VmotionError('NOT_FOUND', 'Align targets are not visible layers', { missing });
      const g = stillGuides(scene, candidate.project),
        relative =
          action.relativeTo ?? (action.nodeIds.length > 1 ? 'selection' : 'safe'),
        reference =
          relative === 'selection'
            ? 'selection'
            : relative === 'canvas'
              ? g.canvas
              : relative === 'trim'
                ? g.trim
                : g.safe;
      if (action.path.length && relative !== 'selection')
        warnings.push('Artboard references use scene coordinates; nested paths align in their local scope');
      const drafts = alignDrafts(graph.layers, action.nodeIds, action.mode, reference, 0);
      if (drafts.length) push(await host.edit(candidate, scene.id, 0, drafts));
      touched.add(scene.id);
      summary.push({
        action: 'align',
        sceneId: scene.id,
        mode: action.mode,
        relativeTo: relative,
        moved: drafts.map((d) => d.nodeId),
      });
    }
  }
  if (!operations.length)
    return {
      baseRevision: snapshot.revision,
      unchanged: true,
      summary,
      warnings,
    };
  const diagnostics = await validateSnapshot(host.root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Still candidate is invalid', diagnostics);
  const samples = [...touched]
      .filter((id) => candidate.scenes.some((s) => s.id === id))
      .slice(0, 12)
      .map((id) => ({ sceneId: id, frame: 0 })),
    input = {
      revision: snapshot.revision,
      operations,
      samples,
      width: 320,
      determinism: false,
      visual: true,
    },
    plan = await storeAgentPlan(host.root, input);
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    summary,
    warnings,
    plan: { planId: plan.planId, bytes: plan.bytes },
    candidate: { planId: plan.planId },
    apply: { planId: plan.planId, expectedCandidateRevision: candidate.revision },
  };
}

/* ---------- export ---------- */

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
function crc32(buffer: Buffer) {
  let c = 0xffffffff;
  for (const byte of buffer) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
/** Insert/replace a PNG pHYs chunk (pixels per metre) right after IHDR. */
export function pngWithDpi(png: Buffer, dpi: number) {
  if (png.readUInt32BE(12) !== 0x49484452) return png;
  const ihdrEnd = 8 + 12 + png.readUInt32BE(8),
    ppm = Math.round(dpi / 0.0254),
    data = Buffer.alloc(13);
  data.write('pHYs', 0, 'latin1');
  data.writeUInt32BE(ppm, 4);
  data.writeUInt32BE(ppm, 8);
  data[12] = 1;
  const chunk = Buffer.alloc(21);
  chunk.writeUInt32BE(9, 0);
  data.copy(chunk, 4);
  chunk.writeUInt32BE(crc32(data), 17);
  const parts: Buffer[] = [png.subarray(0, ihdrEnd), chunk];
  let at = ihdrEnd;
  while (at < png.length) {
    const length = png.readUInt32BE(at),
      type = png.toString('latin1', at + 4, at + 8),
      end = at + 12 + length;
    if (type !== 'pHYs') parts.push(png.subarray(at, end));
    at = end;
  }
  return Buffer.concat(parts);
}
/** Write JFIF density (dots per inch) into an existing APP0 segment, inserting one if absent. */
export function jpegWithDpi(jpeg: Buffer, dpi: number) {
  const value = Math.min(65535, Math.round(dpi));
  if (jpeg[2] === 0xff && jpeg[3] === 0xe0 && jpeg.toString('latin1', 6, 11) === 'JFIF\0') {
    const out = Buffer.from(jpeg);
    out[13] = 1;
    out.writeUInt16BE(value, 14);
    out.writeUInt16BE(value, 16);
    return out;
  }
  const app0 = Buffer.from([
    0xff, 0xe0, 0, 16, 0x4a, 0x46, 0x49, 0x46, 0, 1, 1, 1, value >> 8, value & 255, value >> 8,
    value & 255, 0, 0,
  ]);
  return Buffer.concat([jpeg.subarray(0, 2), app0, jpeg.subarray(2)]);
}
/** Read back the DPI written by pngWithDpi/jpegWithDpi (used by tests and reports). */
export function readImageDpi(buffer: Buffer): number | undefined {
  if (buffer.readUInt32BE(0) === 0x89504e47) {
    let at = 8;
    while (at < buffer.length) {
      const length = buffer.readUInt32BE(at),
        type = buffer.toString('latin1', at + 4, at + 8);
      if (type === 'pHYs' && buffer[at + 16] === 1)
        return Math.round(buffer.readUInt32BE(at + 8) * 0.0254);
      if (type === 'IDAT') return undefined;
      at += 12 + length;
    }
  }
  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer.toString('latin1', 6, 11) === 'JFIF\0')
    return buffer[13] === 1 ? buffer.readUInt16BE(14) : undefined;
  return undefined;
}

function crop(source: Canvas, x: number, y: number, width: number, height: number) {
  const out = createCanvas(width, height);
  out.getContext('2d').putImageData(source.getContext('2d').getImageData(x, y, width, height), 0, 0);
  return out;
}
const fileSafe = (value: string) =>
  value.replace(/[<>:"/\\|?*\x00-\x1f]+/g, '-').replace(/[. ]+$/, '').slice(0, 80) || 'image';
const extension = { png: 'png', jpeg: 'jpg', webp: 'webp' } as const;

type ExportItem = {
  variant: string;
  name: string;
  width: number;
  height: number;
  render: () => Promise<Canvas>;
};

/**
 * Render a still (and optional size variants) through the same native renderer as preview and
 * encode it. Scale re-renders vectors/text at the target resolution; transparency omits the scene
 * background; trim removes bleed. Over-budget sizes fail with RESOLUTION instead of shrinking.
 */
export async function exportStill(host: Pick<Host, 'root' | 'renderer'>, snapshot: Snapshot, raw: unknown) {
  const request = imageExportSchema.parse(raw);
  const scene = resolveStillScene(snapshot, request.sceneId),
    g = stillGuides(scene, snapshot.project),
    warnings: string[] = [];
  if (!scene.still) warnings.push('Scene is not marked as a still; frame 0 was exported');
  let transparent = request.transparent ?? g.still.transparent;
  if (transparent && request.format === 'jpeg') {
    warnings.push('JPEG has no alpha channel; the scene background was kept');
    transparent = false;
  }
  const scale = request.scale,
    working: Snapshot = transparent
      ? {
          ...snapshot,
          scenes: snapshot.scenes.map((s) =>
            s.id === scene.id ? { ...s, background: 'transparent' } : s,
          ),
        }
      : snapshot,
    check = (width: number, height: number) => {
      const issue = renderSizeIssue(width, height, true);
      if (issue) throw new VmotionError('RESOLUTION', issue, { width, height, scale });
    },
    renderScene = async (snap: Snapshot, width: number, height: number) => {
      check(width, height);
      return host.renderer.render(snap, 0, { sceneId: scene.id, width, height });
    };
  const items: ExportItem[] = [];
  if (request.main) {
    const width = Math.round(g.width * scale),
      height = Math.round(g.height * scale),
      bleed = request.trim ? Math.round(g.still.bleed * scale) : 0;
    if (request.trim && !g.still.bleed) warnings.push('Artboard has no bleed; trim had no effect');
    items.push({
      variant: 'main',
      name: scene.name,
      width: width - 2 * bleed,
      height: height - 2 * bleed,
      render: async () => {
        const full = await renderScene(working, width, height);
        if (!bleed) return full;
        try {
          return crop(full, bleed, bleed, width - 2 * bleed, height - 2 * bleed);
        } finally {
          full.width = full.height = 1;
        }
      },
    });
  }
  const requested =
    request.variants === 'all'
      ? g.still.variants
      : (request.variants ?? []).map((id) => {
          const variant = g.still.variants.find((v) => v.id === id);
          if (!variant) throw new VmotionError('NOT_FOUND', 'Unknown still variant', { id });
          return variant;
        });
  if (request.trim && requested.length)
    warnings.push('trim applies to the main artboard only; variants use their own sizes');
  for (const variant of requested) {
    const width = Math.round(variant.width * scale),
      height = Math.round(variant.height * scale);
    items.push({
      variant: variant.id,
      name: `${scene.name}-${variant.name}`,
      width,
      height,
      render: async () => {
        check(width, height);
        if (variant.fit === 'reflow') {
          const reflowed = {
            ...working,
            scenes: working.scenes.map((s) =>
              s.id === scene.id ? { ...s, width: variant.width, height: variant.height } : s,
            ),
          };
          return renderScene(reflowed, width, height);
        }
        const k =
            variant.fit === 'cover'
              ? Math.max(width / g.width, height / g.height)
              : Math.min(width / g.width, height / g.height),
          innerWidth = Math.max(16, Math.round(g.width * k)),
          innerHeight = Math.max(16, Math.round(g.height * k)),
          inner = await renderScene(working, innerWidth, innerHeight),
          out = createCanvas(width, height),
          ctx = out.getContext('2d');
        try {
          if (!transparent) {
            ctx.fillStyle = variant.background ?? scene.background;
            ctx.fillRect(0, 0, width, height);
          }
          ctx.drawImage(
            inner,
            Math.round((width - innerWidth) / 2),
            Math.round((height - innerHeight) / 2),
          );
        } finally {
          inner.width = inner.height = 1;
        }
        return out;
      },
    });
  }
  if (!items.length) throw new VmotionError('TOOL_ARGUMENTS', 'Nothing to export: main=false and no variants');
  if (items.length > 17) throw new VmotionError('TOOL_ARGUMENTS', 'Too many images');
  const dpi = Math.round((request.dpi ?? g.still.dpi) * (request.dpi ? 1 : scale));
  const ext = extension[request.format],
    many = items.length > 1,
    target = request.output ? path.resolve(host.root, request.output) : undefined,
    single = !!target && !many && /\.(png|jpe?g|webp)$/i.test(target),
    directory = single ? path.dirname(target!) : (target ?? path.join(host.root, 'exports', 'images'));
  const images = [];
  for (const item of items) {
    const canvas = await item.render();
    try {
      if (request.preview) {
        const k = Math.min(1, request.preview.maxSide / Math.max(canvas.width, canvas.height)),
          w = Math.max(1, Math.round(canvas.width * k)),
          h = Math.max(1, Math.round(canvas.height * k)),
          thumb = createCanvas(w, h);
        thumb.getContext('2d').drawImage(canvas, 0, 0, w, h);
        images.push({
          variant: item.variant,
          width: canvas.width,
          height: canvas.height,
          dataUrl: `data:image/png;base64,${(await thumb.encode('png')).toString('base64')}`,
        });
        continue;
      }
      const rgba = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
      let buffer: Buffer =
        request.format === 'png'
          ? await canvas.encode('png')
          : request.format === 'jpeg'
            ? await canvas.encode('jpeg', request.quality)
            : await canvas.encode('webp', request.quality);
      let dpiWritten: number | undefined;
      if (request.format === 'png') buffer = pngWithDpi(buffer, (dpiWritten = dpi));
      else if (request.format === 'jpeg') buffer = jpegWithDpi(buffer, (dpiWritten = dpi));
      const file = single
        ? target!
        : path.join(
            directory,
            `${fileSafe(item.name)}${scale !== 1 ? `@${scale}x` : ''}${request.trim && item.variant === 'main' && g.still.bleed ? '-trim' : ''}.${ext}`,
          );
      await mkdir(path.dirname(file), { recursive: true });
      await atomicWrite(file, buffer);
      images.push({
        variant: item.variant,
        path: file,
        format: request.format,
        width: canvas.width,
        height: canvas.height,
        bytes: buffer.length,
        dpi: dpiWritten ?? null,
        transparent: transparent && request.format !== 'jpeg',
        pixelHash: createHash('sha256').update(rgba).digest('hex').slice(0, 16),
      });
    } finally {
      canvas.width = canvas.height = 1;
    }
  }
  if (request.format === 'webp' && !request.preview)
    warnings.push('WebP files carry no DPI metadata; pixel size is exact');
  if (request.format !== 'png' && !request.preview)
    warnings.push(`${request.format.toUpperCase()} is lossy at quality ${request.quality}; use PNG for pixel-exact output`);
  return {
    revision: snapshot.revision,
    sceneId: scene.id,
    scale,
    images,
    ...(warnings.length ? { warnings } : {}),
  };
}
