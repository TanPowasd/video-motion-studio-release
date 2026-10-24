import { describe, it, expect, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
import { ProjectService } from '../src/service/service.js';
import {
  filesystemFromMountTable,
  isRemoteFilesystem,
  planWatch,
  ProjectFilePoller,
} from '../src/service/file-watch.js';

const mountinfo = [
  '22 1 259:1 / / rw,relatime shared:1 - ext4 /dev/root rw',
  '90 22 0:50 / /workspace rw,nosuid,nodev,relatime shared:40 - fuse.juicefs JuiceFS:abc rw,user_id=0',
  '91 22 0:51 / /mnt/my\\040share rw - cifs //nas/share rw',
  '92 90 0:52 / /workspace/local rw - ext4 /dev/sdb rw',
].join('\n');

let cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const fn of cleanup.reverse()) await fn();
  cleanup = [];
});
const tempProject = async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-watch-'));
  cleanup.push(() => rm(root, { recursive: true, force: true }));
  await initProject(root);
  return root;
};

describe('file watch fallback for FUSE/network mounts', () => {
  it('reads the filesystem of the longest containing mount point', () => {
    expect(filesystemFromMountTable(mountinfo, '/workspace/projects/p')).toBe('fuse.juicefs');
    expect(filesystemFromMountTable(mountinfo, '/workspace/local/p')).toBe('ext4');
    expect(filesystemFromMountTable(mountinfo, '/workspaceX/p')).toBe('ext4');
    expect(filesystemFromMountTable(mountinfo, '/mnt/my share/p')).toBe('cifs');
    expect(filesystemFromMountTable('JuiceFS:x /workspace fuse.juicefs rw 0 0\n/dev/root / ext4 rw 0 0', '/workspace/a')).toBe('fuse.juicefs');
    for (const type of ['fuse.juicefs', 'fuse', 'nfs4', 'cifs', 'smb3', '9p', 'virtiofs', 'fuse.sshfs'])
      expect(isRemoteFilesystem(type)).toBe(true);
    for (const type of ['ext4', 'btrfs', 'xfs', 'ntfs', 'apfs', 'tmpfs', undefined])
      expect(isRemoteFilesystem(type)).toBe(false);
  });
  it('honours VMOTION_WATCH and clamps the poll interval', async () => {
    const root = os.tmpdir();
    expect(await planWatch(root, { VMOTION_WATCH: 'poll' })).toMatchObject({ poll: true, intervalMs: 500 });
    expect(await planWatch(root, { VMOTION_WATCH: 'native' })).toMatchObject({ poll: false });
    expect((await planWatch(root, { VMOTION_WATCH: 'poll', VMOTION_WATCH_POLL_MS: '5' })).intervalMs).toBe(100);
    expect((await planWatch(root, { VMOTION_WATCH: 'poll', VMOTION_WATCH_POLL_MS: '99999' })).intervalMs).toBe(10000);
    expect((await planWatch(root, { VMOTION_WATCH: 'bogus' })).mode).toBe('auto');
  });
  it('stat-polls project files and reports external edits, new and deleted files', async () => {
    const root = await tempProject();
    let files = ['project.vmotion.json', 'scenes/intro.json'],
      changes = 0;
    const poller = await new ProjectFilePoller(root, async () => files, () => changes++, 60_000).start();
    cleanup.push(async () => poller.stop());
    expect(await poller.tick()).toBe(false);
    const file = path.join(root, 'scenes/intro.json');
    await writeFile(file, (await readFile(file, 'utf8')).replace('"intro"', '"intro" '));
    expect(await poller.tick()).toBe(true);
    expect(await poller.tick()).toBe(false);
    files = [...files, 'components/new.tsx'];
    expect(await poller.tick()).toBe(true); // a listed file that does not exist yet
    await writeFile(path.join(root, 'components-new.txt'), 'unwatched');
    expect(await poller.tick()).toBe(false);
    expect(changes).toBe(2);
  });
  it('reloads an external edit through the poller when VMOTION_WATCH=poll', async () => {
    const root = await tempProject(),
      previous = { mode: process.env.VMOTION_WATCH, ms: process.env.VMOTION_WATCH_POLL_MS };
    process.env.VMOTION_WATCH = 'poll';
    process.env.VMOTION_WATCH_POLL_MS = '100';
    const service = await new ProjectService(root).open(true);
    cleanup.push(async () => {
      await service.close();
      if (previous.mode === undefined) delete process.env.VMOTION_WATCH;
      else process.env.VMOTION_WATCH = previous.mode;
      if (previous.ms === undefined) delete process.env.VMOTION_WATCH_POLL_MS;
      else process.env.VMOTION_WATCH_POLL_MS = previous.ms;
    });
    expect(service.watchPlan).toMatchObject({ poll: true, intervalMs: 100 });
    const file = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(await readFile(file, 'utf8'));
    scene.nodes.find((n: { id: string }) => n.id === 'title').text = 'Edited on a FUSE mount';
    const changed = new Promise<void>((resolve) => service.on('change', () => resolve()));
    await writeFile(file, JSON.stringify(scene, null, 2));
    await Promise.race([
      changed,
      new Promise((_r, reject) => setTimeout(() => reject(new Error('no reload')), 8000)),
    ]);
    expect(service.snapshot.scenes[0].nodes.find((n) => n.id === 'title')!.text).toBe(
      'Edited on a FUSE mount',
    );
  });
});
