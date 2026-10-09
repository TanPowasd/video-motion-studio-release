import { AsyncLocalStorage } from 'node:async_hooks';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { z } from 'zod';
import type { Snapshot } from '../core/model.js';
import { atomicWrite, safePath } from '../platform/project-files.js';

/**
 * Change journal: records WHO changed the project (the Studio UI, an MCP client, the CLI
 * or a direct file edit), WHEN, and WHAT stable objects were touched. It is metadata next
 * to the shared undo history — it never changes project files, revisions or the RPC
 * contract of existing methods. Entries are kept in memory (bounded) and persisted
 * best-effort to `.vmotion/changes.json` so another process (an MCP server or CLI that
 * edits the project while the editor is open) can tell the editor where a file change
 * came from.
 */
export type ChangeOriginKind = 'ui' | 'mcp' | 'cli' | 'file';
export interface ChangeOrigin {
  kind: ChangeOriginKind;
  /** MCP client name as reported in the MCP handshake (e.g. "claude-code"). */
  client?: string;
  /** Tool or RPC method that produced the change (e.g. "graphics_plan"). */
  tool?: string;
  /** Optional short intent text supplied by the caller. */
  intent?: string;
}
export type ChangeAction = 'edit' | 'undo' | 'redo' | 'external';
export interface ChangeTarget {
  kind: 'project' | 'scene' | 'node' | 'sequence' | 'clip' | 'asset' | 'file';
  change: 'added' | 'removed' | 'changed';
  id?: string;
  sceneId?: string;
  sequenceId?: string;
  name?: string;
  /** Changed top-level fields (for `changed`), at most 8. */
  fields?: string[];
  /** Before → after for changed scalar fields (numbers, booleans, short strings). */
  values?: Record<string, [unknown, unknown]>;
}
export interface ChangeEntry extends ChangeOrigin {
  id: string;
  at: number;
  action: ChangeAction;
  revision: string;
  previous: string;
  files: string[];
  targets: ChangeTarget[];
  /** True when more than MAX_TARGETS objects changed. */
  truncated?: boolean;
  /** Process that recorded the entry; used to attribute cross-process file changes. */
  pid?: number;
}

export const CHANGE_JOURNAL_FILE = '.vmotion/changes.json';
const MAX_ENTRIES = 200,
  MAX_TARGETS = 40,
  MAX_FIELDS = 8;

const origins = new AsyncLocalStorage<ChangeOrigin>();
/** Runs `fn` with `origin` attributed to every project change it causes. */
export function withChangeOrigin<T>(origin: ChangeOrigin, fn: () => T): T {
  return origins.run(sanitizeOrigin(origin), fn);
}
export function currentChangeOrigin(): ChangeOrigin | undefined {
  return origins.getStore();
}
const short = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim() ? value.trim().slice(0, max) : undefined;
export function sanitizeOrigin(origin: ChangeOrigin): ChangeOrigin {
  return {
    kind: origin.kind,
    ...(short(origin.client, 80) ? { client: short(origin.client, 80) } : {}),
    ...(short(origin.tool, 80) ? { tool: short(origin.tool, 80) } : {}),
    ...(short(origin.intent, 240) ? { intent: short(origin.intent, 240) } : {}),
  };
}

/** Formatting-only rewrites of JSON files (e.g. first normalised save) are not changes. */
function sameJson(a: string | undefined, b: string | undefined, file: string) {
  if (a === undefined || b === undefined || !file.endsWith('.json')) return false;
  try {
    return isDeepStrictEqual(JSON.parse(a), JSON.parse(b));
  } catch {
    return false;
  }
}
const keyed = <T extends { id: string }>(items: T[] | undefined) =>
  new Map((items ?? []).map((item) => [item.id, item] as const));
const scalar = (v: unknown) =>
  typeof v === 'number' || typeof v === 'boolean' || (typeof v === 'string' && v.length <= 60) || v === undefined;
function scalarValues(fields: string[], a: unknown, b: unknown) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return undefined;
  const out: Record<string, [unknown, unknown]> = {};
  for (const f of fields) {
    const x = (a as Record<string, unknown>)[f],
      y = (b as Record<string, unknown>)[f];
    if (scalar(x) && scalar(y)) out[f] = [x ?? null, y ?? null];
  }
  return Object.keys(out).length ? out : undefined;
}
function changedFields(a: Record<string, unknown>, b: Record<string, unknown>, skip: string[] = []) {
  const fields: string[] = [];
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (skip.includes(key)) continue;
    if (!isDeepStrictEqual(a[key], b[key])) fields.push(key);
  }
  return fields;
}

