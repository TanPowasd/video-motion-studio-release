import { spawnSync } from 'node:child_process';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
const owner = 'TanPowasd',
  name = 'video-motion-studio-release',
  repo = `${owner}/${name}`;
const source = path.resolve(process.argv[2] ?? ''),
  zip = path.resolve('release/Vmotion-Windows-x64-Portable.zip');
if (!process.argv[2] || !source.startsWith(path.resolve('artifacts') + path.sep))
  throw Error('Pass an exported product snapshot under artifacts');
const manifest = JSON.parse(await readFile(path.join(source, 'SOURCE-MANIFEST.json'), 'utf8'));
const version = JSON.parse(await readFile(path.join(source, 'package.json'), 'utf8')).version;
const tag = 'v' + version;
if (!/^v\d+\.\d+\.\d+$/.test(tag)) throw Error('Release version must use semver');
const notes = await readFile(path.join(source, 'docs/releases', tag + '.md'), 'utf8').catch(
  (error) => {
    if (error.code === 'ENOENT') return undefined;
    throw error;
  },
);
const notesHeading = notes?.match(/^# ([^\r\n]+)\r?\n/);
if (notes && !notesHeading) throw Error('Version release notes need a Markdown title');
const releaseTitle = notesHeading?.[1] ?? `Vmotion ${version} · 统一创作与 Agent`;
const releaseSummary = notesHeading
  ? notes.slice(notesHeading[0].length).trim()
  : `Vmotion ${version} 开源预览版。\n\n- 人通过动画、剪辑、音乐、绘画和代码界面直接编辑。\n- AI 在外部通过文件或 MCP 修改同一工程，顶部“连接 MCP”复制配置。\n- Windows 10/11 x64 便携包内置运行时、VST3 宿主和 MIDI 接口。\n- 外部 AI 通过文件/CLI/MCP 操作；程序不调用模型。\n- Apache-2.0，第三方许可与 FFmpeg 对应源码保留。`;
const packageManifest = JSON.parse(
  await readFile('release/Vmotion/portable-manifest.json', 'utf8'),
);
if (
  packageManifest.gitCommit !== manifest.sourceCommit ||
  packageManifest.applicationVersion !== version
)
  throw Error('Portable package and public source version/commit differ');
for (const entry of manifest.entries) {
  const bytes = await readFile(path.join(source, entry.path));
  if (
    bytes.length !== entry.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== entry.sha256
  )
    throw Error('Source snapshot content differs from its manifest');
}
const credential = spawnSync('git', ['credential', 'fill'], {
  input: 'protocol=https\nhost=github.com\n\n',
  encoding: 'utf8',
  windowsHide: true,
  env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
});
if (credential.status !== 0) throw Error('GitHub authentication is unavailable');
const values = Object.fromEntries(
  credential.stdout
    .trim()
    .split(/\r?\n/)
    .map((line) => {
      const at = line.indexOf('=');
      return [line.slice(0, at), line.slice(at + 1)];
    }),
);
const headers = {
  Authorization: 'Bearer ' + values.password,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
};
async function api(route, options = {}) {
  const r = await fetch('https://api.github.com' + route, {
    ...options,
    headers: { ...headers, ...options.headers },
  });
  const text = await r.text();
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    data = { message: 'Non-JSON GitHub response' };
  }
  if (!r.ok && r.status !== 404)
    throw Error(`GitHub HTTP ${r.status}: ${data.message ?? 'request failed'}`);
  return { status: r.status, data };
}
function git(args, cwd = source) {
  const r = spawnSync('git', ['-c', 'http.proxy=', '-c', 'https.proxy=', ...args], {
    cwd,
    encoding: 'utf8',
    windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0' },
  });
  if (r.status !== 0) throw Error(`Git ${args[0]} failed: ${r.stderr}`);
  return r.stdout.trim();
}
const account = await api('/user');
if (account.data.login !== owner)
  throw Error('GitHub account differs from the intended release owner');
let info = await api('/repos/' + repo);
if (info.status === 404)
  info = await api('/user/repos', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name,
      private: false,
      description:
        'Open-source Vmotion releases. Visual creation and external Agent tools in one local workstation.',
      auto_init: false,
      has_wiki: false,
    }),
  });
