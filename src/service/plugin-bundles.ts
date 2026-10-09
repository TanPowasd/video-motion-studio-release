import { execFile } from 'node:child_process';
import { mkdtemp, readFile, readdir, realpath, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { strToU8, unzipSync, zipSync, type Zippable } from 'fflate';
import { gt, lt, satisfies } from 'semver';
import { z } from 'zod';
import {
  builtinPluginVersions,
  pluginContentDigest,
  pluginDigest,
  type PluginRegistry,
} from '../core/plugins.js';
import {
  PLUGIN_BUNDLE_FORMAT,
  pluginBundleManifestSchema,
  pluginIdSchema,
  pluginPathSchema,
  type PluginBundleManifest,
  type PluginManifest,
} from '../core/plugin-schema.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import { atomicWrite, hash as fileHash } from '../platform/project-files.js';
import { preflightSchema } from './preflight.js';
import { parsePluginManifest, pluginClosure, pluginHealth } from './plugin-health.js';
import type { PluginFixAction } from './plugin-health.js';

/**
 * Portable plugin bundle (.vmplugin): a deterministic ZIP with
 *   vmplugin.json            bundle manifest (format, root id, plugins, per-file sha256, digest)
 *   files/<project path>     every file of each plugin's content closure (components/...)
 * Paths keep their project location so TypeScript imports between plugin files stay valid.
 */
export const BUNDLE_FORMAT = PLUGIN_BUNDLE_FORMAT;
export const bundleLimits = {
  archiveBytes: 32 * 1024 * 1024,
  totalBytes: 64 * 1024 * 1024,
  fileBytes: 8 * 1024 * 1024,
  entries: 2048,
  plugins: 64,
};
export const bundleManifestSchema = pluginBundleManifestSchema;
export type BundleManifest = PluginBundleManifest;
// Fixed local-time DOS epoch keeps archives byte-identical across machines/time zones.
const zipTime = () => new Date(1980, 0, 1, 0, 0, 0);
const bundleDigest = (plugins: BundleManifest['plugins']) =>
  pluginDigest(
    JSON.stringify(
      plugins.map((p) => [
        p.id,
        p.version,
        p.source,
        p.contentHash,
        p.files.map((f) => [f.path, f.sha256]),
      ]),
    ),
  );

export const pluginPackSchema = z
  .object({
    id: pluginIdSchema,
    includeDependencies: z.boolean().default(true),
    output: z.string().min(1).max(1000).optional(),
    base64: z.boolean().default(false),
  })
  .strict();
const sourceSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('folder'),
      path: z.string().min(1).max(1000),
      manifest: z.string().min(1).max(400).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('bundle'),
      path: z.string().min(1).max(1000).optional(),
      base64: z
        .string()
        .max(Math.ceil((bundleLimits.archiveBytes * 4) / 3) + 4)
        .optional(),
      name: z.string().max(200).optional(),
    })
    .strict(),
  z
    .object({
      type: z.literal('git'),
      url: z.string().min(1).max(1000),
      ref: z
        .string()
        .max(200)
        .regex(/^[\w./-]+$/)
        .optional(),
      subdir: z.string().max(400).optional(),
      manifest: z.string().min(1).max(400).optional(),
    })
    .strict(),
]);
export const pluginInstallSchema = z
  .object({
    revision: z.string(),
    source: sourceSchema,
    enabled: z.boolean().default(true),
    pin: z.boolean().optional(),
    dependencies: z.enum(['bundled', 'none']).default('bundled'),
    allowDowngrade: z.boolean().default(false),
    overwrite: z.boolean().default(false),
    delivery: z.enum(['stored', 'inline']).default('stored'),
    samples: preflightSchema.shape.samples.optional(),
  })
  .strict();

export interface PluginPackage {
  root: string;
  origin: Record<string, unknown>;
  digest: string;
  plugins: Array<{
    id: string;
    version: string;
    source: string;
    contentHash: string;
    manifest: PluginManifest;
    files: string[];
  }>;
  files: Record<string, string>;
}

