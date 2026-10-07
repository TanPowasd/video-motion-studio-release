import { EventEmitter } from 'node:events';
import { readFile, stat, copyFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import chokidar, { type FSWatcher } from 'chokidar';
import {
  operationSchema,
  VmotionError,
  type Snapshot,
  type Operation,
  type Conflict,
  type Diagnostic,
} from '../core/model.js';
import { mergeJson, mergeText } from '../core/merge.js';
import {
  loadProject,
  parseFiles,
  serialize,
  saveFiles,
  revision,
  validateSnapshot,
  safePath,
  readProjectFiles,
} from './project.js';
import { HISTORY_FILE, HistoryStore, boundedHistory } from './history.js';
import { applyOperations } from './operations.js';

export class ProjectService extends EventEmitter {
  snapshot!: Snapshot;
  diagnostics: Diagnostic[] = [];
  conflicts: Conflict[] = [];
  selection: string[] = [];
  pendingFiles?: Record<string, string>;
  extraValidation?: (snapshot: Snapshot) => Promise<Diagnostic[]>;
  private diskFiles: Record<string, string> = {};
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private watcher?: FSWatcher;
  private queue: Promise<unknown> = Promise.resolve();
  private timer?: NodeJS.Timeout;
  private historyStore: HistoryStore;
  constructor(public root: string) {
    super();
    this.root = path.resolve(root);
    this.historyStore = new HistoryStore(this.root);
  }
  async open(watch = true) {
    this.snapshot = await loadProject(this.root);
    this.diskFiles = { ...this.snapshot.files };
    this.diagnostics = await this.validate(this.snapshot);
    try {
      const history = await this.historyStore.open(this.snapshot);
      this.undoStack = history.undo;
      this.redoStack = history.redo;
    } catch (e) {
      this.diagnostics.push({
        severity: 'warning',
        code: 'HISTORY_UNAVAILABLE',
        message: `操作历史无法恢复：${(e as Error).message}`,
      });
    }
    if (watch) {
      this.watcher = chokidar.watch(this.root, {
        ignored: (p) =>
          p.includes(`${path.sep}.vmotion`) ||
          p.includes(`${path.sep}node_modules`) ||
          p.includes(`${path.sep}exports`) ||
          p.endsWith('.tmp'),
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 50 },
      });
      this.watcher.on('all', () => {
        clearTimeout(this.timer);
        this.timer = setTimeout(
          () => void this.exclusive(() => this.reload()).catch((e) => this.report(e)),
          120,
        );
      });
    }
    return this;
  }
  private report(e: unknown) {
    this.diagnostics = [
      {
        severity: 'error',
        code: e instanceof VmotionError ? e.code : 'INVALID_PROJECT',
        message: (e as Error).message,
        ...(e instanceof VmotionError ? (e.details as object) : {}),
      },
    ];
    this.emit('change');
  }
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.queue.then(fn, fn);
    this.queue = result.catch(() => {});
    return result;
  }
  state() {
    return {
      snapshot: this.snapshot,
      pendingFiles: this.pendingFiles,
      diagnostics: this.diagnostics,
      conflicts: this.conflicts,
      selection: this.selection,
      canUndo: this.undoStack.length > 0,
      canRedo: this.redoStack.length > 0,
    };
  }
  async validate(snapshot: Snapshot) {
    return [
      ...(await validateSnapshot(this.root, snapshot)),
      ...((await this.extraValidation?.(snapshot)) ?? []),
    ];
  }
  private remember(previous: Snapshot) {
    this.undoStack.push(structuredClone(previous));
    if (this.undoStack.length > 100) this.undoStack.shift();
    this.redoStack = [];
  }
  private async saveWithHistory(
    snapshot: Snapshot,
    before: Record<string, string>,
    undo: Snapshot[],
    redo: Snapshot[],
  ) {
    const history = await this.historyStore.prepare(snapshot, undo, redo),
      diskBefore = { ...before };
    if (history.previous !== undefined) diskBefore[HISTORY_FILE] = history.previous;
    await saveFiles(this.root, { ...snapshot.files, [HISTORY_FILE]: history.next }, diskBefore);
    this.historyStore.commit(history.next);
    this.undoStack = history.undo;
    this.redoStack = history.redo;
    // Snapshots are cached immutable resources; prune only after the journal committed their index.
    await this.historyStore.prune().catch(() => {});
  }
  async reload() {
    const incomingFiles = await readProjectFiles(this.root, this.snapshot.files);
    let incoming: Snapshot;
    try {
      incoming = parseFiles(incomingFiles);
    } catch (e) {
      this.pendingFiles = incomingFiles;
      this.report(e);
      if (e instanceof VmotionError && e.code === 'FORMAT_VERSION') throw e;
      return;
    }
    if (incoming.revision === revision(this.diskFiles)) {
      if (this.pendingFiles) {
        this.pendingFiles = undefined;
        this.diagnostics = await this.validate(this.snapshot);
        this.emit('change');
      }
      return;
    }
    const files: Record<string, string> = {},
      conflicts: Conflict[] = [];
    for (const file of new Set([
      ...Object.keys(this.diskFiles),
      ...Object.keys(this.snapshot.files),
      ...Object.keys(incoming.files),
    ])) {
      const base = this.diskFiles[file],
        ours = this.snapshot.files[file],
        theirs = incoming.files[file];
      if (base === ours) {
        if (theirs !== undefined) files[file] = theirs;
        continue;
      }
      if (base === theirs || ours === theirs) {
        if (ours !== undefined) files[file] = ours;
        continue;
      }
      if (
        file.endsWith('.json') &&
        base !== undefined &&
        ours !== undefined &&
        theirs !== undefined
      ) {
        const merged = mergeJson(JSON.parse(base), JSON.parse(ours), JSON.parse(theirs), file);
        files[file] = JSON.stringify(merged.value, null, 2) + '\n';
        conflicts.push(...merged.conflicts);
      } else if (base !== undefined && ours !== undefined && theirs !== undefined) {
        const merged = mergeText(base, ours, theirs, file);
        files[file] = merged.value;
        conflicts.push(...merged.conflicts);
      } else {
        if (ours !== undefined) files[file] = ours;
        conflicts.push({ file, path: '$file', base, ours, theirs });
      }
    }
    const candidate = parseFiles(files),
      diagnostics = await this.validate(candidate);
    if (diagnostics.some((d) => d.severity === 'error')) {
      this.pendingFiles = files;
      this.diagnostics = diagnostics;
      this.emit('change');
      return;
    }
    this.remember(this.snapshot);
    this.snapshot = candidate;
    this.pendingFiles = undefined;
    this.diskFiles = incoming.files;
    this.conflicts = conflicts;
    this.diagnostics = diagnostics;
    if (!conflicts.length && candidate.revision === incoming.revision)
      await this.saveWithHistory(candidate, this.diskFiles, this.undoStack, this.redoStack);
    this.emit('change');
  }
  transact(
    operations: Operation[],
    expectedRevision?: string,
    save = true,
    beforeCommit?: (candidate: Snapshot) => Promise<void>,
  ) {
    return this.exclusive(async () => {
      if (!operations.length || operations.length > 1000)
        throw new VmotionError('OPERATIONS', 'Expected 1–1000 operations');
      operations = operations.map((op) => operationSchema.parse(op)) as Operation[];
      await this.reload();
      if (
        this.pendingFiles &&
        !operations.every((op) => op.type === 'writeSource' || op.type === 'editFiles')
      )
        throw new VmotionError(
          'INVALID_ON_DISK',
          'External files are invalid. Fix the reported source files before applying unrelated edits.',
          this.diagnostics,
        );
      if (this.conflicts.length)
        throw new VmotionError(
          'UNRESOLVED_CONFLICTS',
          'Resolve file conflicts before editing',
          this.conflicts,
        );
      if (expectedRevision && expectedRevision !== this.snapshot.revision)
        throw new VmotionError(
          'REVISION_CONFLICT',
          'The project changed; inspect the current revision and retry',
          { expected: expectedRevision, actual: this.snapshot.revision },
        );
      const previous = structuredClone(this.snapshot),
        candidate = this.pendingFiles
          ? { ...this.snapshot, files: { ...this.pendingFiles } }
          : this.snapshot;
      const diskBefore = this.pendingFiles
        ? await readProjectFiles(this.root, this.snapshot.files)
        : this.diskFiles;
      const checked = applyOperations(this.root, candidate, operations),
        diagnostics = await this.validate(checked);
      if (diagnostics.some((d) => d.severity === 'error'))
        throw new VmotionError(
          'VALIDATION_FAILED',
          'Transaction failed validation; no changes saved',
          diagnostics,
        );
      await beforeCommit?.(checked);
      if (checked.revision === previous.revision) {
        if (save) {
          await this.saveWithHistory(checked, diskBefore, this.undoStack, this.redoStack);
          this.diskFiles = { ...checked.files };
        }
        // A repaired pending file can match the active revision exactly. Accept its
        // validated state without adding an undo step or leaving stale error evidence.
        const evidenceChanged =
          !!this.pendingFiles || !isDeepStrictEqual(this.diagnostics, diagnostics);
        this.snapshot = checked;
        this.pendingFiles = undefined;
        this.diagnostics = diagnostics;
        if (evidenceChanged) this.emit('change');
        return this.state();
      }
      if (save) {
        await this.saveWithHistory(checked, diskBefore, [...this.undoStack, previous], []);
        this.diskFiles = { ...checked.files };
      } else {
        this.remember(previous);
        const bounded = boundedHistory(this.undoStack, this.redoStack);
        this.undoStack = bounded.undo;
        this.redoStack = bounded.redo;
      }
      this.snapshot = checked;
      this.pendingFiles = undefined;
      this.diagnostics = diagnostics;
      this.emit('change');
      return this.state();
    });
  }
  save() {
    return this.exclusive(async () => {
      await this.reload();
      if (this.pendingFiles)
        throw new VmotionError(
          'INVALID_ON_DISK',
          'Invalid external files were preserved; repair them before saving',
          this.diagnostics,
        );
      if (this.conflicts.length)
        throw new VmotionError('UNRESOLVED_CONFLICTS', 'Resolve conflicts before saving');
      await this.saveWithHistory(this.snapshot, this.diskFiles, this.undoStack, this.redoStack);
      this.diskFiles = { ...this.snapshot.files };
      return this.state();
    });
  }
  resolve(index: number, choice: 'ours' | 'theirs') {
    return this.exclusive(async () => {
      const c = this.conflicts[index];
      if (!c) throw new VmotionError('NOT_FOUND', 'Conflict not found');
      const files = { ...this.snapshot.files };
      if (c.path === '$source' || c.path === '$file') {
        const value = choice === 'ours' ? c.ours : c.theirs;
        if (value === undefined) delete files[c.file];
        else files[c.file] = String(value);
      } else {
        const tree = JSON.parse(files[c.file]);
        const parts = c.path.split('/').filter(Boolean);
        let target: any = tree;
        for (const part of parts.slice(0, -1))
          target = Array.isArray(target) ? target.find((n: any) => n.id === part) : target[part];
        const key = parts.at(-1)!;
        if (key === '$order') {
          const order = (choice === 'ours' ? c.ours : c.theirs) as string[];
          target.sort(
            (a: { id: string }, b: { id: string }) => order.indexOf(a.id) - order.indexOf(b.id),
          );
        } else if (Array.isArray(target)) {
          const i = target.findIndex((n: any) => n.id === key),
            value = choice === 'ours' ? c.ours : c.theirs;
          if (value === undefined && i >= 0) target.splice(i, 1);
          else if (i >= 0) target[i] = value;
          else if (value !== undefined) target.push(value);
        } else {
          const value = choice === 'ours' ? c.ours : c.theirs;
          if (value === undefined) delete target[key];
          else target[key] = value;
        }
        files[c.file] = JSON.stringify(tree, null, 2) + '\n';
      }
      const candidate = parseFiles(files);
      this.snapshot = candidate;
      this.conflicts.splice(index, 1);
      if (!this.conflicts.length) {
        const diagnostics = await validateSnapshot(this.root, candidate);
        if (diagnostics.some((d) => d.severity === 'error'))
          throw new VmotionError('VALIDATION_FAILED', 'Resolution is invalid', diagnostics);
        await saveFiles(this.root, files, this.diskFiles);
        this.diskFiles = { ...files };
      }
      this.emit('change');
      return this.state();
    });
  }
  undo() {
    return this.history('undo');
  }
  redo() {
    return this.history('redo');
  }
  private history(direction: 'undo' | 'redo') {
    return this.exclusive(async () => {
      await this.reload();
      if (this.conflicts.length)
        throw new VmotionError('UNRESOLVED_CONFLICTS', 'Resolve conflicts before undo/redo');
      if (this.pendingFiles)
        throw new VmotionError('INVALID_ON_DISK', 'Fix invalid external files before undo/redo');
      const from = direction === 'undo' ? this.undoStack : this.redoStack,
        to = direction === 'undo' ? this.redoStack : this.undoStack;
      const value = from.at(-1);
      if (!value) return this.state();
      const diagnostics = await this.validate(value);
      // File availability is external to a recorded source state. Undoing a relink may
      // restore a missing path; keep that diagnostic and the last-good preview.
      if (diagnostics.some((d) => d.severity === 'error' && d.code !== 'MISSING_ASSET'))
        throw new VmotionError(
          'VALIDATION_FAILED',
          'Undo/redo target is invalid; project and history preserved',
          diagnostics,
        );
      const undo = direction === 'undo' ? from.slice(0, -1) : [...to, this.snapshot],
        redo = direction === 'redo' ? from.slice(0, -1) : [...to, this.snapshot];
      await this.saveWithHistory(value, this.diskFiles, undo, redo);
      this.snapshot = value;
      this.diskFiles = { ...value.files };
      this.diagnostics = diagnostics;
      this.emit('change');
      return this.state();
    });
  }
  async importAsset(
    file: string,
    type: 'image' | 'video' | 'audio' | 'font' | 'drawing',
    copy = false,
    metadata: Record<string, unknown> = {},
  ) {
    const absolute = path.resolve(file);
    const info = await stat(absolute);
    if (!info.isFile()) throw new VmotionError('ASSET_FILE', 'Asset is not a file');
    const id = randomUUID();
    let source = absolute;
    if (copy) {
      source = safePath(this.root, `assets/${id}${path.extname(file)}`);
      await mkdir(path.dirname(source), { recursive: true });
      await copyFile(absolute, source);
    }
    const state = await this.transact([
      {
        type: 'addAsset',
        asset: {
          id,
          name: path.basename(file),
          path: path.relative(this.root, source).split(path.sep).join('/'),
          type,
          managed: copy,
          fingerprint: `${info.size}:${info.mtimeMs}`,
          metadata,
        },
      },
    ]);
    return { ...state, importedAsset: state.snapshot.project.assets.find((a) => a.id === id) };
  }
  async close() {
    clearTimeout(this.timer);
    await this.watcher?.close();
    await this.queue;
  }
}