if (info.data.private !== false) throw Error('Release repository must be public');
await api('/repos/' + repo, {
  method: 'PATCH',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    description:
      'Open-source Vmotion. People edit directly in the UI; external AI uses files, CLI or MCP on the same local project.',
  }),
});
const existingTag = await api('/repos/' + repo + '/git/ref/tags/' + tag);
if (existingTag.status !== 404)
  throw Error('Release tag already exists; do not overwrite a published version');
const archiveHash = createHash('sha256');
for await (const chunk of createReadStream(zip)) archiveHash.update(chunk);
const sha = archiveHash.digest('hex');
const checksum = await readFile(zip + '.sha256', 'utf8');
if (checksum.split(' ')[0] !== sha) throw Error('Portable ZIP checksum mismatch');
const sourceLicense = await readFile(path.join(source, 'LICENSE'), 'utf8');
if (!sourceLicense.includes('Apache License')) throw Error('Snapshot license is not Apache-2.0');
git(['init', '-b', 'main']);
git(['config', 'user.name', 'TanPowasd']);
git(['config', 'user.email', 'TanPowasd@users.noreply.github.com']);
git(['remote', 'add', 'origin', `https://github.com/${repo}.git`]);
if (info.status !== 201) {
  const remote = spawnSync(
    'git',
    ['-c', 'http.proxy=', '-c', 'https.proxy=', 'ls-remote', '--heads', 'origin'],
    {
      cwd: source,
      encoding: 'utf8',
      windowsHide: true,
    },
  );
  if (remote.status !== 0) throw Error('Cannot inspect public repository history');
  if (remote.stdout.trim()) {
    git(['fetch', 'origin', 'main']);
    git(['reset', '--mixed', 'origin/main']);
  }
}
git(['add', '.']);
git(['commit', '-m', `Publish ${releaseTitle}`]);
git(['push', '-u', 'origin', 'main']);
git(['tag', tag]);
git(['push', 'origin', tag]);
const body = `${releaseSummary}\n\n源码与便携包基准：${manifest.sourceCommit}。\n\nSHA256: ${sha}\n`;
let release = await api('/repos/' + repo + '/releases/tags/' + tag);
if (release.status === 404)
  release = await api('/repos/' + repo + '/releases', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      tag_name: tag,
      name: releaseTitle,
      body,
      draft: false,
      prerelease: true,
    }),
  });
const uploads = release.data.upload_url.split('{')[0],
  assets = [];
for (const file of [zip, zip + '.sha256']) {
  const size = (await stat(file)).size;
  const existing = release.data.assets?.find((a) => a.name === path.basename(file));
  if (existing) {
    assets.push(existing);
    continue;
  }
  const response = await fetch(uploads + '?name=' + encodeURIComponent(path.basename(file)), {
    method: 'POST',
    headers: {
      ...headers,
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(size),
    },
    body: createReadStream(file),
    duplex: 'half',
  });
  const asset = await response.json();
  if (!response.ok) throw Error(`Release upload failed: HTTP ${response.status}`);
  assets.push(asset);
}
const published = await api('/repos/' + repo),
  license = await api('/repos/' + repo + '/license'),
  tagInfo = await api('/repos/' + repo + '/git/ref/tags/' + tag);
if (published.data.private !== false || license.data.license?.spdx_id !== 'Apache-2.0')
  throw Error('Public visibility/license verification failed');
const archive = assets.find((a) => a.name.endsWith('.zip'));
if (archive.size !== (await stat(zip)).size || archive.state !== 'uploaded')
  throw Error('Published archive size/state mismatch');
if (archive.digest && archive.digest !== 'sha256:' + sha)
  throw Error('GitHub asset digest differs from local ZIP');
const report = {
  repository: published.data.html_url,
  public: true,
  license: license.data.license.spdx_id,
  sourceSnapshot: manifest.sourceCommit,
  publicCommit: git(['rev-parse', 'HEAD']),
  tag: tagInfo.data.ref,
  release: release.data.html_url,
  assets: assets.map((a) => ({
    name: a.name,
    size: a.size,
    url: a.browser_download_url,
    digest: a.digest,
  })),
  sha256: sha,
};
await writeFile('artifacts/public-release-report.json', JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report, null, 2));