/** Stable-ID level difference between two project snapshots. */
export function diffSnapshots(before: Snapshot, after: Snapshot) {
  const files = [...new Set([...Object.keys(before.files), ...Object.keys(after.files)])]
      .filter(
        (f) =>
          before.files[f] !== after.files[f] && !f.startsWith('.vmotion/') && !sameJson(before.files[f], after.files[f], f),
      )
      .sort(),
    targets: ChangeTarget[] = [];
  const push = (target: ChangeTarget, a?: unknown, b?: unknown) => {
    if (target.fields) {
      target.fields = target.fields.slice(0, MAX_FIELDS);
      const values = scalarValues(target.fields, a, b);
      if (values) target.values = values;
    }
    targets.push(target);
  };
  const projectFields = changedFields(
    before.project as unknown as Record<string, unknown>,
    after.project as unknown as Record<string, unknown>,
    ['assets'],
  );
  if (projectFields.length)
    push({ kind: 'project', change: 'changed', fields: projectFields }, before.project, after.project);
  const assetsBefore = keyed(before.project.assets),
    assetsAfter = keyed(after.project.assets);
  for (const [id, asset] of assetsAfter)
    if (!assetsBefore.has(id)) push({ kind: 'asset', change: 'added', id, name: asset.name });
    else if (!isDeepStrictEqual(assetsBefore.get(id), asset))
      push({
        kind: 'asset',
        change: 'changed',
        id,
        name: asset.name,
        fields: changedFields(assetsBefore.get(id) as never, asset as never),
      }, assetsBefore.get(id), asset);
  for (const [id, asset] of assetsBefore)
    if (!assetsAfter.has(id)) push({ kind: 'asset', change: 'removed', id, name: asset.name });
  const scenesBefore = keyed(before.scenes),
    scenesAfter = keyed(after.scenes);
  for (const [id, scene] of scenesAfter) {
    const old = scenesBefore.get(id);
    if (!old) {
      push({ kind: 'scene', change: 'added', id, sceneId: id, name: scene.name });
      continue;
    }
    if (isDeepStrictEqual(old, scene)) continue;
    const fields = changedFields(old as never, scene as never, ['nodes']);
    if (fields.length)
      push({ kind: 'scene', change: 'changed', id, sceneId: id, name: scene.name, fields }, old, scene);
    const nodesBefore = keyed(old.nodes),
      nodesAfter = keyed(scene.nodes);
    for (const [nodeId, node] of nodesAfter) {
      const previous = nodesBefore.get(nodeId);
      if (!previous) push({ kind: 'node', change: 'added', id: nodeId, sceneId: id, name: node.name });
      else if (!isDeepStrictEqual(previous, node))
        push({
          kind: 'node',
          change: 'changed',
          id: nodeId,
          sceneId: id,
          name: node.name,
          fields: changedFields(previous as never, node as never),
        }, previous, node);
    }
    for (const [nodeId, node] of nodesBefore)
      if (!nodesAfter.has(nodeId))
        push({ kind: 'node', change: 'removed', id: nodeId, sceneId: id, name: node.name });
  }
  for (const [id, scene] of scenesBefore)
    if (!scenesAfter.has(id)) push({ kind: 'scene', change: 'removed', id, sceneId: id, name: scene.name });
  const sequencesBefore = keyed(before.sequences),
    sequencesAfter = keyed(after.sequences);
  for (const [id, sequence] of sequencesAfter) {
    const old = sequencesBefore.get(id);
    if (!old) {
      push({ kind: 'sequence', change: 'added', id, sequenceId: id, name: sequence.name });
      continue;
    }
    if (isDeepStrictEqual(old, sequence)) continue;
    const fields = changedFields(old as never, sequence as never, ['tracks']);
    if (fields.length)
      push({ kind: 'sequence', change: 'changed', id, sequenceId: id, name: sequence.name, fields }, old, sequence);
    const clips = (s: typeof sequence) =>
        new Map(s.tracks.flatMap((t) => t.clips.map((c) => [c.id, { ...c, trackId: t.id }] as const))),
      clipsBefore = clips(old),
      clipsAfter = clips(sequence);
    for (const [clipId, clip] of clipsAfter) {
      const previous = clipsBefore.get(clipId);
      if (!previous)
        push({ kind: 'clip', change: 'added', id: clipId, sequenceId: id, sceneId: clip.sceneId, name: clip.name });
      else if (!isDeepStrictEqual(previous, clip))
        push({
          kind: 'clip',
          change: 'changed',
          id: clipId,
          sequenceId: id,
          sceneId: clip.sceneId,
          name: clip.name,
          fields: changedFields(previous as never, clip as never),
        }, previous, clip);
    }
    for (const [clipId, clip] of clipsBefore)
      if (!clipsAfter.has(clipId))
        push({ kind: 'clip', change: 'removed', id: clipId, sequenceId: id, sceneId: clip.sceneId, name: clip.name });
  }
  for (const [id, sequence] of sequencesBefore)
    if (!sequencesAfter.has(id))
      push({ kind: 'sequence', change: 'removed', id, sequenceId: id, name: sequence.name });
  // Source files (components, plugins…) that are not represented by a structured target.
  for (const file of files)
    if (!/^(project\.vmotion\.json|project\.json|scenes\/|sequences\/)/.test(file))
      push({ kind: 'file', change: after.files[file] === undefined ? 'removed' : before.files[file] === undefined ? 'added' : 'changed', id: file, name: file });
  return {
    files,
    targets: targets.slice(0, MAX_TARGETS),
    truncated: targets.length > MAX_TARGETS,
  };
}