/** Pack a registered project plugin (and its project-plugin dependencies) deterministically. */
export function packPluginBundle(
  registry: PluginRegistry,
  snapshot: Snapshot,
  id: string,
  includeDependencies = true,
) {
  const entries = registry.resolve(snapshot),
    byId = new Map(entries.map((entry) => [entry.manifest.id, entry]));
  if (!byId.has(id))
    throw new VmotionError('PLUGIN_NOT_FOUND', 'Project plugin is not registered', { id });
  const selected: string[] = [],
    external: Array<{ id: string; range: string; origin: string }> = [];
  const visit = (current: string) => {
    if (selected.includes(current)) return;
    selected.push(current);
    for (const [dependency, range] of Object.entries(byId.get(current)!.manifest.dependencies)) {
      if (includeDependencies && byId.has(dependency)) visit(dependency);
      else
        external.push({
          id: dependency,
          range,
          origin: Object.hasOwn(builtinPluginVersions, dependency)
            ? 'builtin'
            : byId.has(dependency)
              ? 'project'
              : 'missing',
        });
    }
  };
  visit(id);
  const order = [id, ...selected.slice(1).sort()],
    plugins: BundleManifest['plugins'] = order.map((pluginId) => {
      const entry = byId.get(pluginId)!;
      return {
        id: pluginId,
        name: entry.manifest.name,
        version: entry.manifest.version,
        source: entry.source,
        contentHash: pluginContentDigest(snapshot, entry.source, entry.manifest),
        dependencies: entry.manifest.dependencies,
        files: [...entry.files].sort().map((file) => {
          const text = snapshot.files[file];
          if (text === undefined)
            throw new VmotionError('PLUGIN_SOURCE', 'Plugin package file is missing', { file });
          return { path: file, sha256: pluginDigest(text), bytes: Buffer.byteLength(text) };
        }),
      };
    }),
    manifest: BundleManifest = {
      kind: 'vmotion-plugin-bundle',
      formatVersion: BUNDLE_FORMAT,
      root: id,
      plugins,
      digest: bundleDigest(plugins),
    };
  const options = { level: 9 as const, mtime: zipTime() },
    zippable: Zippable = {
      'vmplugin.json': [strToU8(JSON.stringify(manifest, null, 2) + '\n'), options],
    },
    paths = [...new Set(plugins.flatMap((p) => p.files.map((f) => f.path)))].sort();
  for (const file of paths) zippable['files/' + file] = [strToU8(snapshot.files[file]), options];
  const bytes = zipSync(zippable, { level: 9, mtime: zipTime() });
  if (bytes.byteLength > bundleLimits.archiveBytes)
    throw new VmotionError('PLUGIN_BUDGET', 'Plugin bundle exceeds 32MiB', {
      bytes: bytes.byteLength,
    });
  return { bytes, manifest, external };
}

export async function packPlugins(
  root: string,
  registry: PluginRegistry,
  snapshot: Snapshot,
  raw: unknown,
) {
  const p = pluginPackSchema.parse(raw),
    { bytes, manifest, external } = packPluginBundle(
      registry,
      snapshot,
      p.id,
      p.includeDependencies,
    ),
    plugin = manifest.plugins[0],
    output = path.resolve(
      root,
      p.output ?? path.join('exports', 'plugins', `${p.id}-${plugin.version}.vmplugin`),
    );
  if (!/\.(vmplugin|zip)$/i.test(output))
    throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Bundle output must end with .vmplugin or .zip', {
      output,
    });
  await atomicWrite(output, Buffer.from(bytes));
  return {
    id: p.id,
    version: plugin.version,
    output,
    bytes: bytes.byteLength,
    sha256: fileHash(Buffer.from(bytes)),
    digest: manifest.digest,
    formatVersion: BUNDLE_FORMAT,
    plugins: manifest.plugins.map((entry) => ({
      id: entry.id,
      version: entry.version,
      contentHash: entry.contentHash,
      files: entry.files.length,
      bytes: entry.files.reduce((sum, file) => sum + file.bytes, 0),
    })),
    externalDependencies: external,
    deterministic: true,
    ...(p.base64 ? { base64: Buffer.from(bytes).toString('base64') } : {}),
  };
}

