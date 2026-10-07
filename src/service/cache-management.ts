import { z } from 'zod';
import path from 'node:path';
import { readdir, lstat, realpath, readFile, unlink } from 'node:fs/promises';
import { VmotionError, type Snapshot, type Node } from '../core/model.js';
import { hash, json, safePath, atomicWrite } from './project.js';
import { activeCacheFiles } from '../media/proxy-cache.js';
export const cacheGroups = [
  'tracking',
  'tracking-evidence',
  'proxies-v2',
  'audio-mix',
  'audio-tempo',
  'sound-cache',
  'sound-samples',
  'audio-audit',
  'media-evidence',
  'visual-audit',
  'sequence-audit',
  'audio-preview',
  'sound-preview',
  'preflight',
] as const;
const protectedGroups = ['history', 'snapshots', 'agent-plans', 'renders', 'compiled'];
export const cacheInspectSchema = z
  .object({
    groups: z
      .array(z.enum(cacheGroups))
      .max(32)
      .default([...cacheGroups]),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(30),
    detail: z.boolean().default(false),
  })
  .strict();
export const cachePlanSchema = z
  .object({
    groups: z
      .array(z.enum(cacheGroups))
      .min(1)
      .max(32)
      .default([...cacheGroups]),
    maxBytes: z
      .number()
      .int()
      .nonnegative()
      .max(1024 ** 4)
      .default(1024 ** 3),
    minAgeSeconds: z
      .number()
      .finite()
      .nonnegative()
      .max(365 * 86400)
      .default(3600),
    maxFiles: z.number().int().min(1).max(2000).default(500),
  })
  .strict();
