import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged'),
  pkg = path.resolve('release/Vmotion');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/shared-ui-'));
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
  [cli, 'init', '--project', root, '--template', 'science', '--duration', '4'],
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
async function verify(BrowserWindow, root, url, options) {
  const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
  const { Client } = require(
    path.resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/client/index.js'),
  );
  const { StdioClientTransport } = require(
    path.resolve('node_modules/@modelcontextprotocol/sdk/dist/cjs/client/stdio.js'),
  );
  const w = new BrowserWindow({
      show: false,
      width: 1560,
      height: 1040,
      webPreferences: { sandbox: true, contextIsolation: true },
    }),
    client = new Client({ name: 'shared-editor-check', version: '1.0.0' }),
    transport = new StdioClientTransport({
      command: options.runtime,
      args: [options.cli, 'mcp', '--project', root],
      env: options.env,
      stderr: 'pipe',
    });
  const report = { root, checks: [] },
    check = (name, value) => {
      assert.ok(value, name);
      report.checks.push(name);
    };
  const ev = (code) => w.webContents.executeJavaScript(code, true),
    sleep = (ms) => new Promise((r) => setTimeout(r, ms)),
    until = async (code, name) => {
      let start = Date.now();
      while (Date.now() - start < 30000) {
        if (await ev(code)) return;
        await sleep(100);
      }
      throw Error(name);
    };
  const call = async (name, argumentsValue = {}) => {
    const r = await client.callTool({
      name: 'tool_call',
      arguments: { name, arguments: argumentsValue, response: 'full' },
    });
    const result = JSON.parse(r.content.find((c) => c.type === 'text').text);
    if (r.isError) throw Error(JSON.stringify(result));
    return result;
  };
  const click = async (label) => {
    await ev(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
    );
    await sleep(150);
  };
  try {
    await client.connect(transport);
    await w.loadURL(url + '/#/project');
    await until('!!document.querySelector(".topbar")', 'Studio missing');
    check(
      'normal editor contains visual and code workspaces',
      await ev(
        `document.querySelector('.workspaces').textContent.includes('代码')&&document.querySelector('.workspaces').textContent.includes('音乐')`,
      ),
    );
    await ev(`document.querySelector('[aria-label="连接 MCP"]').click()`);
    await until(`!!document.querySelector('[aria-label="MCP 配置"]')`, 'MCP configuration missing');
    check(
      'MCP dialog explains external file/tool editing without an Agent workbench',
      await ev(
        `document.querySelector('.mcp-connection').textContent.includes('AI 在外部')&&!document.querySelector('iframe')`,
      ),
    );
    await ev(`document.querySelector('[aria-label="关闭 MCP 连接"]').click()`);
    await click('动效');
    const before = await call('project_inspect');
    const original = before.snapshot.scenes[0].nodes.map((n) => n.id);
    await ev(`document.querySelector('[aria-label="Shape"]').click()`);
    await until(`document.querySelector('.layer-row.selected')!==null`, 'UI shape did not select');
    const after = await call('project_inspect'),
      added = after.snapshot.scenes[0].nodes.find((n) => !original.includes(n.id));
    check(
      'direct UI edit is immediately visible to real external stdio MCP',
      !!added && added.type === 'rect',
    );
    const plan = await call('project_preflight', {
      revision: after.snapshot.revision,
      operations: [
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: added.id,
          patch: { name: 'MCP reviewed layer', x: 155 },
        },
      ],
    });
    check(
      'MCP preflight preserves the UI project revision',
      (await call('project_context')).revision === after.snapshot.revision && plan.valid,
    );
    await call('project_apply', {
      revision: after.snapshot.revision,
      operations: [
        {
          type: 'updateNode',
          sceneId: 'intro',
          nodeId: added.id,
          patch: { name: 'MCP reviewed layer', x: 155 },
        },
      ],
      expectedCandidateRevision: plan.candidateRevision,
    });
    await until(
      `document.querySelector('.layer-list').textContent.includes('MCP reviewed layer')`,
      'MCP edit did not synchronize',
    );
    check('external MCP edits hot-sync into ordinary UI', true);
    await ev(`document.querySelector('[aria-label="Undo"]').click()`);
    await sleep(300);
    check(
      'UI undo restores the same MCP transaction',
      (await call('project_context')).revision === after.snapshot.revision,
    );
    const sceneFile = path.join(root, 'scenes/intro.json'),
      scene = JSON.parse(fs.readFileSync(sceneFile, 'utf8'));
    scene.nodes.find((n) => n.id === added.id).name = 'External file layer';
    fs.writeFileSync(sceneFile + '.tmp', JSON.stringify(scene, null, 2) + '\n');
    fs.renameSync(sceneFile + '.tmp', sceneFile);
    await until(
      `document.querySelector('.layer-list').textContent.includes('External file layer')`,
      'External file edit did not synchronize',
    );
    check(
      'direct external JSON edits enter the same preview and history',
      (await call('project_inspect')).snapshot.scenes[0].nodes.find((n) => n.id === added.id)
        .name === 'External file layer',
    );
    await ev(`document.querySelector('[aria-label="Undo"]').click()`);
    await sleep(300);
    check(
      'UI can undo a valid external file edit',
      (await call('project_context')).revision === after.snapshot.revision,
    );
    await click('代码');
    await until(`!!document.querySelector('.code-area textarea')`, 'Code workspace missing');
    check('human code workspace is available directly in the editor', true);
    await w.loadURL(url + '/#/music');
    await until(
      `!!document.querySelector('.music-app.embedded')&&!!document.querySelector('.studio-topbar [aria-label="连接 MCP"]')`,
      'Music MCP entry missing',
    );
    check('music uses direct UI plus simple MCP configuration', true);
    fs.writeFileSync(
      path.join(root, 'ui.png'),
      (await w.webContents.capturePage(undefined, { stayHidden: true, stayAwake: true })).toPNG(),
    );
    fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
    return report;
  } finally {
    await client.close();
    w.destroy();
  }
}
const main = path.join(root, 'check.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.disableHardwareAcceleration();app.whenReady().then(async()=>{try{const verify=${verify.toString()};console.log(JSON.stringify(await verify(BrowserWindow,${JSON.stringify(root)},${JSON.stringify(url)},${JSON.stringify({ runtime, cli, env })})));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`,
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
    child.once('exit', r);
    child.once('error', () => r(1));
  });
  clearTimeout(timer);
  assert.equal(code, 0);
  console.log(await readFile(path.join(root, 'report.json'), 'utf8'));
} finally {
  child?.kill();
  service.kill();
  await writeFile(path.join(root, 'service.log'), logs);
}
