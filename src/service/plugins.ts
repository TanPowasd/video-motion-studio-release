import { z } from 'zod';
import {
  PluginRegistry,
  pluginDigest,
  pluginContentDigest,
  builtinPluginVersions,
  type PluginEntry,
} from '../core/plugins.js';
import { pluginPathSchema, pluginIdSchema, pluginManifestSchema } from '../core/plugin-schema.js';
import { resolveParameters, type ParameterDefinitions } from '../core/parameters.js';
import { newNode, VmotionError, type Snapshot, type Operation } from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { fileEditSchema } from '../core/file-edits.js';
import { applyOperations } from './operations.js';
import { preflightSchema } from './preflight.js';
import { storeAgentPlan } from './agent-plans.js';
import type { PluginContext } from '../sdk/plugins.js';
export const pluginContextSchema = z
  .object({
    sceneIds: z.array(z.string()).max(16).default([]),
    sequenceIds: z.array(z.string()).max(8).default([]),
    files: z.array(pluginPathSchema).max(64).default([]),
  })
  .strict()
  .default({});
export const pluginInspectSchema = z
  .object({
    id: pluginIdSchema.optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(50).default(16),
    includeManifest: z.boolean().default(false),
  })
  .strict();
export const pluginPackageSchema = z
  .object({
    id: pluginIdSchema,
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(24),
    includeHashes: z.boolean().default(true),
  })
  .strict();