const decoder = new TextDecoder('utf-8', { fatal: true });
function decode(bytes: Uint8Array, file: string) {
  try {
    return decoder.decode(bytes);
  } catch {
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Plugin files must be UTF-8 text', { file });
  }
}
function checkFilePath(file: string) {
  if (!pluginPathSchema.safeParse(file).success)
    throw new VmotionError(
      'PLUGIN_BUNDLE_PATH',
      'Bundle file path must stay under components/ and use .json/.ts/.tsx without traversal',
      { file },
    );
}
/** Validate a decoded bundle: paths, sizes, per-file sha256, closures and content hashes. */
export function verifyBundle(entries: Map<string, Uint8Array>, origin: Record<string, unknown>) {
  const manifestBytes = entries.get('vmplugin.json');
  if (!manifestBytes)
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Bundle is missing vmplugin.json');
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(decode(manifestBytes, 'vmplugin.json'));
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'vmplugin.json is not valid JSON');
  }
  if (typeof raw?.formatVersion === 'number' && raw.formatVersion > BUNDLE_FORMAT)
    throw new VmotionError(
      'PLUGIN_API_VERSION',
      `Bundle format ${raw.formatVersion} needs a newer Vmotion (supported: ${BUNDLE_FORMAT})`,
    );
  const parsed = bundleManifestSchema.safeParse(raw);
  if (!parsed.success)
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Invalid vmplugin.json', {
      issues: parsed.error.issues.slice(0, 8),
    });
  const manifest = parsed.data,
    files: Record<string, string> = {},
    declared = new Set<string>();
  if (new Set(manifest.plugins.map((p) => p.id)).size !== manifest.plugins.length)
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Bundle lists a plugin twice');
  if (manifest.plugins[0].id !== manifest.root)
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'The first bundled plugin must be the root');
  for (const plugin of manifest.plugins)
    for (const file of plugin.files) {
      checkFilePath(file.path);
      declared.add(file.path);
      const bytes = entries.get('files/' + file.path);
      if (!bytes)
        throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Bundle file is missing', {
          id: plugin.id,
          file: file.path,
        });
      const text = (files[file.path] ??= decode(bytes, file.path)),
        actual = pluginDigest(text);
      if (actual !== file.sha256 || bytes.byteLength !== file.bytes)
        throw new VmotionError('PLUGIN_BUNDLE_HASH', 'Bundle file hash mismatch', {
          id: plugin.id,
          file: file.path,
          expected: file.sha256,
          actual,
        });
    }
  for (const name of entries.keys())
    if (name !== 'vmplugin.json' && !declared.has(name.slice('files/'.length)))
      throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Bundle contains an undeclared file', {
        file: name,
      });
  if (bundleDigest(manifest.plugins) !== manifest.digest)
    throw new VmotionError('PLUGIN_BUNDLE_HASH', 'Bundle digest mismatch', {
      expected: manifest.digest,
    });
  const shadow = { files } as unknown as Snapshot;
  return {
    root: manifest.root,
    origin,
    digest: manifest.digest,
    files,
    plugins: manifest.plugins.map((plugin) => {
      const pluginManifest = parsePluginManifest(files[plugin.source] ?? '', plugin.source);
      if (pluginManifest.id !== plugin.id || pluginManifest.version !== plugin.version)
        throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Bundle entry differs from its manifest', {
          id: plugin.id,
          manifestId: pluginManifest.id,
        });
      const closure = pluginClosure(plugin.source, pluginManifest).sort(),
        listed = plugin.files.map((f) => f.path).sort();
      if (JSON.stringify(closure) !== JSON.stringify(listed))
        throw new VmotionError(
          'PLUGIN_BUNDLE_FORMAT',
          'Bundle files differ from the plugin content closure',
          { id: plugin.id, expected: closure, actual: listed },
        );
      const contentHash = pluginContentDigest(shadow, plugin.source, pluginManifest);
      if (contentHash !== plugin.contentHash)
        throw new VmotionError('PLUGIN_BUNDLE_HASH', 'Plugin content hash mismatch', {
          id: plugin.id,
          expected: plugin.contentHash,
          actual: contentHash,
        });
      return { ...plugin, manifest: pluginManifest, files: closure };
    }),
  } satisfies PluginPackage;
}
/** Decode a ZIP with size/entry/path checks applied before any member is inflated. */
export function readBundleBytes(bytes: Uint8Array, origin: Record<string, unknown>) {
  if (bytes.byteLength > bundleLimits.archiveBytes)
    throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive exceeds 32MiB', {
      bytes: bytes.byteLength,
    });
  let count = 0,
    total = 0;
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(bytes, {
      filter(file) {
        if (file.name.endsWith('/')) {
          if (file.name.split('/').some((part) => part === '..' || part === '.'))
            throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Archive path escapes the bundle', {
              file: file.name,
            });
          return false;
        }
        if (++count > bundleLimits.entries)
          throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive has too many entries');
        if (file.name !== 'vmplugin.json') {
          if (!file.name.startsWith('files/'))
            throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Unexpected archive member', {
              file: file.name,
            });
          checkFilePath(file.name.slice('files/'.length));
        }
        if (file.originalSize > bundleLimits.fileBytes)
          throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive member exceeds 8MiB', {
            file: file.name,
          });
        total += file.originalSize;
        if (total > bundleLimits.totalBytes)
          throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive expands beyond 64MiB');
        return true;
      },
    });
  } catch (e) {
    if (e instanceof VmotionError) throw e;
    throw new VmotionError('PLUGIN_BUNDLE_FORMAT', 'Not a readable ZIP/.vmplugin archive', {
      reason: (e as Error).message,
    });
  }
  const entries = new Map<string, Uint8Array>();
  for (const [name, data] of Object.entries(files)) {
    if (data.byteLength > bundleLimits.fileBytes)
      throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive member exceeds 8MiB', { file: name });
    entries.set(name, data);
  }
  return verifyBundle(entries, origin);
}

