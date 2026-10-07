import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged'),
  pkg = path.resolve('release/Vmotion');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/surfaces-'));
const runtime = packaged ? path.join(pkg, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(pkg, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...process.env,
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(pkg, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
execFileSync(
  runtime,
  [cli, 'init', '--project', root, '--template', 'science', '--duration', '2'],
  { env, windowsHide: true },
);
const allocator = net.createServer();
await new Promise((r) => allocator.listen(0, '127.0.0.1', r));
const port = allocator.address().port;
await new Promise((r) => allocator.close(r));
const service = spawn(runtime, [cli, 'serve', '--project', root, '--port', String(port)], {
  env,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
});
let logs = '';
service.stdout.on('data', (d) => (logs += d));
service.stderr.on('data', (d) => (logs += d));
const url = 'http://127.0.0.1:' + port;
async function inspectWindows(BrowserWindow, root, url) {
  const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
  const report = { root, checks: [] },
    check = (name, value) => {
      assert.ok(value, name);
      report.checks.push(name);
    };
  const human = new BrowserWindow({
      show: false,
      width: 1560,
      height: 1040,
      webPreferences: { sandbox: true, contextIsolation: true },
    }),
    agent = new BrowserWindow({
      show: false,
      width: 1360,
      height: 940,
      webPreferences: { sandbox: true, contextIsolation: true },
    });
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    ev = (w, code) => w.webContents.executeJavaScript(code, true),
    until = async (w, code, name) => {
      const started = Date.now();
      while (Date.now() - started < 30000) {
        if (await ev(w, code)) return;
        await sleep(100);
      }
      throw Error(name);
    };
  const click = async (w, label) => {
    await ev(
      w,
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
    );
    await sleep(150);
  };
  const rpc = (method, params = {}, endpoint = '/api/agent/rpc') =>
    ev(
      agent,
      `fetch(${JSON.stringify(endpoint)},{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw Error(r.error.message);return r.result;})`,
    );
  await human.loadURL(url + '/#/project');
  await until(human, `!!document.querySelector('.topbar')`, 'Studio did not mount');
  check(
    'Studio has human workspaces and no code/MCP connection UI',
    await ev(
      human,
      `document.querySelector('.workspaces').textContent.includes('音乐')&&!document.querySelector('.workspaces').textContent.includes('代码')&&!document.querySelector('.topbar').textContent.includes('agent')&&!document.querySelector('.topbar').textContent.includes('MCP')`,
    ),
  );
  await agent.loadURL(url + '/agent/');
  await until(
    agent,
    `!!document.querySelector('[aria-label="MCP 配置"]')`,
    'Agent workbench did not mount',
  );
  check(
    'Agent has separate document/build and MCP config',
    await ev(
      agent,
      `document.title==='Vmotion Agent Workbench'&&!document.querySelector('.topbar')`,
    ),
  );
  const before = await rpc('state');
  await ev(agent, `location.hash='#/source?path=scenes/intro.json'`);
  await until(
    agent,
    `document.querySelector('[aria-label="TypeScript 组件源码"]')?.value.includes('nodes')`,
    'Agent source did not load',
  );
  const change = async (name) =>
    ev(
      agent,
      `(()=>{const el=document.querySelector('[aria-label="TypeScript 组件源码"]'),doc=JSON.parse(el.value);doc.name=${JSON.stringify(name)};Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,JSON.stringify(doc,null,2));el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
  await change('Agent reviewed scene');
  await click(agent, '预检源码');
  await until(
    agent,
    `document.querySelector('.agent-review')?.textContent.includes('预检通过')`,
    'Source preflight failed',
  );
  check(
    'preflight returns picture without changing active project',
    (await rpc('state')).snapshot.revision === before.snapshot.revision &&
      (await ev(agent, `!!document.querySelector('.agent-review img')`)),
  );
  await click(agent, '提交候选');
  await until(
    agent,
    `document.querySelector('.agent-meta').textContent.includes('已原子提交')`,
    'Exact candidate apply failed',
  );
  check(
    'source commit reaches shared Studio',
    (await rpc('state', {}, '/api/studio/rpc')).snapshot.scenes[0].name === 'Agent reviewed scene',
  );
  await until(
    human,
    `document.body.textContent.includes('Agent reviewed scene')`,
    'Studio did not hot-sync Agent edit',
  );
  await change('Second reviewed scene');
  await click(agent, '预检源码');
  await until(
    agent,
    `document.querySelector('.agent-review')?.textContent.includes('预检通过')`,
    'Accepted source hash was not refreshed',
  );
  check('successive source edits advance accepted hash', true);
  await rpc('undo', {}, '/api/studio/rpc');
  check(
    'Studio undo restores Agent edit atomically',
    (await rpc('state')).snapshot.revision === before.snapshot.revision,
  );
  await click(agent, '工具目录');
  await ev(
    agent,
    `(()=>{const el=document.querySelector('[aria-label="Agent 工具搜索"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,'audio');el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
  );
  await click(agent, '搜索');
  await until(
    agent,
    `document.querySelectorAll('.agent-tool-list button').length>0`,
    'Tool discovery failed',
  );
  await ev(agent, `document.querySelector('.agent-tool-list button').click()`);
  await until(
    agent,
    `!!document.querySelector('[aria-label="工具 Schema"]')`,
    'Schema discovery failed',
  );
  check('Agent discovers bounded tools and schemas', true);
  await human.loadURL(url + '/#/music');
  await until(human, `!!document.querySelector('.music-app')`, 'Music workspace missing');
  check(
    'human music excludes raw JSON tab',
    await ev(
      human,
      `!Array.from(document.querySelectorAll('.music-main-tabs button')).some(b=>b.textContent==='JSON')`,
    ),
  );
  fs.writeFileSync(
    path.join(root, 'studio.png'),
    (await human.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
  );
  fs.writeFileSync(
    path.join(root, 'agent.png'),
    (await agent.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
  );
  human.destroy();
  agent.destroy();
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
const main = path.join(root, 'check.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{try{const inspect=${inspectWindows.toString()};console.log(JSON.stringify(await inspect(BrowserWindow,${JSON.stringify(root)},${JSON.stringify(url)})));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`,
);
let child;
try {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(url)).ok) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  child = spawn(path.resolve('node_modules/electron/dist/electron.exe'), [main], {
    env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined },
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.pipe(process.stdout);
  child.stderr.pipe(process.stderr);
  const timer = setTimeout(() => child.kill(), 150000);
  const code = await new Promise((r) => {
    child.on('error', () => r(1));
    child.on('exit', r);
  });
  clearTimeout(timer);
  assert.equal(code, 0);
  console.log(await readFile(path.join(root, 'report.json'), 'utf8'));
} finally {
  child?.kill();
  service.kill();
  await writeFile(path.join(root, 'service.log'), logs);
}
