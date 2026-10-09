import { app, BrowserWindow, dialog, ipcMain, shell, session } from 'electron';
import path from 'node:path';
import { writeFile } from 'node:fs/promises';
import { existsSync, mkdirSync } from 'node:fs';
import { Application } from '../service/application.js';
import { serveHttp } from '../service/http.js';
import { servePipe, existingService } from '../service/ipc.js';
import { initProject } from '../service/template.js';
import { resolveNativeBinary } from '../core/native.js';
import { projectCreationSchema } from '../core/project-creation.js';
import { availableRecent, rememberProject, projectFolder, projectRoot } from './projects.js';
import type http from 'node:http';
import type net from 'node:net';

let window: BrowserWindow;
let studio: Application | undefined;
let httpServer: http.Server | undefined;
let pipeServer: net.Server | undefined;
let stopping = false;
let switching = false;
if (process.env.VMOTION_TEST_USER_DATA)
  app.setPath('userData', path.resolve(process.env.VMOTION_TEST_USER_DATA));
else if (app.isPackaged && existsSync(path.join(path.dirname(process.execPath), 'portable.flag'))) {
  const profile = path.join(path.dirname(process.execPath), 'profile');
  mkdirSync(profile, { recursive: true });
  app.setPath('userData', profile);
}
if (process.env.VMOTION_UI_TEST || process.env.VMOTION_SMOKE) app.disableHardwareAcceleration();
const recentFile = () => path.join(app.getPath('userData'), 'recent-projects.json');
const clientDirectory = () => path.join(app.getAppPath(), 'dist/client');
function serverUrl(server: http.Server) {
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('无法启动本地编辑器服务');
  return `http://127.0.0.1:${address.port}`;
}
async function showMcpConnection() {
  await window.webContents.executeJavaScript(
    `new Promise((resolve,reject)=>{const start=Date.now();const check=()=>{if(document.documentElement.dataset.mcpConnectionReady==='true'){window.dispatchEvent(new Event('vmotion:connect-mcp'));resolve(true);}else if(Date.now()-start>10000)reject(new Error('MCP 连接入口未初始化'));else setTimeout(check,50);};check();})`,
  );
}
async function showHome() {
  if (!httpServer) httpServer = await serveHttp(undefined, 0, clientDirectory());
  await window.loadURL(`${serverUrl(httpServer)}/#/welcome`);
  window.setTitle('Vmotion · 项目');
}
async function openProject(input: string) {
  const root = projectRoot(input);
  if (switching) throw new Error('正在切换项目，请稍候');
  if (studio?.root === root) {
    await window.loadURL(`${serverUrl(httpServer!)}/#/project`);
    return;
  }
  switching = true;
  const candidate = new Application(root);
  let nextHttp: http.Server | undefined, nextPipe: net.Server | undefined;
  let navigating = false;
  try {
    if (await existingService(root))
      throw new Error('这个项目已有编辑器或服务正在使用，请先关闭对应会话');
    await candidate.open();
    nextPipe = await servePipe(candidate);
    nextHttp = await serveHttp(candidate, 0, clientDirectory());
    navigating = true;
    await window.loadURL(`${serverUrl(nextHttp)}/#/project`);
  } catch (error) {
    nextHttp?.closeAllConnections();
    nextHttp?.close();
    nextPipe?.close();
    await candidate.close().catch(() => {});
    if (navigating && httpServer)
      await window.loadURL(`${serverUrl(httpServer)}/#/${studio ? 'project' : 'welcome'}`);
    throw error;
  } finally {
    switching = false;
  }
  const previous = studio;
  httpServer?.closeAllConnections();
  httpServer?.close();
  pipeServer?.close();
  studio = candidate;
  httpServer = nextHttp;
  pipeServer = nextPipe;
  await previous?.close();
  window.setTitle(`${studio.service.snapshot.project.name} · Vmotion`);
  await rememberProject(recentFile(), root, studio.service.snapshot.project.name).catch((error) =>
    process.stderr.write(`Cannot save recent projects: ${error.message}\n`),
  );
}
app
  .whenReady()
  .then(async () => {
    const base = app.getAppPath();
    process.env.VMOTION_NATIVE = resolveNativeBinary(
      app.isPackaged ? path.join(process.resourcesPath, 'native') : path.join(base, 'dist/native'),
    );
    process.env.VMOTION_SDK_SOURCE = path.join(base, 'dist/sdk/index.mjs');
    if (app.isPackaged)
      process.env.ESBUILD_BINARY_PATH = path.join(process.resourcesPath, 'compiler/esbuild.exe');
    session.defaultSession.setPermissionCheckHandler((_contents, permission, _origin, details) => {
      if (permission === 'midi' || permission === 'midiSysex')
        return (
          _contents === window?.webContents &&
          /^http:\/\/127\.0\.0\.1:\d+(?:\/|$)/.test(details.requestingUrl ?? _origin)
        );
      return false;
    });
    session.defaultSession.setPermissionRequestHandler((contents, permission, callback) => {
      callback(
        (permission === 'midi' || permission === 'midiSysex') &&
          contents === window?.webContents &&
          /^http:\/\/127\.0\.0\.1:\d+\//.test(contents.getURL()),
      );
    });
    // Chromium may label requestMIDIAccess({sysex:false}) as midiSysex.
    // The local monitor requests no SysEx and parseMidi discards system messages.
    window = new BrowserWindow({
      show: !process.env.VMOTION_SMOKE && !process.env.VMOTION_UI_TEST,
      width: 1560,
      height: 1040,
      minWidth: 1100,
      minHeight: 720,
      title: 'Vmotion Studio',
      backgroundColor: '#111217',
      autoHideMenuBar: true,
      webPreferences: {
        preload: path.join(base, 'dist/desktop/preload.cjs'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        backgroundThrottling: !process.env.VMOTION_UI_TEST,
        offscreen: !!(process.env.VMOTION_UI_TEST || process.env.VMOTION_SMOKE),
      },
    });
    window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    window.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('http://127.0.0.1:')) event.preventDefault();
    });
    if (process.env.VMOTION_UI_TEST)
      ipcMain.handle('test:capture', async () =>
        (await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true }))
          .toPNG()
          .toString('base64'),
      );
    ipcMain.handle('asset:pick', async () => {
      const result = await dialog.showOpenDialog(window, {
        properties: ['openFile'],
        filters: [
          {
            name: '素材与字体',
            extensions: [
              'png',
              'jpg',
              'jpeg',
              'webp',
              'svg',
              'gif',
              'psd',
              'ora',
              'mp4',
              'mov',
              'mkv',
              'webm',
              'wav',
              'mp3',
              'flac',
              'ogg',
              'm4a',
              'ttf',
              'otf',
              'woff',
              'woff2',
            ],
          },
        ],
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle('plugin:pick', async (_event, kind: unknown) => {
      const result = await dialog.showOpenDialog(window, {
        properties: [kind === 'folder' ? 'openDirectory' : 'openFile'],
        ...(kind === 'folder'
          ? {}
          : { filters: [{ name: 'Vmotion 插件包', extensions: ['vmplugin', 'zip'] }] }),
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle('project:list', async () => ({
      directory: path.join(app.getPath('documents'), 'Vmotion'),
      recent: await availableRecent(recentFile()),
    }));
    ipcMain.handle('project:directory', async (_event, directory?: string) => {
      const result = await dialog.showOpenDialog(window, {
        title: '选择项目保存位置',
        defaultPath: directory || app.getPath('documents'),
        properties: ['openDirectory', 'createDirectory'],
      });
      return result.canceled ? undefined : result.filePaths[0];
    });
    ipcMain.handle('project:home', showHome);
    ipcMain.handle('agent:open', showMcpConnection);
    ipcMain.handle('studio:open', () => window.focus());
    ipcMain.handle('project:open', async (_event, root?: string) => {
      if (root !== undefined && typeof root !== 'string') throw new Error('项目路径格式无效');
      if (!root) {
        const result = await dialog.showOpenDialog(window, {
          title: '打开项目文件夹',
          defaultPath: app.getPath('documents'),
          properties: ['openDirectory'],
        });
        if (result.canceled) return;
        root = result.filePaths[0];
      }
      await openProject(root);
    });
    ipcMain.handle('project:create', async (_event, options: unknown) => {
      if (!options || typeof options !== 'object') throw new Error('请先填写新建项目设置');
      const { directory, ...input } = options as Record<string, unknown>;
      if (typeof directory !== 'string') throw new Error('请选择项目保存位置');
      const settings = projectCreationSchema.parse(input),
        root = projectFolder(directory, settings.name);
      const { name, ...configuration } = settings;
      await initProject(root, name, configuration);
      await openProject(root);
    });
    ipcMain.handle('file:show', (_event, file: string) => {
      if (studio && Array.from(studio.renders.jobs.values()).some((j) => j.output === file))
        shell.showItemInFolder(file);
    });
    const argument = process.argv.indexOf('--project');
    if (argument >= 0) {
      try {
        if (!process.argv[argument + 1] || process.argv[argument + 1].startsWith('--'))
          throw new Error('--project 后需要提供项目路径');
        await openProject(process.argv[argument + 1]);
      } catch (error) {
        await showHome();
        await dialog.showMessageBox(window, {
          type: 'error',
          title: '无法打开项目',
          message: (error as Error).message,
        });
      }
    } else {
      await showHome();
    }
    if (process.argv.includes('--agent-workbench')) await showMcpConnection();
    if (process.env.VMOTION_SMOKE) {
      const validation = studio ? await studio.dispatch('validate') : undefined,
        capture = studio
          ? await studio.dispatch('frame', {
              frame: 90,
              width: 640,
              height: 360,
              output: process.env.VMOTION_SMOKE + '.png',
            })
          : undefined;
      const ui = await window.webContents.executeJavaScript(`new Promise(resolve => {
        const start = Date.now(); const check = () => {
          if (document.querySelector('.project-home') || document.querySelector('.topbar') || Date.now()-start > 10000)
            resolve({url:location.href, text:document.body.innerText});
          else setTimeout(check, 50);
        }; check();
      })`);
      if (!studio)
        await writeFile(
          process.env.VMOTION_SMOKE + '.png',
          (
            await window.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })
          ).toPNG(),
        );
      await writeFile(
        process.env.VMOTION_SMOKE,
        JSON.stringify(
          {
            validation,
            capture,
            runtime: { electron: process.versions.electron, node: process.versions.node },
            project: studio?.root,
            ui,
          },
          null,
          2,
        ),
      );
      app.quit();
    }
  })
  .catch((error) => {
    dialog.showErrorBox('Vmotion could not start', error.message);
    app.quit();
  });
app.on('window-all-closed', () => app.quit());
app.on('before-quit', (event) => {
  if (stopping) return;
  event.preventDefault();
  stopping = true;
  httpServer?.closeAllConnections();
  httpServer?.close();
  pipeServer?.close();
  void (studio?.close() ?? Promise.resolve()).finally(() => app.quit());
});