async function readInside(base: string, relative: string) {
  const resolved = path.resolve(base, relative),
    real = await realpath(resolved).catch(() => {
      throw new VmotionError('PLUGIN_SOURCE', 'Plugin file is missing in the source folder', {
        file: relative,
      });
    });
  if (real !== base && !real.startsWith(base + path.sep))
    throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Plugin file resolves outside its folder', {
      file: relative,
    });
  const info = await stat(real);
  if (!info.isFile())
    throw new VmotionError('PLUGIN_SOURCE', 'Plugin path is not a file', { file: relative });
  if (info.size > bundleLimits.fileBytes)
    throw new VmotionError('PLUGIN_BUDGET', 'Plugin file exceeds 8MiB', { file: relative });
  return readFile(real);
}
/**
 * A folder is either an unpacked bundle (vmplugin.json + files/), a tree that mirrors project
 * paths (components/... next to the manifest's references) or a plugin directory whose files
 * sit relative to the common directory of the manifest's references.
 */
export async function readPluginFolder(
  folder: string,
  manifestName: string | undefined,
  origin: Record<string, unknown>,
): Promise<PluginPackage> {
  const base = await realpath(folder).catch(() => {
    throw new VmotionError('PLUGIN_SOURCE', 'Plugin folder does not exist', { folder });
  });
  if (!(await stat(base)).isDirectory())
    throw new VmotionError('PLUGIN_SOURCE', 'Plugin source is not a folder', { folder });
  const bundleManifest = await readInside(base, 'vmplugin.json').catch(() => undefined);
  if (bundleManifest && !manifestName) {
    const raw = JSON.parse(decode(bundleManifest, 'vmplugin.json'));
    const entries = new Map<string, Uint8Array>([['vmplugin.json', bundleManifest]]);
    let total = 0;
    for (const plugin of Array.isArray(raw?.plugins) ? raw.plugins : [])
      for (const file of Array.isArray(plugin?.files) ? plugin.files : []) {
        checkFilePath(String(file?.path));
        const bytes = await readInside(base, path.join('files', file.path));
        total += bytes.byteLength;
        if (total > bundleLimits.totalBytes)
          throw new VmotionError('PLUGIN_BUDGET', 'Plugin folder exceeds 64MiB');
        entries.set('files/' + file.path, bytes);
      }
    return verifyBundle(entries, origin);
  }
  let manifestFile = manifestName;
  if (manifestFile) {
    if (path.isAbsolute(manifestFile) || manifestFile.split(/[\\/]/).includes('..'))
      throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Manifest must be relative to the folder', {
        file: manifestFile,
      });
  } else {
    const names = (await readdir(base)).filter((name) => name.endsWith('.json')).sort();
    if (names.includes('plugin.json')) manifestFile = 'plugin.json';
    else {
      const candidates: string[] = [];
      for (const name of names) {
        const text = (await readInside(base, name)).toString('utf8');
        if (/"kind"\s*:\s*"vmotion-plugin"/.test(text)) candidates.push(name);
      }
      if (candidates.length !== 1)
        throw new VmotionError(
          'PLUGIN_SOURCE',
          candidates.length
            ? 'Several plugin manifests found; pass manifest explicitly'
            : 'No plugin manifest (plugin.json or kind=vmotion-plugin) in folder',
          { folder, candidates },
        );
      manifestFile = candidates[0];
    }
  }
  const manifestText = decode(await readInside(base, manifestFile), manifestFile),
    manifest = parsePluginManifest(manifestText, manifestFile),
    relativeManifest = manifestFile.split(path.sep).join('/'),
    references = pluginClosure('__manifest__', manifest).slice(1),
    exists = async (file: string) =>
      readInside(base, file)
        .then(() => true)
        .catch(() => false);
  let source: string, locate: (file: string) => string;
  if (
    pluginPathSchema.safeParse(relativeManifest).success &&
    (await Promise.all(references.map(exists))).every(Boolean)
  ) {
    // The folder mirrors project paths (e.g. a project or repository root).
    source = relativeManifest;
    locate = (file) => file;
  } else {
    const directories = references.map((file) => file.split('/').slice(0, -1));
    let common = directories[0] ?? ['components', 'plugins', ...manifest.id.split('.')];
    for (const dir of directories.slice(1)) {
      let i = 0;
      while (i < common.length && i < dir.length && common[i] === dir[i]) i++;
      common = common.slice(0, i);
    }
    if (common[0] !== 'components' || common.length < 2)
      common = ['components', 'plugins', ...manifest.id.split('.')];
    const prefix = common.join('/');
    source = prefix + '/' + path.basename(relativeManifest);
    locate = (file) => {
      if (!file.startsWith(prefix + '/'))
        throw new VmotionError(
          'PLUGIN_SOURCE',
          'Plugin references must share one directory under components/ when installing a folder',
          { file, directory: prefix },
        );
      return file.slice(prefix.length + 1);
    };
  }
  checkFilePath(source);
  const files: Record<string, string> = { [source]: manifestText };
  let total = Buffer.byteLength(manifestText);
  for (const file of references) {
    checkFilePath(file);
    const bytes = await readInside(base, locate(file));
    total += bytes.byteLength;
    if (total > bundleLimits.totalBytes)
      throw new VmotionError('PLUGIN_BUDGET', 'Plugin folder exceeds 64MiB');
    files[file] = decode(bytes, file);
  }
  for (const file of manifest.files) {
    const actual = pluginDigest(files[file.path]);
    if (actual !== file.hash)
      throw new VmotionError('PLUGIN_BUNDLE_HASH', 'Plugin package file hash changed', {
        id: manifest.id,
        file: file.path,
        expected: file.hash,
        actual,
      });
  }
  const closure = pluginClosure(source, manifest),
    contentHash = pluginContentDigest({ files } as unknown as Snapshot, source, manifest);
  return {
    root: manifest.id,
    origin: { ...origin, manifest: source },
    digest: contentHash,
    files,
    plugins: [
      { id: manifest.id, version: manifest.version, source, contentHash, manifest, files: closure },
    ],
  };
}

