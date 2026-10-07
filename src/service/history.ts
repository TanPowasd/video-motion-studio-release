import { readFile, readdir, stat, unlink } from 'node:fs/promises';
import { promisify } from 'node:util';
import { gzip, gunzip } from 'node:zlib';
import { z } from 'zod';
import { atomicWrite, json, parseFiles, safePath } from './project.js';
import { VmotionError, type Snapshot } from '../core/model.js';
const compress = promisify(gzip),
  decompress = promisify(gunzip),
  hash = z.string().regex(/^[a-f0-9]{64}$/);
const stateSchema = z
  .object({
    version: z.literal(1),
    head: hash,
    undo: z.array(hash).max(100),
    redo: z.array(hash).max(100),
  })
  .strict();
export const HISTORY_FILE = '.vmotion/undo/state.json';
const budget = 64 * 1024 * 1024;
export function boundedHistory(undo: Snapshot[], redo: Snapshot[]) {
  undo = undo.slice(-100);
  redo = redo.slice(-100);
  const size = (n: Snapshot) => Buffer.byteLength(JSON.stringify(n.files)),
    us = undo.map(size),
    rs = redo.map(size);
  let total = [...us, ...rs].reduce((a, b) => a + b, 0);
  while (total > budget && undo.length + redo.length > 1) {
    if (undo.length >= redo.length) {
      total -= us.shift()!;
      undo.shift();
    } else {
      total -= rs.shift()!;
      redo.shift();
    }
  }
  return { undo, redo };
}
export class HistoryStore {
  private text?: string;
  constructor(private root: string) {}
  private file(revision: string) {
    return safePath(this.root, `.vmotion/undo/snapshots/${hash.parse(revision)}.json.gz`);
  }
  private async read(revision: string) {
    const bytes = await decompress(await readFile(this.file(revision)), {
        maxOutputLength: budget,
      }),
      files = z.record(z.string()).parse(JSON.parse(bytes.toString('utf8'))),
      snapshot = parseFiles(files);
    if (snapshot.revision !== revision)
      throw new VmotionError('HISTORY_HASH', 'Undo snapshot checksum does not match');
    return snapshot;
  }
  async open(current: Snapshot) {
    try {
      this.text = await readFile(safePath(this.root, HISTORY_FILE), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return this.restoreLegacy(current);
      throw e;
    }
    const stored = stateSchema.parse(JSON.parse(this.text)),
      undo: Snapshot[] = [],
      redo: Snapshot[] = [];
    let total = 0;
    for (const [references, result] of [
      [stored.undo, undo],
      [stored.redo, redo],
    ] as const) {
      for (const revision of [...references].reverse()) {
        const snapshot = await this.read(revision),
          size = Buffer.byteLength(JSON.stringify(snapshot.files));
        if (total + size > budget) break;
        total += size;
        result.unshift(snapshot);
      }
    }
    if (stored.head !== current.revision) {
      undo.push(await this.read(stored.head));
      redo.length = 0;
    }
    return boundedHistory(undo, redo);
  }
  private async restoreLegacy(current: Snapshot) {
    const directory = safePath(this.root, '.vmotion/history');
    let names: string[];
    try {
      names = await readdir(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return { undo: [], redo: [] };
      throw e;
    }
    const files = await Promise.all(
      names
        .filter((name) => /^[\w-]+\.json$/.test(name))
        .map(async (name) => ({
          name,
          info: await stat(safePath(this.root, `.vmotion/history/${name}`)),
        })),
    );
    files.sort((a, b) => b.info.mtimeMs - a.info.mtimeMs);
    const records: Array<{ before: Snapshot; after: string }> = [];
    let bytes = 0;
    for (const file of files.slice(0, 200)) {
      if (bytes + file.info.size > budget) break;
      bytes += file.info.size;
      try {
        const raw = JSON.parse(
            await readFile(safePath(this.root, `.vmotion/history/${file.name}`), 'utf8'),
          ),
          before = z.record(z.string()).parse(raw.before),
          changes = z.record(z.string().nullable()).parse(raw.after),
          after = { ...before };
        for (const [name, value] of Object.entries(changes)) {
          if (value === null) delete after[name];
          else after[name] = value;
        }
        for (const name of Object.keys(before))
          if (name.startsWith('.vmotion/')) delete before[name];
        for (const name of Object.keys(after)) if (name.startsWith('.vmotion/')) delete after[name];
        records.push({ before: parseFiles(before), after: parseFiles(after).revision });
      } catch {
        /* An interrupted or incompatible backup cannot be used as an undo target. */
      }
    }
    const undo: Snapshot[] = [],
      seen = new Set([current.revision]);
    let head = current.revision;
    while (undo.length < 100) {
      const entry = records.find((r) => r.after === head && !seen.has(r.before.revision));
      if (!entry) break;
      undo.unshift(entry.before);
      head = entry.before.revision;
      seen.add(head);
    }
    return boundedHistory(undo, []);
  }
  async prepare(head: Snapshot, undo: Snapshot[], redo: Snapshot[]) {
    const bounded = boundedHistory(undo, redo),
      all = [head, ...bounded.undo, ...bounded.redo],
      seen = new Set<string>();
    for (const snapshot of all) {
      if (seen.has(snapshot.revision)) continue;
      seen.add(snapshot.revision);
      try {
        await stat(this.file(snapshot.revision));
        continue;
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
      }
      await atomicWrite(
        this.file(snapshot.revision),
        await compress(Buffer.from(JSON.stringify(snapshot.files))),
      );
    }
    const next = json({
      version: 1,
      head: head.revision,
      undo: bounded.undo.map((s) => s.revision),
      redo: bounded.redo.map((s) => s.revision),
    });
    return { ...bounded, previous: this.text, next };
  }
  commit(text: string) {
    this.text = text;
  }
  async prune() {
    if (!this.text) return;
    const stored = stateSchema.parse(JSON.parse(this.text)),
      keep = new Set([stored.head, ...stored.undo, ...stored.redo]);
    const dir = safePath(this.root, '.vmotion/undo/snapshots');
    for (const name of await readdir(dir))
      if (/^[a-f0-9]{64}\.json\.gz$/.test(name) && !keep.has(name.slice(0, 64)))
        await unlink(safePath(this.root, `.vmotion/undo/snapshots/${name}`));
  }
}
