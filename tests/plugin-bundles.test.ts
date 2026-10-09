import { afterEach, beforeEach, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { strToU8, unzipSync, zipSync } from 'fflate';
import { Application } from '../src/service/application.js';
import { initProject } from '../src/service/template.js';
import { hash } from '../src/service/project.js';
import { pluginHealth } from '../src/service/plugin-health.js';

let root: string, other: string, scratch: string, app: Application, target: Application;
const card = `import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'卡片',parameters:{},render(ctx){return [node({id:'fill',type:'rect',width:ctx.width,height:ctx.height,fill:'#3366aa'})]}});`;
const baseCard = card.replace('#3366aa', '#aa6633');
const plugin = (over: Record<string, unknown> = {}) => ({
  kind: 'vmotion-plugin',
  apiVersion: 1,
  id: 'example.lab',
  name: '外部创作包',
  version: '1.0.0',
  dependencies: { 'vmotion.design': '^1.0.0', 'example.base': '^1.0.0' },
  contributions: [
    { id: 'card', name: '信息卡', kind: 'component', source: 'components/plugins/lab/card.ts' },
  ],
  ...over,
});
const base = (version = '1.2.0') => ({
  kind: 'vmotion-plugin',
  apiVersion: 1,
  id: 'example.base',
  name: '基础包',
  version,
  contributions: [
    { id: 'base', name: '底板', kind: 'component', source: 'components/plugins/base/base.ts' },
  ],
});
async function project(dir: string) {
  await initProject(dir, 'Bundles', {
    template: 'blank',
    width: 320,
    height: 180,
    durationSeconds: 1,
  });
  return new Application(dir).open(false);
}
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-bundle-src-'));
  other = await mkdtemp(path.join(os.tmpdir(), 'vmotion-bundle-dst-'));
  scratch = await mkdtemp(path.join(os.tmpdir(), 'vmotion-bundle-tmp-'));
  app = await project(root);
  target = await project(other);
}, 180_000);
afterEach(async () => {
  await app.close();
  await target.close();
  for (const dir of [root, other, scratch]) await rm(dir, { recursive: true, force: true });
}, 180_000);
async function commit(application: Application, planned: any, preflight = false) {
  if (preflight) {
    const check = await application.dispatch('projectPreflight', planned.candidate);
    expect(check.valid, JSON.stringify(check.diagnostics)).toBe(true);
  }
  await application.dispatch('projectApply', planned.apply);
}
async function registerBoth(application = app, baseVersion = '1.2.0', labVersion = '1.0.0') {
  const planned = await application.dispatch('pluginsPlan', {
    revision: application.service.snapshot.revision,
    files: [
      ['components/plugins/base/plugin.json', JSON.stringify(base(baseVersion))],
      ['components/plugins/base/base.ts', baseCard],
      ['components/plugins/lab/plugin.json', JSON.stringify(plugin({ version: labVersion }))],
      ['components/plugins/lab/card.ts', card],
    ].map(([file, content]) => ({
      type: 'replace',
      path: file,
      content,
      expectedHash:
        application.service.snapshot.files[file] === undefined
          ? null
          : hash(application.service.snapshot.files[file]),
    })),
    actions: [
      { type: 'register', source: 'components/plugins/base/plugin.json' },
      { type: 'register', source: 'components/plugins/lab/plugin.json' },
    ],
  });
  await commit(application, planned);
}
const pack = (output: string, extra: Record<string, unknown> = {}): Promise<any> =>
  app.dispatch('pluginsPack', { id: 'example.lab', output, ...extra });
const install = (
  source: Record<string, unknown>,
  extra: Record<string, unknown> = {},
): Promise<any> =>
  target.dispatch('pluginsInstall', {
    revision: target.service.snapshot.revision,
    source,
    ...extra,
  });