const entrySchema = z
  .object({
    id: z.string().max(80),
    at: z.number(),
    kind: z.enum(['ui', 'mcp', 'cli', 'file']),
    client: z.string().max(80).optional(),
    tool: z.string().max(80).optional(),
    intent: z.string().max(240).optional(),
    action: z.enum(['edit', 'undo', 'redo', 'external']),
    revision: z.string().max(128),
    previous: z.string().max(128),
    files: z.array(z.string().max(400)).max(400),
    targets: z.array(z.record(z.unknown())).max(MAX_TARGETS),
    truncated: z.boolean().optional(),
    pid: z.number().optional(),
  })
  .passthrough();
const fileSchema = z.object({ version: z.literal(1), entries: z.array(z.unknown()).max(1000) });

export class ChangeJournal {
  entries: ChangeEntry[] = [];
  private writing: Promise<unknown> = Promise.resolve();
  constructor(private root: string) {}
  private async readDisk(): Promise<ChangeEntry[]> {
    try {
      const raw = fileSchema.parse(
        JSON.parse(await readFile(safePath(this.root, CHANGE_JOURNAL_FILE), 'utf8')),
      );
      return raw.entries.flatMap((e) => {
        const parsed = entrySchema.safeParse(e);
        return parsed.success ? [parsed.data as unknown as ChangeEntry] : [];
      });
    } catch {
      return [];
    }
  }
  /** Loads the persisted tail so the feed survives reopening the project. */
  async open() {
    this.entries = (await this.readDisk()).slice(-MAX_ENTRIES);
    return this;
  }
  /**
   * Origin recorded by ANOTHER process for `revision` (an MCP server or CLI that ran
   * without the editor). Used when this process only observes a file change.
   */
  async foreignOrigin(revision: string): Promise<ChangeOrigin | undefined> {
    const match = (await this.readDisk())
      .reverse()
      .find((e) => e.revision === revision && e.pid !== process.pid);
    return match ? sanitizeOrigin(match) : undefined;
  }
  record(
    origin: ChangeOrigin,
    action: ChangeAction,
    before: Snapshot,
    after: Snapshot,
  ): ChangeEntry | undefined {
    if (before.revision === after.revision) return undefined;
    const diff = diffSnapshots(before, after);
    // Formatting-only rewrites carry no reviewable change.
    if (!diff.files.length && !diff.targets.length) return undefined;
    const entry: ChangeEntry = {
        id: randomUUID(),
        at: Date.now(),
        ...sanitizeOrigin(origin),
        action,
        revision: after.revision,
        previous: before.revision,
        files: diff.files,
        targets: diff.targets,
        ...(diff.truncated ? { truncated: true } : {}),
        pid: process.pid,
      };
    this.entries.push(entry);
    if (this.entries.length > MAX_ENTRIES) this.entries.splice(0, this.entries.length - MAX_ENTRIES);
    this.persist();
    return entry;
  }
  /** Most recent entries, newest last. */
  tail(limit = 80) {
    return this.entries.slice(-limit);
  }
  private persist() {
    // Best effort: the journal is advisory metadata, never a reason to fail an edit.
    // Merge with entries other processes (MCP server, CLI) wrote meanwhile.
    this.writing = this.writing
      .then(async () => {
        const merged = new Map<string, ChangeEntry>();
        for (const e of [...(await this.readDisk()), ...this.entries]) merged.set(e.id, e);
        const entries = [...merged.values()].sort((a, b) => a.at - b.at).slice(-MAX_ENTRIES);
        await atomicWrite(
          safePath(this.root, CHANGE_JOURNAL_FILE),
          JSON.stringify({ version: 1, entries }) + '\n',
        );
      })
      .catch(() => {});
  }
  flush() {
    return this.writing;
  }
}