const run = promisify(execFile);
const gitUrl = /^(?:https?:\/\/|ssh:\/\/|git@[\w.-]+:|file:\/\/)/;
async function readGit(source: Extract<z.output<typeof sourceSchema>, { type: 'git' }>) {
  if (source.url.startsWith('-') || (!gitUrl.test(source.url) && !path.isAbsolute(source.url)))
    throw new VmotionError(
      'PLUGIN_GIT',
      'Git source must be an https/ssh/file URL or an absolute local repository path',
      { url: source.url },
    );
  if (source.ref?.startsWith('-'))
    throw new VmotionError('PLUGIN_GIT', 'Invalid Git ref', { ref: source.ref });
  const subdir = source.subdir ?? '';
  if (path.isAbsolute(subdir) || subdir.split(/[\\/]/).includes('..'))
    throw new VmotionError('PLUGIN_BUNDLE_PATH', 'Git subdir must stay inside the repository', {
      subdir,
    });
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'vmotion-plugin-git-')),
    checkout = path.join(temporary, 'repo'),
    options = {
      timeout: 120_000,
      maxBuffer: 1024 * 1024,
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_ASKPASS: 'echo' },
      windowsHide: true,
    };
  try {
    const commit = source.ref && /^[a-f0-9]{7,40}$/.test(source.ref);
    try {
      await run(
        'git',
        [
          'clone',
          '--quiet',
          '--no-tags',
          '-c',
          'core.symlinks=false',
          ...(commit ? [] : ['--depth', '1', ...(source.ref ? ['--branch', source.ref] : [])]),
          '--',
          source.url,
          checkout,
        ],
        options,
      );
      if (commit)
        await run('git', ['-C', checkout, 'checkout', '--quiet', source.ref!, '--'], options);
    } catch (e) {
      throw new VmotionError('PLUGIN_GIT', 'git clone/checkout failed', {
        url: source.url,
        ref: source.ref,
        reason: ((e as { stderr?: string }).stderr || (e as Error).message).slice(0, 500),
      });
    }
    const head = (await run('git', ['-C', checkout, 'rev-parse', 'HEAD'], options)).stdout.trim();
    return await readPluginFolder(path.join(checkout, subdir), source.manifest, {
      type: 'git',
      url: source.url,
      ...(source.ref ? { ref: source.ref } : {}),
      ...(subdir ? { subdir } : {}),
      commit: head,
    });
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

export async function loadPluginPackage(
  root: string,
  source: z.output<typeof sourceSchema>,
): Promise<PluginPackage> {
  if (source.type === 'git') return readGit(source);
  if (source.type === 'folder') {
    const folder = path.resolve(root, source.path);
    return readPluginFolder(folder, source.manifest, { type: 'folder', path: folder });
  }
  if (!!source.path === !!source.base64)
    throw new VmotionError('PLUGIN_SOURCE', 'Bundle source needs exactly one of path or base64');
  if (source.base64) {
    const bytes = Buffer.from(source.base64, 'base64');
    return readBundleBytes(new Uint8Array(bytes), {
      type: 'bundle',
      ...(source.name ? { name: source.name } : {}),
      sha256: fileHash(bytes),
      bytes: bytes.byteLength,
    });
  }
  const file = path.resolve(root, source.path!),
    info = await stat(file).catch(() => {
      throw new VmotionError('PLUGIN_SOURCE', 'Bundle file does not exist', { file });
    });
  if (info.isDirectory()) return readPluginFolder(file, undefined, { type: 'folder', path: file });
  if (info.size > bundleLimits.archiveBytes)
    throw new VmotionError('PLUGIN_BUDGET', 'Plugin archive exceeds 32MiB', { bytes: info.size });
  const bytes = await readFile(file);
  return readBundleBytes(new Uint8Array(bytes), {
    type: 'bundle',
    path: file,
    sha256: fileHash(bytes),
    bytes: bytes.byteLength,
  });
}

type Change = 'install' | 'upgrade' | 'downgrade' | 'reinstall' | 'unchanged';
const diff = (before: string[], after: string[]) => ({
  added: after.filter((v) => !before.includes(v)),
  removed: before.filter((v) => !after.includes(v)),
});
/**
 * Resolve a package against the project and return plugins_plan input plus a reviewable
 * summary. Nothing is written here; the result becomes an ordinary exact candidate.
 */
export function planPluginInstall(
  snapshot: Snapshot,
  pkg: PluginPackage,
  options: Pick<
    z.output<typeof pluginInstallSchema>,
    'enabled' | 'pin' | 'dependencies' | 'allowDowngrade' | 'overwrite'
  >,
) {
  const health = pluginHealth(snapshot),
    installed = new Map(health.registrations.filter((r) => r.id).map((r) => [r.id!, r] as const)),
    bundled = new Map(pkg.plugins.map((p) => [p.id, p])),
    dependencyReport: Array<{
      from: string;
      id: string;
      range: string;
      status: 'builtin' | 'installed' | 'enable' | 'bundled' | 'upgrade' | 'missing' | 'conflict';
      version?: string;
      bundledVersion?: string;
      installedVersion?: string;
    }> = [],
    selected: string[] = [],
    enable = new Set<string>();
  const visit = (id: string) => {
    if (selected.includes(id)) return;
    selected.push(id);
    for (const [dependency, range] of Object.entries(bundled.get(id)!.manifest.dependencies)) {
      const builtin = Object.hasOwn(builtinPluginVersions, dependency)
          ? builtinPluginVersions[dependency]
          : undefined,
        current = installed.get(dependency),
        offered = options.dependencies === 'bundled' ? bundled.get(dependency) : undefined,
        currentVersion = current?.manifest?.version,
        row = { from: id, id: dependency, range };
      if (dependency === 'vmotion' || dependency.startsWith('vmotion.')) {
        dependencyReport.push({
          ...row,
          status:
            builtin && satisfies(builtin, range) ? 'builtin' : builtin ? 'conflict' : 'missing',
          ...(builtin ? { version: builtin } : {}),
        });
      } else if (selected.includes(dependency)) {
        dependencyReport.push({
          ...row,
          status: 'bundled',
          version: bundled.get(dependency)!.version,
        });
      } else if (currentVersion && satisfies(currentVersion, range)) {
        if (!current!.enabled) enable.add(dependency);
        dependencyReport.push({
          ...row,
          status: current!.enabled ? 'installed' : 'enable',
          version: currentVersion,
          ...(offered ? { bundledVersion: offered.version } : {}),
        });
      } else if (
        offered &&
        satisfies(offered.version, range) &&
        (!currentVersion || !lt(offered.version, currentVersion) || options.allowDowngrade)
      ) {
        dependencyReport.push({
          ...row,
          status: currentVersion ? 'upgrade' : 'bundled',
          version: offered.version,
          ...(currentVersion ? { installedVersion: currentVersion } : {}),
        });
        visit(dependency);
      } else
        dependencyReport.push({
          ...row,
          status: currentVersion ? 'conflict' : 'missing',
          ...(currentVersion ? { version: currentVersion } : {}),
          ...(offered ? { bundledVersion: offered.version } : {}),
        });
    }
  };
  visit(pkg.root);
  const unresolved = dependencyReport.filter(
    (d) => d.status === 'missing' || d.status === 'conflict',
  );
  if (unresolved.length)
    throw new VmotionError(
      'PLUGIN_DEPENDENCY',
      'Plugin dependencies are missing or conflict: ' +
        unresolved
          .map((d) => `${d.id} ${d.range} (${d.status}${d.version ? ' ' + d.version : ''})`)
          .join(', '),
      { dependencies: dependencyReport },
    );
  const edits: Array<{
      type: 'replace';
      path: string;
      content: string;
      expectedHash: string | null;
    }> = [],
    actions: Array<
      { type: 'register'; source: string; enabled: boolean; pin: boolean } | PluginFixAction
    > = [],
    plugins: Array<Record<string, unknown>> = [],
    conflicts: Array<{ file: string; owner?: string }> = [],
    owners = new Map<string, string>();
  for (const r of health.registrations)
    for (const file of r.files) owners.set(file, r.id ?? r.source);
  for (const id of selected) {
    const next = bundled.get(id)!,
      previous = installed.get(id),
      isRoot = id === pkg.root,
      before = previous?.manifest?.version;
    let change: Change = 'install';
    if (before)
      change = gt(next.version, before)
        ? 'upgrade'
        : lt(next.version, before)
          ? 'downgrade'
          : previous!.contentHash === next.contentHash && previous!.source === next.source
            ? 'unchanged'
            : 'reinstall';
    if (change === 'downgrade' && !options.allowDowngrade)
      throw new VmotionError(
        'PLUGIN_DOWNGRADE',
        `Installing ${id}@${next.version} would downgrade ${before}; pass allowDowngrade`,
        { id, from: before, to: next.version },
      );
    const counts = { added: 0, changed: 0, unchanged: 0 };
    for (const file of next.files) {
      const current = snapshot.files[file],
        content = pkg.files[file];
      if (current === content) {
        counts.unchanged++;
        continue;
      }
      if (current !== undefined) {
        const owner = owners.get(file);
        if (owner !== id && !options.overwrite)
          conflicts.push({ file, ...(owner ? { owner } : {}) });
        counts.changed++;
      } else counts.added++;
      if (!edits.some((edit) => edit.path === file))
        edits.push({
          type: 'replace',
          path: file,
          content,
          expectedHash: current === undefined ? null : fileHash(current),
        });
    }
    const enabled = isRoot ? options.enabled : true,
      pin = options.pin ?? (previous && previous.pinned !== 'none' ? true : undefined);
    if (!previous) actions.push({ type: 'register', source: next.source, enabled, pin: !!pin });
    else if (previous.source !== next.source) {
      actions.push({ type: 'remove', source: previous.source });
      actions.push({ type: 'register', source: next.source, enabled, pin: !!pin });
    } else if (change !== 'unchanged' || enabled !== previous.enabled || pin !== undefined)
      actions.push({ type: 'toggle', id, enabled, ...(pin !== undefined ? { pin } : {}) });
    const old = previous?.manifest;
    plugins.push({
      id,
      name: next.manifest.name,
      role: isRoot ? 'root' : 'dependency',
      change,
      ...(before ? { from: before } : {}),
      to: next.version,
      source: next.source,
      ...(previous && previous.source !== next.source ? { previousSource: previous.source } : {}),
      contentHash: next.contentHash,
      ...(previous?.contentHash ? { previousContentHash: previous.contentHash } : {}),
      enabled,
      pinned: !!pin,
      files: {
        ...counts,
        stale: previous ? previous.files.filter((f) => !next.files.includes(f)) : [],
      },
      ...(old
        ? {
            tools: diff(
              old.tools.map((t) => t.id),
              next.manifest.tools.map((t) => t.id),
            ),
            contributions: diff(
              old.contributions.map((c) => c.id),
              next.manifest.contributions.map((c) => c.id),
            ),
            dependencies: Object.fromEntries(
              [
                ...new Set([
                  ...Object.keys(old.dependencies),
                  ...Object.keys(next.manifest.dependencies),
                ]),
              ]
                .filter((dep) => old.dependencies[dep] !== next.manifest.dependencies[dep])
                .map((dep) => [
                  dep,
                  {
                    from: old.dependencies[dep] ?? null,
                    to: next.manifest.dependencies[dep] ?? null,
                  },
                ]),
            ),
          }
        : {
            tools: { added: next.manifest.tools.map((t) => t.id), removed: [] },
            contributions: { added: next.manifest.contributions.map((c) => c.id), removed: [] },
          }),
    });
  }
  if (conflicts.length)
    throw new VmotionError(
      'PLUGIN_INSTALL_CONFLICT',
      'Install would overwrite files that belong to other plugins or the project; pass overwrite to replace them',
      { conflicts },
    );
  for (const id of enable)
    if (!selected.includes(id)) actions.push({ type: 'toggle', id, enabled: true });
  return {
    files: edits,
    actions,
    summary: {
      origin: pkg.origin,
      digest: pkg.digest,
      root: pkg.root,
      plugins,
      dependencies: dependencyReport,
      skipped: pkg.plugins.map((p) => p.id).filter((id) => !selected.includes(id)),
      fileEdits: edits.length,
    },
  };
}