it('packs deterministically and round-trips plugins with bundled dependencies, hashes and undo', async () => {
  await registerBoth();
  const first = await pack(path.join(scratch, 'a.vmplugin')),
    second = await pack(path.join(scratch, 'b.vmplugin'));
  expect(first.sha256).toBe(second.sha256);
  expect(Buffer.compare(await readFile(first.output), await readFile(second.output))).toBe(0);
  expect(first.plugins.map((p: any) => p.id)).toEqual(['example.lab', 'example.base']);
  expect(first.externalDependencies).toEqual([
    { id: 'vmotion.design', range: '^1.0.0', origin: 'builtin' },
  ]);
  const entries = unzipSync(new Uint8Array(await readFile(first.output)));
  expect(Object.keys(entries)[0]).toBe('vmplugin.json');
  const manifest = JSON.parse(Buffer.from(entries['vmplugin.json']).toString());
  expect(manifest).toMatchObject({
    kind: 'vmotion-plugin-bundle',
    formatVersion: 1,
    root: 'example.lab',
  });

  const before = structuredClone(target.service.snapshot);
  const planned = await install({ type: 'bundle', path: first.output }, { pin: true });
  expect(planned.summary.install.plugins).toEqual([
    expect.objectContaining({ id: 'example.lab', change: 'install', to: '1.0.0', pinned: true }),
    expect.objectContaining({ id: 'example.base', change: 'install', role: 'dependency' }),
  ]);
  expect(planned.summary.install.dependencies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'vmotion.design', status: 'builtin' }),
      expect.objectContaining({ id: 'example.base', status: 'bundled', version: '1.2.0' }),
    ]),
  );
  // Nothing is written before apply.
  expect(target.service.snapshot.revision).toBe(before.revision);
  await commit(target, planned, true);
  const installed: any = await target.dispatch('pluginsInspect', { origin: 'project' });
  expect(
    installed.items
      .map((i: any) => [i.id, i.version, i.pinned, i.status])
      .sort((a: string[], b: string[]) => a[0].localeCompare(b[0])),
  ).toEqual([
    ['example.base', '1.2.0', 'content', 'ok'],
    ['example.lab', '1.0.0', 'content', 'ok'],
  ]);
  for (const p of manifest.plugins)
    expect(installed.items.find((i: any) => i.id === p.id).contentHash).toBe(p.contentHash);
  for (const file of Object.keys(entries).filter((f) => f.startsWith('files/')))
    expect(target.service.snapshot.files[file.slice(6)]).toBe(
      app.service.snapshot.files[file.slice(6)],
    );
  await target.dispatch('undo');
  expect(target.service.snapshot.revision).toBe(before.revision);
  expect(target.service.snapshot.project.plugins ?? []).toEqual(before.project.plugins ?? []);
  expect(Object.keys(target.service.snapshot.files).sort()).toEqual(
    Object.keys(before.files).sort(),
  );
}, 180_000);

