/*
 * Hot-reload watching for project files.
 *
 * Native watchers (inotify / ReadDirectoryChangesW / FSEvents via chokidar) do not see
 * writes made by another machine or by a FUSE daemon: on JuiceFS, NFS, SMB/CIFS, sshfs,
 * 9p/virtiofs and similar mounts an external edit is picked up late (attribute-cache
 * expiry) or never. For those roots a cheap stat poller runs next to the native watcher
 * and only looks at the files the project actually reads, so a 500 ms poll stays bounded.
 *
 *   VMOTION_WATCH=auto    (default) poll when the project root is on a network/FUSE mount
 *   VMOTION_WATCH=poll    always poll as well as watch natively
 *   VMOTION_WATCH=native  never poll (previous behaviour)
 *   VMOTION_WATCH_POLL_MS=500   poll interval, clamped to 100–10000 ms
 */
import { readFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import path from 'node:path';

export type WatchMode = 'auto' | 'native' | 'poll';
export interface WatchPlan {
  mode: WatchMode;
  /** True when the stat poller runs in addition to the native watcher. */
  poll: boolean;
  intervalMs: number;
  /** Filesystem type detected for the root (Linux mountinfo), when known. */
  filesystem?: string;
  reason: string;
}

/** Filesystem types whose changes native watchers miss or deliver late. */
const REMOTE_FS =
  /^(fuse(\..*|blk)?|nfs\d?|cifs|smb\d?|smbfs|9p|v9fs|virtiofs|sshfs|davfs|juicefs|ceph|glusterfs|lustre|gpfs|afs|ncpfs|vboxsf|vmhgfs|prl_fs|s3fs|rclone)$/i;
export function isRemoteFilesystem(type: string | undefined) {
  return !!type && REMOTE_FS.test(type);
}

/** Unescape the octal escapes mountinfo uses for spaces/tabs/newlines/backslashes. */
const unescapeMount = (value: string) =>
  value.replace(/\\([0-7]{3})/g, (_m, code: string) => String.fromCharCode(parseInt(code, 8)));

/**
 * Filesystem type of the longest mount point containing `file`, from /proc/self/mountinfo
 * (or /proc/mounts) text. Exported for tests.
 */
export function filesystemFromMountTable(table: string, file: string): string | undefined {
  let best: { point: string; type: string } | undefined;
  for (const line of table.split('\n')) {
    if (!line.trim()) continue;
    let point: string | undefined, type: string | undefined;
    const separator = line.indexOf(' - ');
    if (separator >= 0) {
      // mountinfo: id parent major:minor root mount-point options ... - fstype source options
      const left = line.slice(0, separator).split(' '),
        right = line.slice(separator + 3).split(' ');
      point = left[4];
      type = right[0];
    } else {
      // /proc/mounts: source mount-point fstype options dump pass
      const parts = line.split(' ');
      point = parts[1];
      type = parts[2];
    }
    if (!point || !type) continue;
    point = unescapeMount(point);
    const inside =
      point === '/' || file === point || file.startsWith(point.endsWith('/') ? point : point + '/');
    if (inside && (!best || point.length >= best.point.length)) best = { point, type };
  }
  return best?.type;
}

async function detectFilesystem(root: string): Promise<string | undefined> {
  let resolved = root;
  try {
    resolved = await realpath(root);
  } catch {
    /* keep the given path */
  }
  if (process.platform === 'win32') {
    // UNC shares (\\server\share) are SMB; mapped drive letters are not detectable without
    // spawning a process, so set VMOTION_WATCH=poll for those.
    return /^\\\\(?!\?\\[a-z]:)/i.test(resolved) ? 'smb' : undefined;
  }
  if (process.platform !== 'linux') return undefined;
  for (const table of ['/proc/self/mountinfo', '/proc/mounts'])
    try {
      return filesystemFromMountTable(readFileSync(table, 'utf8'), resolved);
    } catch {
      /* try the next table */
    }
  return undefined;
}

export async function planWatch(
  root: string,
  env: Record<string, string | undefined> = process.env,
): Promise<WatchPlan> {
  const raw = (env.VMOTION_WATCH ?? 'auto').trim().toLowerCase(),
    mode: WatchMode = raw === 'poll' || raw === 'native' ? raw : 'auto',
    requested = Number(env.VMOTION_WATCH_POLL_MS),
    intervalMs = Number.isFinite(requested) && requested > 0
      ? Math.min(10000, Math.max(100, Math.round(requested)))
      : 500;
  if (mode === 'native') return { mode, poll: false, intervalMs, reason: 'VMOTION_WATCH=native' };
  if (mode === 'poll') return { mode, poll: true, intervalMs, reason: 'VMOTION_WATCH=poll' };
  const filesystem = await detectFilesystem(root);
  return isRemoteFilesystem(filesystem)
    ? { mode, poll: true, intervalMs, filesystem, reason: `${filesystem} mount: native events are unreliable` }
    : { mode, poll: false, intervalMs, filesystem, reason: 'local filesystem' };
}

type Signature = string;
/**
 * Stat-polls a bounded set of project-relative files plus the listing they come from.
 * Calls onChange once per tick in which any signature (mtime, ctime, size, inode or
 * existence) changed. Ticks never overlap.
 */
export class ProjectFilePoller {
  private timer?: NodeJS.Timeout;
  private signatures = new Map<string, Signature>();
  private running = false;
  private stopped = false;
  constructor(
    private root: string,
    private list: () => Promise<string[]>,
    private onChange: () => void,
    readonly intervalMs = 500,
  ) {}
  private async snapshot() {
    const files = [...new Set(await this.list())],
      next = new Map<string, Signature>();
    await Promise.all(
      files.map(async (file) => {
        try {
          const info = await stat(path.join(this.root, file));
          next.set(file, `${info.mtimeMs}:${info.ctimeMs}:${info.size}:${info.ino}`);
        } catch {
          next.set(file, 'missing');
        }
      }),
    );
    return next;
  }
  async start() {
    this.signatures = await this.snapshot();
    if (!this.stopped) this.schedule();
    return this;
  }
  private schedule() {
    this.timer = setTimeout(async () => {
      await this.tick();
      if (!this.stopped) this.schedule();
    }, this.intervalMs);
    this.timer.unref?.();
  }
  /** One poll (also callable directly by tests). Returns whether a change was seen. */
  async tick() {
    if (this.running || this.stopped) return false;
    this.running = true;
    let changed = false;
    try {
      const next = await this.snapshot();
      changed =
        next.size !== this.signatures.size ||
        [...next].some(([file, signature]) => this.signatures.get(file) !== signature);
      this.signatures = next;
    } catch {
      /* transient listing error; retry next tick */
    } finally {
      this.running = false;
    }
    if (changed && !this.stopped) this.onChange();
    return changed;
  }
  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