export const pluginPlanSchema = z
  .object({
    revision: z.string(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    samples: preflightSchema.shape.samples.optional(),
    files: z.array(fileEditSchema).max(256).default([]),
    actions: z
      .array(
        z.discriminatedUnion('type', [
          z
            .object({
              type: z.literal('register'),
              source: pluginPathSchema,
              enabled: z.boolean().default(true),
              pin: z.boolean().default(false),
            })
            .strict(),
          z
            .object({
              type: z.literal('toggle'),
              id: pluginIdSchema,
              enabled: z.boolean(),
              pin: z.boolean().optional(),
            })
            .strict(),
          z.object({ type: z.literal('remove'), id: pluginIdSchema }).strict(),
        ]),
      )
      .max(128)
      .default([]),
    placements: z
      .array(
        z
          .object({
            pluginId: pluginIdSchema,
            contributionId: z.string(),
            sceneId: z.string(),
            nodeId: z.string(),
            x: z.number().finite().default(0),
            y: z.number().finite().default(0),
            width: z.number().positive().optional(),
            height: z.number().positive().optional(),
            params: z.record(z.unknown()).default({}),
          })
          .strict(),
      )
      .max(128)
      .default([]),
  })
  .strict();
const metadata = (e: PluginEntry) => ({
  id: e.manifest.id,
  name: e.manifest.name,
  version: e.manifest.version,
  hash: e.hash,
  manifestHash: e.manifestHash,
  contentHash: e.hash,
  files: e.files.length,
  enabled: e.enabled,
  source: e.source,
  tools: e.manifest.tools.length,
  contributions: e.manifest.contributions.length,
  dependencies: e.manifest.dependencies,
});
export function inspectPlugins(
  registry: PluginRegistry,
  snapshot: Snapshot,
  raw: unknown,
  builtins: Record<
    string,
    {
      name: string;
      tools: string[];
      migration?: {
        runtime: string;
        moduleTools: number;
        hostTools: number;
        dependencies: Record<string, string>;
      };
    }
  >,
) {
  const p = pluginInspectSchema.parse(raw),
    entries = registry.resolve(snapshot),
    project = entries.map((e) => ({ ...metadata(e), origin: 'project', runtime: 'worker' })),
    builtin = Object.entries(builtins).map(([id, v]) => ({
      id,
      name: v.name,
      version: builtinPluginVersions[id],
      origin: 'builtin',
      runtime: v.migration?.runtime ?? 'host',
      moduleTools: v.migration?.moduleTools ?? 0,
      hostTools: v.migration?.hostTools ?? v.tools.length,
      enabled: true,
      tools: v.tools.length,
    })),
    items = [...builtin, ...project].filter((e) => !p.id || e.id === p.id);
  if (p.id && !items.length)
    throw new VmotionError('PLUGIN_NOT_FOUND', 'Plugin is not registered', { id: p.id });
  const selected = entries.find((e) => e.manifest.id === p.id);
  return {
    revision: snapshot.revision,
    total: items.length,
    items: items.slice(p.offset, p.offset + p.limit),
    nextOffset: p.offset + p.limit < items.length ? p.offset + p.limit : undefined,
    ...(selected
      ? {
          tools: selected.manifest.tools.map((t) => ({
            id: t.id,
            name: pluginToolName(selected.manifest.id, t.id),
            description: t.description,
            mode: t.mode,
            categories: t.categories,
          })),
          contributions: selected.manifest.contributions,
          ...(p.includeManifest ? { manifest: selected.manifest } : {}),
        }
      : {}),
    ...(p.id && builtins[p.id]
      ? {
          capabilities: builtins[p.id].tools,
          dependencies: builtins[p.id].migration?.dependencies ?? {},
        }
      : {}),
    cache: registry.report(),
  };
}
export function packagePlugin(registry: PluginRegistry, snapshot: Snapshot, raw: unknown) {
  const p = pluginPackageSchema.parse(raw),
    entry = registry.resolve(snapshot).find((candidate) => candidate.manifest.id === p.id);
  if (!entry)
    throw new VmotionError('PLUGIN_NOT_FOUND', 'Project plugin is not registered', { id: p.id });
  const files = entry.files.map((file) => ({
    path: file,
    bytes: Buffer.byteLength(snapshot.files[file] ?? ''),
    ...(p.includeHashes ? { hash: pluginDigest(snapshot.files[file] ?? '') } : {}),
  }));
  return {
    id: entry.manifest.id,
    name: entry.manifest.name,
    version: entry.manifest.version,
    enabled: entry.enabled,
    source: entry.source,
    manifestHash: entry.manifestHash,
    contentHash: entry.hash,
    dependencies: entry.manifest.dependencies,
    totalFiles: files.length,
    totalBytes: files.reduce((sum, file) => sum + file.bytes, 0),
    files: files.slice(p.offset, p.offset + p.limit),
    nextOffset: p.offset + p.limit < files.length ? p.offset + p.limit : undefined,
    packageDigest: pluginDigest(files.map((file) => `${file.path}\0${file.hash ?? ''}`).join('\0')),
    delivery: 'metadata',
  };
}
export const pluginToolName = (pluginId: string, toolId: string) =>
  'plugin.' + pluginId + '.' + toolId;
export function pluginCatalog(registry: PluginRegistry, snapshot: Snapshot, ifHash?: string) {
  const entries = registry.resolve(snapshot),
    hash = pluginDigest(JSON.stringify(entries.map((e) => [e.source, e.hash, e.enabled])));
  if (hash === ifHash) return { catalogHash: hash, notModified: true };
  return {
    catalogHash: hash,
    plugins: entries
      .filter((e) => e.enabled)
      .map((e) => ({
        id: e.manifest.id,
        version: e.manifest.version,
        hash: e.hash,
        tools: e.manifest.tools,
      })),
  };
}
export async function candidateResult(
  root: string,
  base: Snapshot,
  input: unknown,
  summary: Record<string, unknown> = {},
  delivery = 'stored',
) {
  const p = preflightSchema.parse(input),
    operations: Operation[] = [
      ...p.operations,
      ...(p.files.length ? [{ type: 'editFiles' as const, edits: p.files }] : []),
    ],
    candidate = applyOperations(root, base, operations),
    stored = delivery === 'stored' ? await storeAgentPlan(root, p) : undefined;
  return {
    baseRevision: base.revision,
    candidateRevision: candidate.revision,
    summary,
    operationCount: p.operations.length,
    fileCount: p.files.length,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : p,
    apply: {
      ...(stored ? { planId: stored.planId } : p),
      expectedCandidateRevision: candidate.revision,
    },
  };
}
export async function planPlugins(
  root: string,
  registry: PluginRegistry,
  base: Snapshot,
  raw: unknown,
) {
  const p = pluginPlanSchema.parse(raw);
  if (p.revision !== base.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before plugin planning');
  let candidate = p.files.length
      ? applyOperations(root, base, [{ type: 'editFiles', edits: p.files }])
      : structuredClone(base),
    registrations = [...(base.project.plugins ?? [])];
  for (const action of p.actions) {
    if (action.type === 'register') {
      if (!action.source.endsWith('.json') || candidate.files[action.source] === undefined)
        throw new VmotionError('PLUGIN_SOURCE', 'Registration needs a manifest JSON file', {
          file: action.source,
        });
      if (registrations.some((r) => r.source === action.source))
        throw new VmotionError(
          'PLUGIN_ID',
          'Source already registered; toggle or update it explicitly',
          { file: action.source },
        );
      registrations.push({
        source: action.source,
        enabled: action.enabled,
        ...(action.pin
          ? {
              contentHash: pluginContentDigest(
                candidate,
                action.source,
                pluginManifestSchema.parse(JSON.parse(candidate.files[action.source])),
              ),
            }
          : {}),
      });
    } else {
      const index = registrations.findIndex(
        (r) =>
          pluginManifestSchema.parse(JSON.parse(base.files[r.source] ?? candidate.files[r.source]))
            .id === action.id,
      );
      if (index < 0)
        throw new VmotionError('PLUGIN_NOT_FOUND', 'Plugin is not registered', { id: action.id });
      if (action.type === 'remove') registrations.splice(index, 1);
      else {
        const { hash, contentHash, ...old } = registrations[index];
        registrations[index] = {
          ...old,
          enabled: action.enabled,
          ...(action.pin === true
            ? {
                contentHash: pluginContentDigest(
                  candidate,
                  old.source,
                  pluginManifestSchema.parse(JSON.parse(candidate.files[old.source])),
                ),
              }
            : action.pin === false
              ? {}
              : { ...(hash ? { hash } : {}), ...(contentHash ? { contentHash } : {}) }),
        };
      }
    }
  }
  const operations: Operation[] = [{ type: 'updateProject', patch: { plugins: registrations } }];
  candidate = applyOperations(root, candidate, operations);
  const entries = registry.resolve(candidate);
  for (const place of p.placements) {
    const entry = entries.find((e) => e.manifest.id === place.pluginId && e.enabled),
      resource = entry?.manifest.contributions.find((c) => c.id === place.contributionId);
    if (!entry || !resource)
      throw new VmotionError('PLUGIN_CONTRIBUTION', 'Enabled contribution is not available', {
        pluginId: place.pluginId,
        contributionId: place.contributionId,
      });
    if (resource.kind !== 'component')
      throw new VmotionError(
        'PLUGIN_CONTRIBUTION',
        'Use the contribution source with its matching effect/motion/theme/sound/template tool',
        { kind: resource.kind, source: resource.source },
      );
    operations.push({
      type: 'addNode',
      sceneId: place.sceneId,
      node: newNode({
        id: place.nodeId,
        type: 'component',
        name: resource.name,
        component: resource.source,
        x: place.x,
        y: place.y,
        width: place.width ?? candidate.project.width,
        height: place.height ?? candidate.project.height,
        params: place.params,
      }),
    });
  }
  const requested =
      p.samples ??
      (p.files.length
        ? candidate.scenes.flatMap((s) =>
            [0, Math.floor((s.duration - 1) / 2), Math.max(0, s.duration - 1)].map((frame) => ({
              sceneId: s.id,
              frame,
            })),
          )
        : p.placements.map((t) => ({ sceneId: t.sceneId, frame: 0 }))),
    unique = [...new Map(requested.map((s) => [JSON.stringify(s), s])).values()],
    samples = unique.slice(0, 12);
  return candidateResult(
    root,
    base,
    { revision: base.revision, files: p.files, operations, samples, determinism: true, width: 320 },
    {
      plugins: entries.map(metadata),
      placements: p.placements.length,
      sampleCoverage: {
        requested: unique.length,
        covered: samples.length,
        omitted: unique.length - samples.length,
        inferred: p.samples === undefined,
      },
      filesPreservedOnRemoval: true,
    },
    p.delivery,
  );
}
export async function callPluginTool(
  root: string,
  registry: PluginRegistry,
  renderer: Renderer,
  base: Snapshot,
  id: string,
  toolId: string,
  raw: any,
) {
  const entry = registry.resolve(base).find((e) => e.enabled && e.manifest.id === id),
    tool = entry?.manifest.tools.find((t) => t.id === toolId);
  if (!entry || !tool || !entry.manifest.entry)
    throw new VmotionError('PLUGIN_TOOL', 'Enabled plugin tool is not available', { id, toolId });
  const { revision, expectedPluginHash, _context, ...values } = raw;
  if (revision && revision !== base.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before plugin execution');
  if (expectedPluginHash && expectedPluginHash !== entry.hash)
    throw new VmotionError(
      'PLUGIN_CHANGED',
      'Plugin schema/release changed; rediscover before calling',
      { id, hash: entry.hash },
    );
  const requested = pluginContextSchema.parse(_context),
    parameters = resolveParameters(tool.parameters as ParameterDefinitions, values);
  if (
    (requested.sceneIds.length && !tool.reads.scenes) ||
    (requested.sequenceIds.length && !tool.reads.sequences) ||
    (requested.files.length && !tool.reads.files)
  )
    throw new VmotionError('PLUGIN_CONTEXT', 'Requested context exceeds the declared reads');
  const pick = <T extends { id: string }>(list: T[], ids: string[]) =>
    ids.map((id) => {
      const item = list.find((s) => s.id === id);
      if (!item) throw new VmotionError('PLUGIN_CONTEXT', 'Context ID is missing', { id });
      return item;
    });
  const { id: projectId, name, width, height, fps, sampleRate, activeSequence } = base.project;
  const context: PluginContext = {
    revision: base.revision,
    project: { id: projectId, name, width, height, fps, sampleRate, activeSequence },
    scenes: pick(base.scenes, requested.sceneIds),
    sequences: pick(base.sequences, requested.sequenceIds),
    assets: tool.reads.assets ? base.project.assets : [],
    files: Object.fromEntries(
      requested.files.map((file) => {
        if (base.files[file] === undefined)
          throw new VmotionError('PLUGIN_SOURCE', 'Context file is missing', { file });
        return [file, base.files[file]];
      }),
    ),
  };
  if (Buffer.byteLength(JSON.stringify(context)) > 8 * 1024 * 1024)
    throw new VmotionError(
      'PLUGIN_BUDGET',
      'Selected tool context exceeds 8MiB; choose fewer scopes/files',
    );
  const result = await renderer.components.callPlugin(
    base,
    entry.manifest.entry,
    toolId,
    context,
    parameters,
  );
  if (tool.mode === 'query') {
    if (
      result &&
      typeof result === 'object' &&
      ('operations' in result ||
        'files' in result ||
        'assetChecks' in result ||
        'samples' in result)
    )
      throw new VmotionError(
        'PLUGIN_MODE',
        'Query tools may return data only; declare mode=plan for candidate operations',
        { id, toolId },
      );
    if (Buffer.byteLength(JSON.stringify(result)) > 256 * 1024)
      throw new VmotionError(
        'PLUGIN_BUDGET',
        'Plugin query exceeds 256KiB; return paged/filtered results',
      );
    return {
      revision: base.revision,
      plugin: { id, version: entry.manifest.version, hash: entry.hash },
      result,
    };
  }
  const repeat = await renderer.components.callPlugin(
    base,
    entry.manifest.entry,
    toolId,
    context,
    parameters,
  );
  if (JSON.stringify(result) !== JSON.stringify(repeat))
    throw new VmotionError(
      'PLUGIN_NONDETERMINISTIC',
      'Plugin candidate changes for the same inputs',
      { id, toolId },
    );
  const plan = z
    .object({
      operations: preflightSchema.shape.operations,
      files: preflightSchema.shape.files,
      assetChecks: preflightSchema.shape.assetChecks,
      samples: preflightSchema.shape.samples,
      summary: z.record(z.unknown()).default({}),
    })
    .strict()
    .parse(result);
  if (Buffer.byteLength(JSON.stringify(plan.summary)) > 16 * 1024)
    throw new VmotionError('PLUGIN_BUDGET', 'Plugin candidate summary exceeds 16KiB');
  return candidateResult(
    root,
    base,
    {
      revision: base.revision,
      operations: plan.operations,
      files: plan.files,
      assetChecks: plan.assetChecks,
      samples: plan.samples,
      determinism: true,
      width: 320,
    },
    plan.summary,
  );
}