it('rejects tampered hashes, traversal, undeclared members, oversized archives and bad inputs', async () => {
  await registerBoth();
  const packed = await pack(path.join(scratch, 'ok.vmplugin')),
    entries = unzipSync(new Uint8Array(await readFile(packed.output))),
    rezip = async (name: string, mutate: (e: Record<string, Uint8Array>) => void) => {
      const copy = { ...entries };
      mutate(copy);
      const file = path.join(scratch, name);
      await writeFile(file, zipSync(copy));
      return file;
    };
  const tampered = await rezip('tampered.vmplugin', (e) => {
    e['files/components/plugins/lab/card.ts'] = strToU8(card.replace('#3366aa', '#ff0000'));
  });
  await expect(install({ type: 'bundle', path: tampered })).rejects.toMatchObject({
    code: 'PLUGIN_BUNDLE_HASH',
  });
  for (const evil of [
    '../evil.ts',
    'files/../../evil.ts',
    'files/components/../x.ts',
    'files/other/x.ts',
  ]) {
    const file = await rezip('evil.vmplugin', (e) => {
      e[evil] = strToU8('export {}');
    });
    await expect(install({ type: 'bundle', path: file }), evil).rejects.toMatchObject({
      code: 'PLUGIN_BUNDLE_PATH',
    });
  }
  const extra = await rezip('extra.vmplugin', (e) => {
    e['files/components/plugins/lab/extra.ts'] = strToU8('export {}');
  });
  await expect(install({ type: 'bundle', path: extra })).rejects.toMatchObject({
    code: 'PLUGIN_BUNDLE_FORMAT',
  });
  const future = await rezip('future.vmplugin', (e) => {
    e['vmplugin.json'] = strToU8(
      JSON.stringify({
        ...JSON.parse(Buffer.from(entries['vmplugin.json']).toString()),
        formatVersion: 2,
      }),
    );
  });
  await expect(install({ type: 'bundle', path: future })).rejects.toMatchObject({
    code: 'PLUGIN_API_VERSION',
  });
  const huge = path.join(scratch, 'huge.vmplugin');
  await writeFile(huge, Buffer.alloc(33 * 1024 * 1024));
  await expect(install({ type: 'bundle', path: huge })).rejects.toMatchObject({
    code: 'PLUGIN_BUDGET',
  });
  const notZip = path.join(scratch, 'bad.vmplugin');
  await writeFile(notZip, 'not a zip');
  await expect(install({ type: 'bundle', path: notZip })).rejects.toMatchObject({
    code: 'PLUGIN_BUNDLE_FORMAT',
  });
  // base64 delivery is equivalent to the file path and still verified.
  const viaBase64 = await install({
    type: 'bundle',
    base64: (await readFile(packed.output)).toString('base64'),
    name: 'ok.vmplugin',
  });
  expect(viaBase64.summary.install.root).toBe('example.lab');
  expect(target.service.snapshot.project.plugins ?? []).toEqual([]);
}, 180_000);

it('installs folders, rejects reserved IDs/future API and resolves dependency versions', async () => {
  const folder = path.join(scratch, 'lab');
  await mkdir(folder, { recursive: true });
  await writeFile(path.join(folder, 'plugin.json'), JSON.stringify(plugin({ dependencies: {} })));
  await writeFile(path.join(folder, 'card.ts'), card);
  const planned = await install({ type: 'folder', path: folder });
  expect(planned.summary.install.plugins[0]).toMatchObject({
    id: 'example.lab',
    change: 'install',
    source: 'components/plugins/lab/plugin.json',
  });
  await commit(target, planned, true);
  expect(target.service.snapshot.files['components/plugins/lab/card.ts']).toBe(card);

  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify(plugin({ id: 'vmotion.evil', dependencies: {} })),
  );
  await expect(install({ type: 'folder', path: folder })).rejects.toMatchObject({
    code: 'PLUGIN_ID',
  });
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify(plugin({ apiVersion: 2, dependencies: {} })),
  );
  await expect(install({ type: 'folder', path: folder })).rejects.toMatchObject({
    code: 'PLUGIN_API_VERSION',
  });
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify(
      plugin({
        dependencies: {},
        contributions: [
          { id: 'card', name: 'x', kind: 'component', source: 'components/plugins/../../evil.ts' },
        ],
      }),
    ),
  );
  await expect(install({ type: 'folder', path: folder })).rejects.toBeTruthy();

  // Dependency resolution against the bundle and the target project.
  await registerBoth(app);
  const bundle = (await pack(path.join(scratch, 'deps.vmplugin'))).output;
  await expect(
    install({ type: 'bundle', path: bundle }, { dependencies: 'none' }),
  ).rejects.toMatchObject({ code: 'PLUGIN_DEPENDENCY' });
  const lab = await target.dispatch('pluginsPlan', {
    revision: target.service.snapshot.revision,
    actions: [{ type: 'remove', id: 'example.lab' }],
  });
  await commit(target, lab);
  const newer = await target.dispatch('pluginsPlan', {
    revision: target.service.snapshot.revision,
    files: [
      {
        type: 'replace',
        path: 'components/plugins/base/plugin.json',
        expectedHash: null,
        content: JSON.stringify(base('2.0.0')),
      },
      {
        type: 'replace',
        path: 'components/plugins/base/base.ts',
        expectedHash: null,
        content: baseCard,
      },
    ],
    actions: [{ type: 'register', source: 'components/plugins/base/plugin.json' }],
  });
  await commit(target, newer);
  const conflict = install({ type: 'bundle', path: bundle }, { overwrite: true });
  await expect(conflict).rejects.toMatchObject({ code: 'PLUGIN_DEPENDENCY' });
  const details = await conflict.catch((e) => e.details);
  expect(details.dependencies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        id: 'example.base',
        status: 'conflict',
        version: '2.0.0',
        bundledVersion: '1.2.0',
      }),
    ]),
  );
}, 180_000);

