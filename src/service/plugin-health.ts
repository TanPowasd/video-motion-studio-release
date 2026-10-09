import { satisfies, validRange } from 'semver';
import {
  builtinPluginVersions,
  pluginContentDigest,
  pluginDigest,
  type PluginRegistry,
} from '../core/plugins.js';
import { pluginManifestSchema, type PluginManifest } from '../core/plugin-schema.js';
import type { PluginRegistration } from '../core/plugin-registration.js';
import { VmotionError, type Snapshot } from '../core/model.js';

/** A plugins_plan action the UI/agent can submit as-is to fix a reported problem. */
export type PluginFixAction =
  | { type: 'toggle'; id: string; enabled: boolean; pin?: boolean }
  | { type: 'remove'; id?: string; source?: string };
export interface PluginFix {
  label: string;
  actions?: PluginFixAction[];
  /** Install (or upgrade) a dependency from a bundle/folder/Git source. */
  install?: { id: string; range?: string };
  openFile?: string;
}
export interface PluginProblem {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  source: string;
  id?: string;
  file?: string;
  dependency?: string;
  range?: string;
  actual?: string;
  fixes: PluginFix[];
}
export interface PluginDependencyStatus {
  id: string;
  range: string;
  origin: 'builtin' | 'project' | 'missing';
  version?: string;
  enabled?: boolean;
  satisfied: boolean;
}
export interface PluginRegistrationHealth {
  source: string;
  enabled: boolean;
  pinned: 'content' | 'manifest' | 'none';
  pinMatches?: boolean;
  id?: string;
  manifest?: PluginManifest;
  manifestHash?: string;
  contentHash?: string;
  files: string[];
  status: 'ok' | 'warning' | 'error';
  problems: PluginProblem[];
  dependencies: PluginDependencyStatus[];
}
export const pluginClosure = (source: string, manifest: PluginManifest) => [
  ...new Set([
    source,
    ...(manifest.entry ? [manifest.entry] : []),
    ...manifest.contributions.map((resource) => resource.source),
    ...manifest.files.map((file) => file.path),
  ]),
];
/** Parse one manifest without throwing; reports future API and reserved IDs explicitly. */
export function readPluginManifest(
  text: string,
  file: string,
): { manifest?: PluginManifest; problem?: Omit<PluginProblem, 'source' | 'fixes'> } {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    return {
      problem: {
        severity: 'error',
        code: 'PLUGIN_MANIFEST',
        message: 'Manifest is not valid JSON: ' + (e as Error).message,
        file,
      },
    };
  }
  const object = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
  if (typeof object.apiVersion === 'number' && object.apiVersion > 1)
    return {
      problem: {
        severity: 'error',
        code: 'PLUGIN_API_VERSION',
        message: `Plugin requires apiVersion ${object.apiVersion}; this Vmotion supports apiVersion 1`,
        file,
        ...(typeof object.id === 'string' ? { id: object.id } : {}),
      },
    };
  if (
    typeof object.id === 'string' &&
    (object.id === 'vmotion' || object.id.startsWith('vmotion.'))
  )
    return {
      problem: {
        severity: 'error',
        code: 'PLUGIN_ID',
        message: 'Builtin plugin IDs (vmotion.*) are reserved',
        file,
        id: object.id,
      },
    };
  const parsed = pluginManifestSchema.safeParse(raw);
  if (!parsed.success)
    return {
      problem: {
        severity: 'error',
        code: 'PLUGIN_MANIFEST',
        message:
          'Invalid plugin manifest: ' +
          parsed.error.issues
            .slice(0, 4)
            .map((issue) => `${issue.path.join('.') || '/'} ${issue.message}`)
            .join('; '),
        file,
        ...(typeof object.id === 'string' ? { id: object.id } : {}),
      },
    };
  return { manifest: parsed.data };
}
/** Throwing variant used by bundle/folder installation. */
export function parsePluginManifest(text: string, file: string) {
  const { manifest, problem } = readPluginManifest(text, file);
  if (!manifest) throw new VmotionError(problem!.code, problem!.message, { file, id: problem!.id });
  return manifest;
}
/**
 * Tolerant, per-registration health report. Unlike PluginRegistry.resolve (which rejects the
 * whole project on the first problem), this lists every problem with fix actions that are
 * ordinary plugins_plan actions, so repairs still go through candidate/preflight/apply.
 */