export const cacheApplySchema = z.object({ planId: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
type CacheFile = {
  file: string;
  group: (typeof cacheGroups)[number];
  bytes: number;
  mtimeMs: number;
  leased: boolean;
  referenced: boolean;
};
function projectMedia(root: string, snapshot?: Snapshot) {
  const files = new Set<string>();
  if (snapshot) {
    for (const asset of snapshot.project.assets) files.add(path.resolve(root, asset.path));
    for (const drawing of snapshot.project.drawings) files.add(path.resolve(root, drawing.path));
    const visit = (node: Node) => {
      if (node.source) files.add(path.resolve(root, node.source));
      for (const child of node.structure?.added ?? []) visit(child as Node);
      for (const edit of Object.values(node.structure?.nested ?? {}))
        for (const child of edit.added) visit(child as Node);
    };
    for (const scene of snapshot.scenes) for (const node of scene.nodes) visit(node);
  }
  return files;
}
async function scanCaches(
  root: string,
  groups: readonly (typeof cacheGroups)[number][],
  snapshot?: Snapshot,
) {
  const files: CacheFile[] = [],
    skipped: string[] = [];
  let scanned = 0;
  const base = safePath(root, '.vmotion'),
    leases = activeCacheFiles(),
    referenced = projectMedia(root, snapshot),
    visit = async (relative: string, group: (typeof cacheGroups)[number]) => {
      let info;
      try {
        info = await lstat(safePath(root, relative));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw e;
      }
      if (info.isSymbolicLink()) {
        skipped.push(relative);
        return;
      }
      if (++scanned > 20000)
        throw new VmotionError(
          'CACHE_SCAN_BUDGET',
          'Cache scan exceeds 20000 entries; inspect fewer groups',
        );
      if (info.isDirectory()) {
        for (const child of await readdir(safePath(root, relative)))
          await visit(`${relative}/${child}`, group);
      } else if (info.isFile() && !relative.includes('.partial') && !relative.endsWith('.tmp')) {
        const absolute = path.resolve(root, relative);
        let leased = leases.includes(absolute) || leases.includes(absolute.replace(/\.json$/, ''));
        if (group === 'proxies-v2') {
          leased ||= leases.some(
            (file) =>
              path.dirname(file) === path.dirname(absolute) &&
              path.dirname(file) !== safePath(root, '.vmotion/proxies-v2'),
          );
          if (relative.includes('/index-'))
            try {
              const record = JSON.parse(await readFile(absolute, 'utf8'));
              if (typeof record.output === 'string')
                leased ||= leases.includes(path.resolve(root, record.output));
            } catch {}
        }
        files.push({
          file: relative,
          group,
          bytes: info.size,
          mtimeMs: info.mtimeMs,
          leased,
          referenced: referenced.has(absolute),
        });
      }
    };
  try {
    const baseInfo = await lstat(base);
    if (baseInfo.isSymbolicLink())
      throw new VmotionError('CACHE_PATH', 'Cache root is a link; cleanup is refused');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { files, skipped };
    throw e;
  }
  for (const group of new Set(groups)) await visit(`.vmotion/${group}`, group);
  return { files, skipped };
}
export async function inspectCaches(root: string, raw: unknown, snapshot?: Snapshot) {
  const request = cacheInspectSchema.parse(raw),
    scan = await scanCaches(root, request.groups, snapshot),
    groups = request.groups.map((group) => {
      const files = scan.files.filter((f) => f.group === group);
      return {
        group,
        files: files.length,
        bytes: files.reduce((n, f) => n + f.bytes, 0),
        leasedFiles: files.filter((f) => f.leased).length,
        referencedFiles: files.filter((f) => f.referenced).length,
      };
    });
  return {
    root: safePath(root, '.vmotion'),
    totalBytes: groups.reduce((n, g) => n + g.bytes, 0),
    groups,
    protectedGroups,
    skippedLinks: scan.skipped,
    ...(request.detail
      ? {
          files: {
            total: scan.files.length,
            offset: request.offset,
            items: scan.files.slice(request.offset, request.offset + request.limit),
            hasMore: request.offset + request.limit < scan.files.length,
          },
        }
      : {}),
    policy:
      'Only regenerable named cache groups are selectable; project assets/source, history, stored candidates, render checkpoints and loaded component bundles are excluded. Cleanup uses a fixed file plan with size/mtime checks and path revalidation.',
  };
}
export async function planCacheCleanup(root: string, raw: unknown, snapshot?: Snapshot) {
  const request = cachePlanSchema.parse(raw),
    scan = await scanCaches(root, request.groups, snapshot),
    total = scan.files.reduce((n, f) => n + f.bytes, 0),
    now = Date.now(),
    eligible = scan.files
      .filter((f) => !f.leased && !f.referenced && now - f.mtimeMs >= request.minAgeSeconds * 1000)
      .sort((a, b) => a.mtimeMs - b.mtimeMs || a.file.localeCompare(b.file)),
    selected: CacheFile[] = [];
  let remaining = total;
  for (const file of eligible) {
    if (remaining <= request.maxBytes || selected.length >= request.maxFiles) break;
    selected.push(file);
    remaining -= file.bytes;
  }
  const plan = {
      kind: 'cache-cleanup',
      version: 1,
      root: path.resolve(root),
      policy: request,
      files: selected,
    },
    content = json(plan),
    planId = hash(content);
  await atomicWrite(safePath(root, `.vmotion/cache-plans/${planId}.json`), content);
  return {
    planId,
    beforeBytes: total,
    proposedBytes: selected.reduce((n, f) => n + f.bytes, 0),
    afterBytes: remaining,
    fileCount: selected.length,
    protectedGroups,
    leasedFiles: scan.files.filter((f) => f.leased).length,
    referencedFiles: scan.files.filter((f) => f.referenced).length,
    skippedLinks: scan.skipped,
    completeWithinPolicy: remaining <= request.maxBytes,
    apply: { planId },
    note: 'The plan does not delete files. Application rejects busy rendering/audio/proxy work; changed/leased/link targets are skipped. Regenerable caches have no undo; source/history/candidates/checkpoints remain intact.',
  };
}
export async function applyCacheCleanup(root: string, raw: unknown, snapshot?: Snapshot) {
  const request = cacheApplySchema.parse(raw),
    text = await readFile(safePath(root, `.vmotion/cache-plans/${request.planId}.json`), 'utf8');
  if (Buffer.byteLength(text) > 2 * 1024 * 1024 || hash(text) !== request.planId)
    throw new VmotionError('CACHE_PLAN_CHANGED', 'Cache plan failed its content check');
  const plan = JSON.parse(text);
  if (
    plan.kind !== 'cache-cleanup' ||
    plan.version !== 1 ||
    plan.root !== path.resolve(root) ||
    !Array.isArray(plan.files) ||
    plan.files.length > 2000
  )
    throw new VmotionError('CACHE_PLAN', 'Cache plan is invalid for this project');
  const baseInfo = await lstat(safePath(root, '.vmotion'));
  if (baseInfo.isSymbolicLink())
    throw new VmotionError('CACHE_PATH', 'Cache root is a link; cleanup is refused');
  const base = await realpath(safePath(root, '.vmotion')),
    removed: string[] = [],
    skipped: Array<{ file: string; reason: string }> = [];
  if (!base.startsWith((await realpath(root)) + path.sep))
    throw new VmotionError('CACHE_PATH', 'Resolved cache root leaves the project');
  let reclaimedBytes = 0;
  const references = projectMedia(root, snapshot);
  for (const item of plan.files) {
    const file: string = typeof item?.file === 'string' ? item.file : '';
    if (
      !cacheGroups.some((group) => file.startsWith(`.vmotion/${group}/`)) ||
      file.includes('\\') ||
      file.split('/').some((part) => part === '..' || part === '')
    )
      throw new VmotionError('CACHE_PATH', 'Cache plan contains a protected or invalid path');
    try {
      const absolute = safePath(root, file),
        info = await lstat(absolute),
        resolved = await realpath(absolute),
        group = file.split('/')[1],
        allowedRoot = path.join(base, group);
      if (references.has(absolute)) {
        skipped.push({ file, reason: 'project-reference' });
        continue;
      }
      if (info.isSymbolicLink() || !info.isFile() || !resolved.startsWith(allowedRoot + path.sep)) {
        skipped.push({ file, reason: 'link-or-outside-cache' });
        continue;
      }
      if (activeCacheFiles().includes(absolute)) {
        skipped.push({ file, reason: 'leased' });
        continue;
      }
      if (info.size !== item.bytes || info.mtimeMs !== item.mtimeMs) {
        skipped.push({ file, reason: 'changed' });
        continue;
      }
      await unlink(absolute);
      removed.push(file);
      reclaimedBytes += info.size;
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      skipped.push({ file, reason: code ?? (e as Error).message });
    }
  }
  return {
    planId: request.planId,
    removedFiles: removed.length,
    reclaimedBytes,
    skipped,
    ...(skipped.length ? { incomplete: true } : {}),
    protectedGroups,
  };
}