it('upgrades with a version diff, re-pins, rejects downgrades and foreign overwrites', async () => {
  await registerBoth(app, '1.2.0', '1.0.0');
  const v1 = (await pack(path.join(scratch, 'v1.vmplugin'))).output;
  await commit(target, await install({ type: 'bundle', path: v1 }, { pin: true }));
  const pinnedV1 = target.service.snapshot.project.plugins!.find((p) =>
    p.source.includes('lab'),
  )!.contentHash;
  // Author ships 1.1.0 with a new tool-less contribution and a newer base.
  const next = plugin({
    version: '1.1.0',
    dependencies: { 'example.base': '^1.3.0' },
    contributions: [
      ...plugin().contributions,
      { id: 'card2', name: '第二卡', kind: 'component', source: 'components/plugins/lab/card2.ts' },
    ],
  });
  const files = app.service.snapshot.files,
    replace = (file: string, content: string) => ({
      type: 'replace',
      path: file,
      content,
      expectedHash: files[file] === undefined ? null : hash(files[file]),
    });
  const edit = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    files: [
      replace('components/plugins/lab/card2.ts', card),
      replace('components/plugins/lab/plugin.json', JSON.stringify(next)),
      replace('components/plugins/base/plugin.json', JSON.stringify(base('1.3.0'))),
    ],
  });
  await commit(app, edit);
  const v2 = (await pack(path.join(scratch, 'v2.vmplugin'))).output;
  const before = structuredClone(target.service.snapshot);
  const upgrade = await install({ type: 'bundle', path: v2 });
  const lab = upgrade.summary.install.plugins.find((p: any) => p.id === 'example.lab');
  expect(lab).toMatchObject({
    change: 'upgrade',
    from: '1.0.0',
    to: '1.1.0',
    pinned: true,
    contributions: { added: ['card2'], removed: [] },
    dependencies: {
      'example.base': { from: '^1.0.0', to: '^1.3.0' },
      'vmotion.design': { from: '^1.0.0', to: null },
    },
  });
  expect(upgrade.summary.install.dependencies).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'example.base', status: 'upgrade', installedVersion: '1.2.0' }),
    ]),
  );
  await commit(target, upgrade, true);
  const registration = target.service.snapshot.project.plugins!.find((p) =>
    p.source.includes('lab'),
  )!;
  expect(registration.contentHash).toMatch(/^[a-f0-9]{64}$/);
  expect(registration.contentHash).not.toBe(pinnedV1);
  await expect(install({ type: 'bundle', path: v1 })).rejects.toMatchObject({
    code: 'PLUGIN_DOWNGRADE',
  });
  await target.dispatch('undo');
  expect(target.service.snapshot.files).toEqual(before.files);
  expect(target.service.snapshot.project.plugins).toEqual(before.project.plugins);

  // A different plugin cannot silently claim a file owned by example.lab.
  const folder = path.join(scratch, 'thief');
  await mkdir(folder, { recursive: true });
  await writeFile(
    path.join(folder, 'plugin.json'),
    JSON.stringify(plugin({ id: 'example.thief', dependencies: {} })),
  );
  await writeFile(path.join(folder, 'card.ts'), card + '\n// other');
  await expect(install({ type: 'folder', path: folder })).rejects.toMatchObject({
    code: 'PLUGIN_INSTALL_CONFLICT',
  });
}, 180_000);