export function pluginHealth(snapshot: Snapshot, registry?: PluginRegistry) {
  const registrations: PluginRegistrationHealth[] = (snapshot.project.plugins ?? []).map(
    (registration: PluginRegistration) => {
      const health: PluginRegistrationHealth = {
        source: registration.source,
        enabled: registration.enabled,
        pinned: registration.contentHash ? 'content' : registration.hash ? 'manifest' : 'none',
        files: [registration.source],
        status: 'ok',
        problems: [],
        dependencies: [],
      };
      const add = (problem: Omit<PluginProblem, 'source'>) =>
        health.problems.push({ source: registration.source, ...problem });
      const remove: PluginFix = {
        label: '移除注册（保留文件）',
        actions: [{ type: 'remove', source: registration.source }],
      };
      const text = snapshot.files[registration.source];
      if (text === undefined) {
        add({
          severity: 'error',
          code: 'PLUGIN_SOURCE',
          message: 'Registered plugin manifest is missing',
          file: registration.source,
          fixes: [remove],
        });
        return health;
      }
      const { manifest, problem } = readPluginManifest(text, registration.source);
      if (!manifest) {
        add({ ...problem!, fixes: [{ label: '打开清单', openFile: registration.source }, remove] });
        return health;
      }
      health.id = manifest.id;
      health.manifest = manifest;
      health.manifestHash = pluginDigest(text);
      health.files = pluginClosure(registration.source, manifest);
      const disable: PluginFix = {
        label: '禁用此插件',
        actions: [{ type: 'toggle', id: manifest.id, enabled: false }],
      };
      const missing = health.files.filter((file) => snapshot.files[file] === undefined);
      for (const file of missing) {
        const declared = manifest.files.some((f) => f.path === file);
        if (!declared && !registration.enabled) continue;
        add({
          severity: 'error',
          code: 'PLUGIN_SOURCE',
          message: declared
            ? 'Plugin package file is missing'
            : 'Enabled plugin contribution is missing',
          id: manifest.id,
          file,
          fixes: [
            { label: '打开清单', openFile: registration.source },
            ...(declared ? [] : [disable]),
          ],
        });
      }
      for (const file of manifest.files) {
        const current = snapshot.files[file.path];
        if (current !== undefined && pluginDigest(current) !== file.hash)
          add({
            severity: 'error',
            code: 'PLUGIN_CHANGED',
            message: 'Plugin package file hash changed',
            id: manifest.id,
            file: file.path,
            fixes: [
              { label: '打开文件', openFile: file.path },
              { label: '打开清单更新 hash', openFile: registration.source },
            ],
          });
      }
      if (!missing.length) {
        health.contentHash = pluginContentDigest(snapshot, registration.source, manifest);
        if (health.pinned !== 'none') {
          health.pinMatches = registration.contentHash
            ? registration.contentHash === health.contentHash
            : registration.hash === health.contentHash || registration.hash === health.manifestHash;
          if (!health.pinMatches)
            add({
              severity: 'error',
              code: 'PLUGIN_CHANGED',
              message: 'Pinned plugin content changed since it was pinned',
              id: manifest.id,
              fixes: [
                {
                  label: '固定当前内容',
                  actions: [
                    { type: 'toggle', id: manifest.id, enabled: registration.enabled, pin: true },
                  ],
                },
                {
                  label: '解除固定',
                  actions: [
                    { type: 'toggle', id: manifest.id, enabled: registration.enabled, pin: false },
                  ],
                },
              ],
            });
        }
      }
      try {
        const raw = JSON.parse(text);
        raw.tools?.forEach((tool: unknown, index: number) => {
          if (
            tool &&
            typeof tool === 'object' &&
            (!('categories' in tool) || !('keywords' in tool))
          )
            add({
              severity: 'warning',
              code: 'PLUGIN_METADATA_DEFAULTS',
              message: `Tool #${index} uses legacy metadata defaults; add categories and keywords`,
              id: manifest.id,
              file: registration.source,
              fixes: [{ label: '打开清单', openFile: registration.source }],
            });
        });
      } catch {
        // already validated above
      }
      return health;
    },
  );
  const byId = new Map<string, PluginRegistrationHealth>();
  for (const health of registrations) {
    if (!health.id) continue;
    if (byId.has(health.id))
      health.problems.push({
        severity: 'error',
        code: 'PLUGIN_ID',
        message: 'Duplicate plugin ID/registration',
        source: health.source,
        id: health.id,
        fixes: [
          {
            label: '移除重复注册（保留文件）',
            actions: [{ type: 'remove', source: health.source }],
          },
        ],
      });
    else byId.set(health.id, health);
  }
  for (const health of registrations) {
    if (!health.manifest) continue;
    for (const [id, range] of Object.entries(health.manifest.dependencies)) {
      const builtin = Object.hasOwn(builtinPluginVersions, id)
          ? builtinPluginVersions[id]
          : undefined,
        project = byId.get(id),
        version = builtin ?? project?.manifest?.version,
        satisfied =
          !!version &&
          !!validRange(range) &&
          satisfies(version, range) &&
          (!!builtin || !!project?.enabled);
      health.dependencies.push({
        id,
        range,
        origin: builtin ? 'builtin' : project ? 'project' : 'missing',
        ...(version ? { version } : {}),
        ...(project ? { enabled: project.enabled } : builtin ? { enabled: true } : {}),
        satisfied,
      });
      if (!health.enabled || satisfied) continue;
      const self = health.manifest.id,
        disable: PluginFix = {
          label: '禁用此插件',
          actions: [{ type: 'toggle', id: self, enabled: false }],
        };
      if (project && version && satisfies(version, range) && !project.enabled)
        health.problems.push({
          severity: 'error',
          code: 'PLUGIN_DEPENDENCY',
          message: `Dependency ${id}@${version} is disabled`,
          source: health.source,
          id: self,
          dependency: id,
          range,
          actual: version,
          fixes: [
            { label: `启用依赖 ${id}`, actions: [{ type: 'toggle', id, enabled: true }] },
            disable,
          ],
        });
      else
        health.problems.push({
          severity: 'error',
          code: 'PLUGIN_DEPENDENCY',
          message: version
            ? `Dependency ${id}@${version} does not satisfy ${range}`
            : `Dependency ${id} (${range}) is not installed`,
          source: health.source,
          id: self,
          dependency: id,
          range,
          ...(version ? { actual: version } : {}),
          fixes: [
            ...(builtin ? [] : [{ label: `安装 ${id} ${range}`, install: { id, range } }]),
            disable,
          ],
        });
    }
  }
  const problems = registrations.flatMap((health) => {
    health.status = health.problems.some((p) => p.severity === 'error')
      ? 'error'
      : health.problems.length
        ? 'warning'
        : 'ok';
    return health.problems;
  });
  if (registry && !problems.some((p) => p.severity === 'error'))
    try {
      registry.resolve(snapshot);
    } catch (e) {
      const error = e as VmotionError;
      problems.push({
        severity: 'error',
        code: error.code ?? 'PLUGIN_ERROR',
        message: error.message,
        source: '',
        id: (error.details as { id?: string } | undefined)?.id,
        fixes: [],
      });
    }
  return { registrations, problems };
}
