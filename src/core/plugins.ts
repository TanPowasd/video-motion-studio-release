import { createHash } from 'node:crypto';
import { satisfies, validRange } from 'semver';
import { pluginManifestSchema, type PluginManifest } from './plugin-schema.js';
import { validateParameterDefinitions, type ParameterDefinitions } from './parameters.js';
import type { Snapshot, Diagnostic } from './model.js';
import { VmotionError } from './model.js';
import { GeometryCache } from './geometry-cache.js';
export const pluginDigest = (text: string) => createHash('sha256').update(text).digest('hex');
export const builtinPluginNames: Record<string, string> = Object.fromEntries(
  Object.entries({
    core: '工程与代码',
    animation: '属性、关键帧与组件控制',
    composition: '合成、图层与场景实例',
    effects: '视觉特效与动作模板',
    vector: '文字、矢量与重复器',
    drawing: '绘画文档与发布',
    media: '素材管理与媒体取证',
    editing: '剪辑、字幕与分镜',
    audio: '声音与音乐',
    '3d': '三维网格、材质与取证',
    math: '数学与矩阵几何',
    render: '渲染、性能与导出',
    recovery: '恢复与历史',
    design: '主题与版本模板',
    tracking: '运动跟踪与稳定',
    cache: '缓存与空间管理',
    review: '画面检查与修复',
    organization: '工程引用、素材与镜头组织',
  }).map(([id, name]) => ['vmotion.' + id, name]),
);
export const builtinPluginVersions: Record<string, string> = Object.fromEntries(
  [
    'core',
    'animation',
    'composition',
    'effects',
    'vector',
    'drawing',
    'media',
    'editing',
    'audio',
    '3d',
    'math',
    'render',
    'recovery',
    'design',
    'tracking',
    'cache',
    'review',
    'organization',
  ].map((id) => ['vmotion.' + id, '1.0.0']),
);
export function pluginVersionMatches(version: string, range: string) {
  if (!validRange(range))
    throw new VmotionError('PLUGIN_DEPENDENCY', 'Invalid semantic version range', { range });
  return satisfies(version, range);
}
export function pluginContentDigest(snapshot: Snapshot, source: string, manifest: PluginManifest) {
  const paths = new Set<string>([
    source,
    ...(manifest.entry ? [manifest.entry] : []),
    ...manifest.contributions.map((resource) => resource.source),
    ...manifest.files.map((file) => file.path),
  ]);
  const content = [...paths]
    .sort()
    .map((file) => {
      const text = snapshot.files[file];
      if (text === undefined)
        throw new VmotionError('PLUGIN_SOURCE', 'Plugin package file is missing', { file });
      return file + '\0' + text;
    })
    .join('\0');
  return pluginDigest(content);
}
export type PluginEntry = {
  source: string;
  hash: string;
  manifestHash: string;
  files: string[];
  enabled: boolean;
  manifest: PluginManifest;
  metadataWarnings: Diagnostic[];
};
// Manifests are cached by their exact source text; dependency validity is always rechecked.
export class PluginRegistry {
  private readonly cache: GeometryCache<{ entry: PluginEntry; probes: Map<string, string> }>;
  readonly stats = { parses: 0, hits: 0, contentDigests: 0 };
  constructor(budgetBytes = 8 * 1024 * 1024) {
    this.cache = new GeometryCache(budgetBytes, 128);
  }
  resolve(snapshot: Snapshot): PluginEntry[] {
    const entries: PluginEntry[] = [],
      ids = new Set<string>(),
      paths = new Set<string>();
    for (const registration of snapshot.project.plugins ?? []) {
      const text = snapshot.files[registration.source];
      if (text === undefined)
        throw new VmotionError('PLUGIN_SOURCE', 'Registered plugin manifest is missing', {
          file: registration.source,
        });
      if (Buffer.byteLength(text) > 512 * 1024)
        throw new VmotionError('PLUGIN_BUDGET', 'Plugin manifest exceeds 512KiB');
      const old = this.cache.get(registration.source);
      let parsed: PluginEntry;
      if (old && [...old.probes].every(([file, source]) => snapshot.files[file] === source)) {
        this.stats.hits++;
        parsed = old.entry;
      } else {
        let manifest: PluginManifest;
        let metadataWarnings: Diagnostic[] = [];
        try {
          const raw: unknown = JSON.parse(text);
          manifest = pluginManifestSchema.parse(raw);
          if (raw && typeof raw === 'object' && 'tools' in raw && Array.isArray(raw.tools))
            metadataWarnings = raw.tools.flatMap((tool: unknown, index) =>
              tool && typeof tool === 'object' && (!('categories' in tool) || !('keywords' in tool))
                ? [
                    {
                      severity: 'warning' as const,
                      code: 'PLUGIN_METADATA_DEFAULTS',
                      message:
                        'Legacy tool metadata uses compatible defaults; add categories and keywords to the manifest.',
                      file: registration.source,
                      path: `/tools/${index}`,
                    },
                  ]
                : [],
            );
        } catch (e) {
          throw new VmotionError(
            'PLUGIN_MANIFEST',
            'Invalid plugin manifest: ' + (e as Error).message,
            { file: registration.source, issues: (e as { issues?: unknown }).issues },
          );
        }
        if (manifest.id === 'vmotion' || manifest.id.startsWith('vmotion.'))
          throw new VmotionError('PLUGIN_ID', 'Builtin plugin IDs are reserved', {
            id: manifest.id,
          });
        for (const tool of manifest.tools) {
          try {
            validateParameterDefinitions(tool.parameters as ParameterDefinitions);
          } catch (e) {
            throw new VmotionError('PLUGIN_PARAMETERS', (e as Error).message, {
              file: registration.source,
              toolId: tool.id,
              path: (e as { path?: string }).path,
            });
          }
          if (
            ['revision', '_context', 'expectedPluginHash'].some((p) =>
              Object.hasOwn(tool.parameters, p),
            )
          )
            throw new VmotionError(
              'PLUGIN_PARAMETERS',
              'Tool parameter uses a reserved host field',
              { toolId: tool.id },
            );
        }
        const manifestHash = pluginDigest(text),
          files = [
            ...new Set([
              registration.source,
              ...(manifest.entry ? [manifest.entry] : []),
              ...manifest.contributions.map((resource) => resource.source),
              ...manifest.files.map((file) => file.path),
            ]),
          ],
          contentHash = pluginContentDigest(snapshot, registration.source, manifest);
        for (const file of manifest.files) {
          const actual = pluginDigest(snapshot.files[file.path] ?? '');
          if (snapshot.files[file.path] === undefined)
            throw new VmotionError('PLUGIN_SOURCE', 'Plugin package file is missing', {
              id: manifest.id,
              file: file.path,
            });
          if (actual !== file.hash)
            throw new VmotionError('PLUGIN_CHANGED', 'Plugin package file hash changed', {
              id: manifest.id,
              file: file.path,
              expected: file.hash,
              actual,
            });
        }
        parsed = {
          source: registration.source,
          hash: contentHash,
          manifestHash,
          files,
          enabled: registration.enabled,
          manifest,
          metadataWarnings,
        };
        const probes = new Map(files.map((file) => [file, snapshot.files[file]]));
        this.cache.put(
          registration.source,
          { entry: parsed, probes },
          [...probes].reduce(
            (bytes, [file, source]) => bytes + (file.length + source.length) * 2,
            0,
          ) +
            JSON.stringify(manifest).length * 2,
        );
        this.stats.parses++;
        this.stats.contentDigests++;
      }
      if (ids.has(parsed.manifest.id) || paths.has(parsed.source))
        throw new VmotionError('PLUGIN_ID', 'Duplicate plugin ID/registration', {
          id: parsed.manifest.id,
        });
      ids.add(parsed.manifest.id);
      paths.add(parsed.source);
      if (
        registration.hash &&
        registration.hash !== parsed.hash &&
        registration.hash !== parsed.manifestHash
      )
        throw new VmotionError('PLUGIN_CHANGED', 'Pinned plugin manifest changed', {
          id: parsed.manifest.id,
        });
      if (registration.contentHash && registration.contentHash !== parsed.hash)
        throw new VmotionError('PLUGIN_CHANGED', 'Pinned plugin package changed', {
          id: parsed.manifest.id,
        });
      const entry = { ...parsed, enabled: registration.enabled };
      entries.push(entry);
      if (entry.enabled) {
        for (const source of [
          entry.manifest.entry,
          ...entry.manifest.contributions.map((c) => c.source),
        ].filter((s): s is string => !!s))
          if (snapshot.files[source] === undefined)
            throw new VmotionError('PLUGIN_SOURCE', 'Enabled plugin contribution is missing', {
              id: entry.manifest.id,
              file: source,
            });
      }
    }
    const enabled = new Map(entries.filter((e) => e.enabled).map((e) => [e.manifest.id, e])),
      active = new Set<string>(),
      done = new Set<string>();
    const visit = (id: string) => {
      if (active.has(id))
        throw new VmotionError('PLUGIN_CYCLE', 'Plugin dependencies contain a cycle', { id });
      if (done.has(id)) return;
      active.add(id);
      for (const [dependency, range] of Object.entries(enabled.get(id)!.manifest.dependencies)) {
        const version =
          enabled.get(dependency)?.manifest.version ??
          (Object.hasOwn(builtinPluginVersions, dependency)
            ? builtinPluginVersions[dependency]
            : undefined);
        if (!version || !pluginVersionMatches(version, range))
          throw new VmotionError(
            'PLUGIN_DEPENDENCY',
            'Enabled dependency is absent or incompatible',
            { id, dependency, range, actual: version },
          );
        if (enabled.has(dependency)) visit(dependency);
      }
      active.delete(id);
      done.add(id);
    };
    for (const id of enabled.keys()) visit(id);
    return entries;
  }
  report() {
    return { ...this.stats, ...this.cache.report() };
  }
  clear() {
    this.cache.clear();
  }
}
