import { cp, mkdir, readFile, writeFile, stat, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { acquirePackageLock, publishPackage } from './package-publish.js';
import { prepareRuntime } from './prepare-runtime.js';
const root = path.resolve('.'),
  release = path.join(root, 'release'),
  stage = path.join(release, `.staging-${randomUUID()}`),
  target = path.join(release, 'Vmotion');
if (process.platform !== 'win32')
  throw new Error('The current portable package target is Windows x64');
await stat(path.join(root, 'dist/native/manifest.json'));
const nativeManifest = JSON.parse(
    await readFile(path.join(root, 'dist/native/manifest.json'), 'utf8'),
  ),
  nativeFiles = new Set<string>([
    nativeManifest.executable,
    nativeManifest.gpuExecutable,
    ...(nativeManifest.audioExecutable ? [nativeManifest.audioExecutable] : []),
  ]);
for (const name of nativeFiles) {
  if (typeof name !== 'string' || path.basename(name) !== name)
    throw new Error('Invalid native binary manifest');
  await stat(path.join(root, 'dist/native', name));
}
const nativeFilter = (file: string) =>
  !file.endsWith('.exe') || nativeFiles.has(path.basename(file));
await stat(path.join(root, 'dist/desktop/main.cjs'));
const preparedRuntime = await prepareRuntime(root);
const releaseLock = await acquirePackageLock(release);
try {
  await mkdir(stage, { recursive: true });
  await cp(path.join(root, 'node_modules/electron/dist'), stage, { recursive: true });
  await rename(path.join(stage, 'electron.exe'), path.join(stage, 'Vmotion.exe'));
  const app = path.join(stage, 'resources/app');
  await mkdir(app, { recursive: true });
  for (const entry of ['dist', 'schemas', 'docs', 'LICENSE', 'README.md'])
    await cp(path.join(root, entry), path.join(app, entry), {
      recursive: true,
      filter: (file) =>
        file !== path.join(root, 'dist/runtime') &&
        !file.startsWith(path.join(root, 'dist/runtime') + path.sep) &&
        (!file.startsWith(path.join(root, 'dist/native') + path.sep) || nativeFilter(file)),
    });
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  delete manifest.devDependencies;
  delete manifest.scripts;
  await writeFile(path.join(app, 'package.json'), JSON.stringify(manifest, null, 2));
  await cp(path.join(root, 'examples/science'), path.join(app, 'examples/science'), {
    recursive: true,
    filter: (file) => !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
  });
  if (existsSync(path.join(root, 'examples/animation-lab')))
    await cp(path.join(root, 'examples/animation-lab'), path.join(app, 'examples/animation-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/parameter-lab')))
    await cp(path.join(root, 'examples/parameter-lab'), path.join(app, 'examples/parameter-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/audio-lab')))
    await cp(path.join(root, 'examples/audio-lab'), path.join(app, 'examples/audio-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/visual-audit-lab')))
    await cp(
      path.join(root, 'examples/visual-audit-lab'),
      path.join(app, 'examples/visual-audit-lab'),
      {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      },
    );
  const npmCli =
    process.env.npm_execpath ??
    path.join(path.dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js');
  if (existsSync(path.join(root, 'examples/vector-lab')))
    await cp(path.join(root, 'examples/vector-lab'), path.join(app, 'examples/vector-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  const dependencies = execFileSync(
    process.execPath,
    [npmCli, 'ls', '--omit=dev', '--all', '--parseable'],
    { cwd: root, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 },
  )
    .trim()
    .split(/\r?\n/)
    .filter((p) => path.resolve(p) !== root);
  if (existsSync(path.join(root, 'examples/repeater-lab')))
    await cp(path.join(root, 'examples/repeater-lab'), path.join(app, 'examples/repeater-lab'), {
      recursive: true,
      filter: (file) =>
        !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
    });
  if (existsSync(path.join(root, 'examples/shared-scene-lab')))
    await cp(
      path.join(root, 'examples/shared-scene-lab'),
      path.join(app, 'examples/shared-scene-lab'),
      {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      },
    );
  for (const name of [
    'time-lab',
    'editing-lab',
    'linear-algebra-lab',
    'matrix3d-lab',
    'depth3d-lab',
    'mesh-gallery',
    'material-gallery',
    'effects2d-lab',
    'temporal-lab',
    'effect-graph-lab',
    'drivers-lab',
    'sound-lab',
    'workstation-lab',
    'storyboard-lab',
    'visual-fields-lab',
    'typography-lab',
    'tracking-lab',
    'design-lab',
    'plugin-lab',
    'graph-outputs-lab',
    'keying-lab',
    'animation-layers-lab',
    'source-organization-lab',
    'pixel-review-lab',
    'gpu-effects-lab',
  ])
    if (existsSync(path.join(root, `examples/${name}`)))
      await cp(path.join(root, `examples/${name}`), path.join(app, `examples/${name}`), {
        recursive: true,
        filter: (file) =>
          !file.includes(`${path.sep}.vmotion`) && !file.includes(`${path.sep}exports`),
      });
  for (const dependency of dependencies) {
    const relative = path.relative(root, dependency);
    if (relative.startsWith('..') || !relative.startsWith('node_modules' + path.sep))
      throw new Error(`Dependency outside package root: ${dependency}`);
    await cp(dependency, path.join(app, relative), { recursive: true });
  }
  await cp(path.join(root, 'dist/native'), path.join(stage, 'resources/native'), {
    recursive: true,
    filter: nativeFilter,
  });
  await mkdir(path.join(stage, 'resources/compiler'), { recursive: true });
  await cp(preparedRuntime.runtime, path.join(stage, 'resources/runtime'), {
    recursive: true,
    filter: (file) => !file.endsWith('NotoSansSC.ttf'),
  });
  await cp(
    path.join(root, 'node_modules/@esbuild/win32-x64/esbuild.exe'),
    path.join(stage, 'resources/compiler/esbuild.exe'),
  );
  await writeFile(
    path.join(stage, 'READ-ME.txt'),
    'Vmotion Studio · Windows 10/11 x64\r\n复制完整 Vmotion 文件夹，双击 Vmotion.exe 或“启动 Vmotion.cmd”。无需安装 Node、Rust、FFmpeg 或额外编译器，基本功能可离线使用。\r\n主页新建/打开工程，Ctrl+N / Ctrl+O。动画、剪辑、音乐和绘画使用创作界面。\r\n设置与最近项目保存在 profile 中；请放在可写目录。工程和素材保存在你选择的位置。\r\n源文件、自动化接口和工具检查使用独立“启动 Agent 工作台.cmd”，详细工具链说明在 Agent 文件夹。\r\n创作说明：resources\\app\\docs\\STUDIO-GUIDE.md。第三方许可、媒体来源与对应源码见 resources\\runtime\\licenses 和 sources；内容清单见 portable-manifest.json。\r\n',
  );
  await writeFile(path.join(stage, 'portable.flag'), 'Vmotion portable settings\r\n');
  await writeFile(
    path.join(stage, '启动 Vmotion.cmd'),
    '@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0Vmotion.exe"\r\n',
  );
  await writeFile(
    path.join(stage, 'vmotion.cmd'),
    '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "ESBUILD_BINARY_PATH=%~dp0resources\\compiler\\esbuild.exe"\r\n"%~dp0Vmotion.exe" "%~dp0resources\\app\\dist\\cli\\index.mjs" %*\r\nexit /b %errorlevel%\r\n',
  );
  await mkdir(path.join(stage, 'Agent'), { recursive: true });
  await writeFile(
    path.join(stage, '启动 Agent 工作台.cmd'),
    '@echo off\r\nset "ELECTRON_RUN_AS_NODE="\r\nstart "" "%~dp0Vmotion.exe" --agent-workbench %*\r\n',
  );
  await writeFile(
    path.join(stage, 'Agent', 'vmotion-agent.cmd'),
    '@echo off\r\nsetlocal\r\nset "ELECTRON_RUN_AS_NODE=1"\r\nset "ESBUILD_BINARY_PATH=%~dp0..\\resources\\compiler\\esbuild.exe"\r\n"%~dp0..\\Vmotion.exe" "%~dp0..\\resources\\app\\dist\\cli\\index.mjs" %*\r\nexit /b %errorlevel%\r\n',
  );
  await cp(path.join(root, 'docs/AGENT-WORKBENCH.md'), path.join(stage, 'Agent', 'README.md'));
  await cp(path.join(root, 'docs/AGENT-WORKFLOW.md'), path.join(stage, 'Agent', 'WORKFLOW.md'));
  await writeFile(
    path.join(stage, 'portable-manifest.json'),
    JSON.stringify(
      {
        version: 1,
        name: 'Vmotion',
        platform: 'win32-x64',
        windows: '10/11',
        applicationVersion: manifest.version,
        gitCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
          cwd: root,
          encoding: 'utf8',
          windowsHide: true,
        }).trim(),
        mediaRuntime: preparedRuntime.manifest.ffmpeg,
        requiresInstalledNode: false,
        requiresInstalledFfmpeg: false,
        settings: 'profile',
        entry: 'Vmotion.exe',
        cli: 'vmotion.cmd',
        surfaces: {
          studio: { entry: 'Vmotion.exe', path: '/' },
          agent: {
            entry: '启动 Agent 工作台.cmd',
            path: '/agent/',
            cli: 'Agent/vmotion-agent.cmd',
          },
        },
        runtime: 'resources/runtime/manifest.json',
        native: nativeManifest,
      },
      null,
      2,
    ) + '\n',
  );
  await publishPackage(stage, target);
  await writeFile(
    path.join(release, '启动 Vmotion.cmd'),
    '@echo off\r\nstart "" "%~dp0Vmotion\\Vmotion.exe"\r\n',
  );
  await writeFile(
    path.join(release, '使用说明.txt'),
    '当前版本：Vmotion\\Vmotion.exe，或双击“启动 Vmotion.cmd”。\r\nVmotion-previous-* 是历史封装备份；更新不会修改这些旧版本。\r\n当前版本启动后显示项目首页，支持空白工程与科普模板，新建/打开入口在首页和编辑器顶部。\r\n',
  );
  process.stdout.write(
    JSON.stringify(
      {
        output: path.join(target, 'Vmotion.exe'),
        dependencies: dependencies.length,
        ffmpegBundled: true,
        portable: true,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await releaseLock();
}