it('installs from an explicit Git URL/ref and reports the commit', async () => {
  const repo = path.join(scratch, 'repo'),
    dir = path.join(repo, 'components', 'plugins', 'lab');
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, 'plugin.json'), JSON.stringify(plugin({ dependencies: {} })));
  await writeFile(path.join(dir, 'card.ts'), card);
  const git = (...args: string[]) =>
    execFileSync('git', ['-C', repo, ...args], {
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: 't',
        GIT_AUTHOR_EMAIL: 't@t',
        GIT_COMMITTER_NAME: 't',
        GIT_COMMITTER_EMAIL: 't@t',
      },
    })
      .toString()
      .trim();
  git('init', '-q', '-b', 'main');
  git('add', '.');
  git('commit', '-q', '-m', 'plugin');
  const head = git('rev-parse', 'HEAD');
  const planned = await install({
    type: 'git',
    url: 'file://' + repo,
    ref: 'main',
    subdir: 'components/plugins/lab',
  });
  expect(planned.summary.install.origin).toMatchObject({ type: 'git', commit: head });
  expect(planned.summary.install.plugins[0].source).toBe('components/plugins/lab/plugin.json');
  await expect(install({ type: 'git', url: '--upload-pack=touch /tmp/x' })).rejects.toMatchObject({
    code: 'PLUGIN_GIT',
  });
  await expect(
    install({ type: 'git', url: 'file://' + repo, subdir: '../..' }),
  ).rejects.toMatchObject({ code: 'PLUGIN_BUNDLE_PATH' });
}, 180_000);

it('reports tolerant health with fixes that are ordinary plugins_plan actions', async () => {
  await registerBoth();
  const disable = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [
      { type: 'toggle', id: 'example.base', enabled: false },
      { type: 'toggle', id: 'example.lab', enabled: false },
    ],
  });
  await commit(app, disable);
  // Simulate an external edit that leaves lab enabled while base stays disabled.
  const broken = structuredClone(app.service.snapshot);
  broken.project.plugins = broken.project.plugins!.map((p) =>
    p.source.includes('lab') ? { ...p, enabled: true } : p,
  );
  const health = pluginHealth(broken);
  const problem = health.problems.find((p) => p.code === 'PLUGIN_DEPENDENCY')!;
  expect(problem).toMatchObject({ id: 'example.lab', dependency: 'example.base' });
  expect(problem.fixes[0].actions).toEqual([{ type: 'toggle', id: 'example.base', enabled: true }]);
  const listed: any = await app.dispatch('pluginsInspect', {
    id: 'example.lab',
    includeParameters: true,
  });
  expect(listed.dependencyStatus).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ id: 'example.base', origin: 'project', enabled: false }),
    ]),
  );
  expect(listed.registration).toMatchObject({ pinned: 'none' });
  expect(listed.files.map((f: any) => f.path)).toContain('components/plugins/lab/card.ts');
  const filtered = await app.dispatch('pluginsInspect', { origin: 'builtin', query: 'design' });
  expect(filtered.items.map((i: any) => i.id)).toEqual(['vmotion.design']);
  const removeBySource = await app.dispatch('pluginsPlan', {
    revision: app.service.snapshot.revision,
    actions: [{ type: 'remove', source: 'components/plugins/lab/plugin.json' }],
  });
  await commit(app, removeBySource);
  expect(app.service.snapshot.project.plugins!.map((p) => p.source)).toEqual([
    'components/plugins/base/plugin.json',
  ]);
}, 180_000);
