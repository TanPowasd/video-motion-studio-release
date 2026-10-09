// Real HTTP project service plus a hidden Electron window, isolated from user projects.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion');
const runtime = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath;
const cli = packaged
  ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
  : path.resolve('dist/cli/index.mjs');
const env = {
  ...process.env,
  ...(packaged
    ? {
        ELECTRON_RUN_AS_NODE: '1',
        ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
      }
    : {}),
};
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/music-studio-'));
execFileSync(
  runtime,
  [cli, 'init', '--project', root, '--width', '640', '--height', '360', '--duration', '12'],
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
const url = `http://127.0.0.1:${port}`;
async function runStudio(window, root, url, options) {
  const fs = require('node:fs'),
    path = require('node:path'),
    assert = require('node:assert/strict');
  const report = { checks: [], root },
    check = (name, value) => {
      assert.ok(value, name);
      report.checks.push(name);
    };
  const ev = (expression) => window.webContents.executeJavaScript(expression, true);
  const capture = async () => {
    await new Promise((resolve) => setTimeout(resolve, 200));
    return window.webContents.capturePage();
  };
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (expression, name, timeout = 30000) => {
    const start = Date.now();
    while (Date.now() - start < timeout) {
      if (await ev(expression)) return;
      await wait(100);
    }
    throw Error(name);
  };
  const click = async (label) => {
    await ev(
      `Array.from(document.querySelectorAll('button')).find(b=>b.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
    );
    await wait(100);
  };
  const set = async (label, value) => {
    await ev(
      `(()=>{const el=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await wait(100);
  };
  const rpc = (method, params = {}) =>
    ev(
      `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw Error(r.error.message);return r.result})`,
    );
  window.webContents.debugger.attach('1.3');
  const mouse = (type, x, y, buttons = 0) =>
    window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', {
      type,
      x,
      y,
      button: 'left',
      buttons,
      clickCount: 1,
    });
  await window.loadURL(url + '/#/music/new');
  await until(
    `document.querySelector('.music-app')&&document.querySelectorAll('.music-pattern-clip').length===1`,
    'Music workspace not mounted',
  );
  const before = await rpc('state');
  check('independent music route with linked playlist', await ev(`location.hash==='#/music/new'`));
  fs.writeFileSync(path.join(root, 'playlist.png'), (await capture()).toPNG());
  await click('Piano roll');
  await until(`document.querySelectorAll('.music-note').length>=3`, 'Piano did not render');
  const rect = await ev(
    `(()=>{const r=Array.from(document.querySelectorAll('.music-note')).map(n=>({id:n.parentElement.dataset.note,r:n.getBoundingClientRect()})).find(({r})=>r.top>200&&r.bottom<innerHeight-140);return {id:r.id,x:r.r.x+Math.min(15,r.r.width/2),y:r.r.y+r.r.height/2};})()`,
  );
  await mouse('mousePressed', rect.x, rect.y, 1);
  await wait(70);
  await mouse('mouseMoved', rect.x + 20, rect.y - 18, 1);
  await wait(100);
  await mouse('mouseReleased', rect.x + 20, rect.y - 18);
  await wait(100);
  check(
    'native pointer selects and moves note immediately',
    await ev(`document.querySelectorAll('[data-note].selected').length===1`),
  );
  const fields = await ev(
    `Array.from(document.querySelectorAll('.music-selection-bar label')).map(l=>({name:l.textContent,value:l.querySelector('input')?.value}))`,
  );
  check(
    'one drag changes pitch and snapped time',
    fields.some((f) => f.name === '起点' && Number(f.value) >= 0.25),
  );
  await set('音乐 BPM', '128');
  await click('Channel rack');
  await click('＋ 鼓组');
  await until(
    `document.querySelectorAll('.music-rack-row').length===4`,
    'Drum channels lost in batch',
  );
  await ev(`document.querySelector('[aria-label="kick 第 1 步"]').click()`);
  await wait(100);
  await ev(`document.querySelector('[aria-label="snare 第 5 步"]').click()`);
  await wait(100);
  check(
    'step sequencer stores drum steps',
    await ev(
      `document.querySelector('[aria-label="kick 第 1 步"]').getAttribute('aria-pressed')==='true'`,
    ),
  );
  await click('Mixer');
  await click('＋ Bus');
  await until(`document.querySelectorAll('.music-mixer-strip').length===6`, 'Bus not added');
  await click('效果');
  await ev(
    `(()=>{const el=document.querySelector('[aria-label="添加音乐效果"]');el.value='reverb';el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
  );
  await wait(100);
  check(
    'bus effects edited visually',
    await ev(`document.querySelectorAll('.music-fx-card').length===1`),
  );
  fs.writeFileSync(path.join(root, 'mixer.png'), (await capture()).toPNG());
  await click('试听草稿');
  await until(
    `document.querySelector('audio')?.src.startsWith('data:audio/wav;base64,')`,
    'Candidate audio missing',
  );
  check(
    'audition keeps active revision unchanged',
    (await rpc('state')).snapshot.revision === before.snapshot.revision,
  );
  await click('整曲试听');
  await until(
    `document.querySelector('audio')?.src.includes('/api/sound-audio?key=')&&!document.querySelector('.music-save-state').textContent.includes('…')`,
    'Full audition missing',
  );
  await until(
    `document.querySelector('audio').readyState>=2||!!document.querySelector('audio').error`,
    'Full WAV did not load',
  );
  check(
    'float WAV is playable in Chromium',
    await ev(
      `document.querySelector('audio').readyState>=2&&!document.querySelector('audio').error`,
    ),
  );
  await click('保存到素材库');
  await until(
    `location.hash.startsWith('#/music/')&&!location.hash.endsWith('/new')&&!document.querySelector('.music-save-state').textContent.includes('…')`,
    'Score save failed',
  );
  const state = await rpc('state'),
    asset = state.snapshot.project.assets.find((a) => a.soundSource),
    score = JSON.parse(state.snapshot.files[asset.soundSource]);
  check(
    'saved pattern retains dragged pitch/time',
    score.patterns[0].channels[0].events.find((n) => n.id === rect.id).at % 0.25 === 0 &&
      score.patterns[0].channels[0].events.find((n) => n.id === rect.id).note !==
        [60, 64, 67, 72][Number(rect.id.split('-')[1])],
  );
  check(
    'score retains patterns drums buses and tempo',
    score.tracks.length === 4 && score.buses.length === 1 && score.tempo[0].bpm === 128,
  );
  await click('导出 WAV');
  await until(
    `document.querySelector('.music-footer-status').textContent.includes('已导出')`,
    'WAV export failed',
  );
  check(
    'complete WAV artifact exists',
    fs.statSync(path.join(root, 'exports', asset.id + '.wav')).size > 100000,
  );
  await click('加入视频轨道');
  await click('保存并加入轨道');
  await until(
    `document.querySelector('.music-footer-status').textContent.includes('原子保存')`,
    'Timeline insertion failed',
  );
  check(
    'music reaches shared video timeline',
    (await rpc('state')).snapshot.sequences[0].tracks.some(
      (t) => t.type === 'audio' && t.clips.some((c) => c.assetId === asset.id),
    ),
  );
  await set('乐曲名称', '保留草稿');
  await wait(300);
  await ev(`location.hash='#/project'`);
  await until(`!!document.querySelector('.st-project')`, 'Video workspace did not mount');
  await ev(`location.hash=${JSON.stringify('#/music/')}+${JSON.stringify(asset.id)}`);
  await until(
    `document.querySelector('[aria-label="乐曲名称"]')?.value==='保留草稿'`,
    'Draft lost across routes',
  );
  check('route navigation restores unsaved draft', true);
  await rpc('soundPlan', {
    items: [
      { assetId: asset.id, actions: [{ type: 'settings', patch: { name: 'Agent 外部编辑' } }] },
    ],
  }).then((p) => rpc('projectApply', p.apply));
  await click('保存到素材库');
  await until(
    `document.querySelector('.music-footer-status').textContent.includes('草稿已保留')`,
    'Source conflict was silently overwritten',
  );
  check(
    'concurrent agent source edits preserve local draft',
    await ev(`document.querySelector('[aria-label="乐曲名称"]').value==='保留草稿'`),
  );
  await click('重新载入源文件');
  await until(
    `document.querySelector('[aria-label="乐曲名称"]').value==='Agent 外部编辑'`,
    'Explicit reload failed',
  );
  await click('Piano roll');
  fs.writeFileSync(path.join(root, 'piano.png'), (await capture()).toPNG());
  if (options.live) {
    const scan = await rpc('audioPlugins', { action: 'scan', paths: [options.fixture] });
    check(
      'isolated VST3 scan lists real instrument and effect',
      scan.plugins.length === 2 && !scan.diagnostics.length,
    );
    const config = {
      format: 'vst3',
      path: options.fixture,
      classId: scan.plugins[0].classId,
      name: scan.plugins[0].name,
      parameters: { 1: 0.25 },
      fingerprint: scan.plugins[0].fingerprint,
    };
    // Select a plugin through the actual picker and keep the current Pattern/track IDs.
    await click('乐器');
    await set('音频插件扫描路径', options.fixture);
    await click('扫描插件');
    await until(
      `document.querySelector('[aria-label="选择音频插件"]')?.options.length===3`,
      'Plugin picker scan failed',
    );
    await ev(
      `(()=>{const el=document.querySelector('[aria-label="选择音频插件"]');el.value='0';el.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await wait(150);
    await click('读取参数');
    await until(
      `!!document.querySelector('[aria-label="插件参数 Gain"]')`,
      'Normalized plugin parameters missing',
    );
    await click('MIDI 演奏');
    await click('开启实时演奏');
    await until(
      `Array.from(document.querySelectorAll('button')).some(b=>b.textContent==='关闭实时演奏')`,
      'Live instrument did not open',
    );
    await until(
      `document.querySelector('.music-midi .music-muted').textContent.includes('缓冲')`,
      'Live buffer status missing',
    );
    await click('● 录入音符');
    const liveKey = await ev(
      `(()=>{const r=document.querySelector('[aria-label="演奏音符 60"]').getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height-8}})()`,
    );
    await mouse('mousePressed', liveKey.x, liveKey.y, 1);
    await wait(400);
    await mouse('mouseReleased', liveKey.x, liveKey.y);
    await wait(100);
    await click('■ 停止录入');
    check(
      'screen keyboard records notes into a single editable draft',
      await ev(
        `document.querySelector('.music-midi .music-muted').textContent.includes('1 个录入音符')`,
      ),
    );
    const liveState = await rpc('audioLive', { action: 'query' });
    check(
      'live plugin maintains a bounded persistent stream',
      liveState.sessions.some((s) => s.blocks > 10),
    );
    await click('捕获插件音色');
    await wait(150);
    await click('保存到素材库');
    await until(
      `!document.querySelector('.music-save-state').textContent.includes('…')&&!document.querySelector('.music-save-state').textContent.includes('未保存')`,
      'Plugin state score did not save',
    );
    const pluginState = await rpc('state'),
      pluginDoc = JSON.parse(
        pluginState.snapshot.files[
          pluginState.snapshot.project.assets.find((a) => a.id === asset.id).soundSource
        ],
      );
    check(
      'plugin parameters/state and recorded notes survive save',
      pluginDoc.tracks[0].instrument.type === 'plugin' &&
        !!pluginDoc.tracks[0].instrument.state &&
        pluginDoc.patterns[0].channels[0].events.length === 5,
    );
    check(
      'closing native monitor releases sessions',
      (await rpc('audioLive', { action: 'query' })).sessions.length === 0,
    );
    await click('试听草稿');
    await until(
      `document.querySelector('audio')?.src.startsWith('data:audio/wav;base64,')&&!document.querySelector('.music-save-state').textContent.includes('…')`,
      'Recorded plugin score audition failed',
    );
    fs.writeFileSync(path.join(root, 'vst-midi.png'), (await capture()).toPNG());
  }
  fs.writeFileSync(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
  return report;
}
const main = path.join(root, 'check.cjs');
await writeFile(
  main,
  `const {app,BrowserWindow}=require('electron');app.commandLine.appendSwitch('autoplay-policy','no-user-gesture-required');app.whenReady().then(async()=>{const w=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{sandbox:true,contextIsolation:true}});try{const run=${runStudio.toString()};console.log(JSON.stringify(await run(w,${JSON.stringify(root)},${JSON.stringify(url)},${JSON.stringify({ live: process.argv.includes('--live'), fixture: path.resolve('artifacts/audio-build/VST3/Release/vmotion-audio-fixture.vst3') })})));app.exit(0);}catch(e){console.error(e);app.exit(1);}});`,
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
  const timer = setTimeout(() => child.kill(), 180000);
  const code = await new Promise((r) => {
    child.once('exit', (code) => r(code));
    child.once('error', (e) => {
      console.error(e);
      r(1);
    });
  });
  clearTimeout(timer);
  assert.equal(code, 0);
  console.log(JSON.stringify(JSON.parse(await readFile(path.join(root, 'report.json'), 'utf8'))));
} finally {
  child?.kill();
  service.kill();
  await writeFile(path.join(root, 'service.log'), logs);
}
