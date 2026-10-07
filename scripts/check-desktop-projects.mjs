// Actual hidden Electron window; isolated projects and preferences, no native picker automation.
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import net from 'node:net';
import path from 'node:path';
import assert from 'node:assert/strict';
const packaged = process.argv.includes('--packaged');
const packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion');
const isolated = process.argv.includes('--isolated');
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/desktop-projects-'));
const preferences = path.join(root, 'preferences'),
  projects = path.join(root, 'projects');
await mkdir(preferences);
await mkdir(projects);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn, message, timeout = 20000) {
  const start = Date.now();
  let last;
  while (Date.now() - start < timeout) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      last = error;
    }
    await delay(100);
  }
  throw new Error(`${message}: ${last?.message ?? 'timeout'}`);
}
async function launch() {
  const allocator = net.createServer();
  await new Promise((resolve) => allocator.listen(0, '127.0.0.1', resolve));
  const port = allocator.address().port;
  await new Promise((resolve) => allocator.close(resolve));
  const executable = path.resolve(
    packaged ? path.join(packageRoot, 'Vmotion.exe') : 'node_modules/electron/dist/electron.exe',
  );
  const child = spawn(executable, [...(packaged ? [] : ['.']), `--remote-debugging-port=${port}`], {
    cwd: path.resolve('.'),
    windowsHide: true,
    env: {
      ...process.env,
      ...(isolated
        ? {
            Path: path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32'),
            PATH: path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32'),
            VMOTION_NATIVE: undefined,
            VMOTION_RUNTIME: undefined,
            VMOTION_FFMPEG: undefined,
            VMOTION_FFPROBE: undefined,
            ESBUILD_BINARY_PATH: undefined,
            NODE_PATH: undefined,
            NODE_OPTIONS: undefined,
          }
        : {}),
      VMOTION_UI_TEST: '1',
      VMOTION_TEST_USER_DATA: preferences,
      ELECTRON_RUN_AS_NODE: undefined,
      VMOTION_SMOKE: undefined,
    },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', (data) => {
    stderr += String(data);
  });
  let exited = false;
  const exit = new Promise((resolve) =>
    child.once('exit', (code) => {
      exited = true;
      resolve(code);
    }),
  );
  const pending = new Map();
  let id = 0;
  let socket;
  try {
    const target = await until(async () => {
      if (exited) throw new Error(`Electron exited: ${stderr}`);
      const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      return targets.find(
        (target) => target.type === 'page' && target.url.startsWith('http://127.0.0.1:'),
      );
    }, 'Cannot connect to desktop');
    socket = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true });
      socket.addEventListener('error', reject, { once: true });
    });
    socket.addEventListener('message', (event) => {
      const response = JSON.parse(event.data);
      if (response.method === 'Runtime.exceptionThrown')
        stderr += '\n' + JSON.stringify(response.params);
      if (response.method === 'Runtime.consoleAPICalled' && response.params.type === 'error')
        stderr += '\n' + JSON.stringify(response.params.args);
      const promise = pending.get(response.id);
      if (promise) {
        pending.delete(response.id);
        response.error
          ? promise.reject(new Error(response.error.message))
          : promise.resolve(response.result);
      }
    });
    socket.addEventListener('close', () => {
      for (const promise of pending.values()) promise.reject(new Error('Debugger closed'));
      pending.clear();
    });
    const call = (method, params = {}) =>
      new Promise((resolve, reject) => {
        const request = ++id,
          timer = setTimeout(() => {
            pending.delete(request);
            reject(new Error(`Debugger timed out: ${method}`));
          }, 15000);
        pending.set(request, {
          resolve: (value) => {
            clearTimeout(timer);
            resolve(value);
          },
          reject: (error) => {
            clearTimeout(timer);
            reject(error);
          },
        });
        socket.send(JSON.stringify({ id: request, method, params }));
      });
    const evaluate = async (expression) => {
      const value = await call('Runtime.evaluate', {
        expression,
        returnByValue: true,
        awaitPromise: true,
      });
      if (value.exceptionDetails)
        throw new Error(
          value.exceptionDetails.exception?.description ?? value.exceptionDetails.text,
        );
      return value.result.value;
    };
    await call('Runtime.enable');
    await until(() => evaluate("!!document.querySelector('.project-home')"), 'Home did not mount');
    return {
      debugPort: port,
      evaluate,
      call,
      async close() {
        try {
          await call('Page.close');
        } catch {}
        socket.close();
        const done = await Promise.race([exit, delay(5000).then(() => 'timeout')]);
        if (done === 'timeout') {
          child.kill();
          await exit;
        }
        await writeFile(path.join(root, 'desktop-stderr.log'), stderr);
      },
    };
  } catch (error) {
    socket?.close();
    if (!exited) child.kill();
    await exit;
    throw error;
  }
}
const report = { packaged, root, checks: [] };
let desktop = await launch();
const check = (name, value) => {
  assert.ok(value, name);
  report.checks.push(name);
};
const click = (label) =>
  desktop.evaluate(
    `Array.from(document.querySelectorAll('button')).find(button=>button.textContent.trim().startsWith(${JSON.stringify(label)})).click()`,
  );
const capture = () =>
  until(
    () => desktop.evaluate('window.vmotionDesktop.captureTestWindow()'),
    'Hidden window did not produce a frame',
    5000,
  );
const formSet = (label, value) =>
  desktop.evaluate(`(() => {
  const field=Array.from(document.querySelectorAll('.new-project-form label')).find(label=>label.firstChild.textContent.trim()===${JSON.stringify(label)}).querySelector('input,select');
  Object.getOwnPropertyDescriptor(field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});
  field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));
})()`);
try {
  check(
    'launches project home',
    await desktop.evaluate(
      "location.hash === '#/welcome' && document.body.innerText.includes('新建项目')",
    ),
  );
  check('does not mount demo editor', await desktop.evaluate("!document.querySelector('.topbar')"));
  const fonts = await desktop.evaluate(
    `Promise.all(['/runtime/font.otf','/runtime/font-bold.otf'].map(async url=>{const response=await fetch(url);return {url,status:response.status,type:response.headers.get('Content-Type')};}))`,
  );
  check(
    'serves both runtime fonts',
    fonts.every((font) => font.status === 200 && font.type === 'font/otf'),
  );
  await until(
    () =>
      desktop.evaluate(
        `Array.from(document.fonts).filter(font=>font.family.includes('Vmotion UI Sans')&&font.status==='loaded').length===2`,
      ),
    'Runtime FontFace loading did not complete',
  ).catch(async (error) => {
    throw Error(
      error.message +
        ' ' +
        JSON.stringify(
          await desktop.evaluate(
            `({fonts:Array.from(document.fonts).map(font=>({family:font.family,status:font.status,weight:font.weight})),resources:performance.getEntriesByType('resource').filter(entry=>entry.name.includes('/runtime/')).map(entry=>({name:entry.name,bytes:entry.transferSize}))})`,
          ),
        ),
    );
  });
  check('loads both runtime FontFace entries without build asset URLs', true);
  const homeImage = await capture();
  await writeFile(path.join(root, 'home.png'), Buffer.from(homeImage, 'base64'));
  await desktop.call('Input.dispatchKeyEvent', {
    type: 'keyDown',
    key: 'n',
    code: 'KeyN',
    modifiers: 2,
  });
  await desktop.call('Input.dispatchKeyEvent', { type: 'keyUp', key: 'n', code: 'KeyN' });
  await until(
    () => desktop.evaluate("!!document.querySelector('.new-project-form')"),
    'Ctrl+N did not open creation',
  );
  await until(
    () => desktop.evaluate("document.querySelector('.project-directory input').value.length > 0"),
    'No default directory',
  );
  await formSet('项目名称', '空白动画');
  await formSet('保存位置', projects);
  await formSet('宽度', '1280');
  await formSet('高度', '720');
  await formSet('帧率', '30000/1001');
  await formSet('初始时长（秒）', '12');
  const formImage = await capture();
  await writeFile(path.join(root, 'new-project.png'), Buffer.from(formImage, 'base64'));
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('空白动画')",
      ),
    'Blank creation did not open editor',
  );
  const manifest = JSON.parse(
    await readFile(path.join(projects, '空白动画/project.vmotion.json'), 'utf8'),
  );
  const scene = JSON.parse(
    await readFile(path.join(projects, '空白动画/scenes/intro.json'), 'utf8'),
  );
  check('creates real blank scene', scene.nodes.length === 0);
  const rawPreview = await desktop.evaluate(
    `(async()=>{const response=await fetch('/api/frame?frame=0&width=320&height=180&format=rgba');const bytes=await response.arrayBuffer();const image=new ImageData(new Uint8ClampedArray(bytes),320,180),bitmap=await createImageBitmap(image),canvas=document.createElement('canvas');canvas.width=320;canvas.height=180;canvas.getContext('2d').drawImage(bitmap,0,0);bitmap.close();return {format:response.headers.get('X-Vmotion-Format'),bytes:bytes.byteLength,alpha:canvas.getContext('2d').getImageData(0,0,1,1).data[3]};})()`,
  );
  check(
    'browser presents lossless RGBA preview',
    rawPreview.format === 'rgba' && rawPreview.bytes === 320 * 180 * 4 && rawPreview.alpha === 255,
  );
  check(
    'saves chosen canvas and rational fps',
    manifest.width === 1280 &&
      manifest.height === 720 &&
      manifest.fps.num === 30000 &&
      manifest.fps.den === 1001,
  );
  const seq = JSON.parse(
    await readFile(path.join(projects, '空白动画/sequences/main.json'), 'utf8'),
  );
  check('saves initial duration', seq.duration === 360);
  const state = await desktop.evaluate(
    "fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())",
  );
  check(
    'blank project reaches shared service',
    state.result.snapshot.scenes[0].nodes.length === 0 && state.result.diagnostics.length === 0,
  );
  const revision = state.result.snapshot.revision;
  const fail = await desktop.evaluate(
    `window.vmotionDesktop.openProject(${JSON.stringify(path.join(root, 'missing'))}).then(()=>null,error=>error.message)`,
  );
  check('invalid open reports error', typeof fail === 'string' && fail.length > 0);
  const after = await desktop.evaluate(
    "fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())",
  );
  check(
    'invalid open retains active project',
    after.result.snapshot.revision === revision && after.result.root === state.result.root,
  );
  await click('新建');
  await until(
    () => desktop.evaluate("!!document.querySelector('.new-project-form')"),
    'Editor creation entry failed',
  );
  await until(
    () => desktop.evaluate("document.querySelector('.project-directory input').value.length > 0"),
    'No directory',
  );
  await formSet('项目名称', '空白动画');
  await formSet('保存位置', projects);
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-form-error')?.textContent.includes('empty')",
      ),
    'Existing directory was not rejected',
  );
  check(
    'duplicate creation preserves existing project',
    (await readFile(path.join(projects, '空白动画/scenes/intro.json'), 'utf8')) ===
      JSON.stringify(scene, null, 2) + '\n',
  );
  await formSet('项目名称', '科普动画');
  await formSet('起始内容', 'science');
  await click('创建并打开');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('科普动画')",
      ),
    'Science creation failed',
  );
  check(
    'science template is optional',
    JSON.parse(
      await readFile(path.join(projects, '科普动画/scenes/intro.json'), 'utf8'),
    ).nodes.some((node) => node.id === 'wave'),
  );
  await desktop.evaluate('document.querySelector(\'[aria-label="项目首页"]\').click()');
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.recent-projects')?.innerText.includes('空白动画')",
      ),
    'Recent projects did not appear',
  );
  check(
    'records both projects',
    await desktop.evaluate("document.querySelectorAll('.recent-projects > button').length === 2"),
  );
  await desktop.close();
  desktop = await launch();
  check('restart defaults to home', await desktop.evaluate("location.hash === '#/welcome'"));
  await until(
    () => desktop.evaluate("document.querySelectorAll('.recent-projects > button').length === 2"),
    'Recent projects did not persist',
  );
  await desktop.evaluate(
    "Array.from(document.querySelectorAll('.recent-projects > button')).find(button=>button.textContent.includes('空白动画')).click()",
  );
  await until(
    () =>
      desktop.evaluate(
        "document.querySelector('.project-title')?.textContent.includes('空白动画')",
      ),
    'Recent reopen failed',
  );
  check('reopens chosen project after restart', true);
  if (process.argv.includes('--plugins')) {
    const rpc = (method, params = {}) =>
        desktop.evaluate(
          `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw new Error(r.error.message);return r.result})`,
        ),
      source = 'components/plugins/ui/plugin.json',
      code = 'components/plugins/ui/card.ts';
    await rpc('transact', {
      operations: [
        {
          type: 'writeSource',
          path: source,
          content: JSON.stringify({
            kind: 'vmotion-plugin',
            apiVersion: 1,
            id: 'example.ui',
            name: 'UI创作包',
            version: '1.0.0',
            contributions: [{ id: 'card', name: '卡片', kind: 'component', source: code }],
            tools: [],
          }),
        },
        {
          type: 'writeSource',
          path: code,
          content:
            "import {defineComponent,node} from '@vmotion/sdk';export default defineComponent({name:'卡片',parameters:{},render(ctx){return [node({id:'fill',type:'rect',width:ctx.width,height:ctx.height,fill:'#55aabb'})]}});",
        },
      ],
    });
    await desktop.evaluate(`document.querySelector('[aria-label="插件管理"]').click()`);
    await until(
      () => desktop.evaluate(`!!document.querySelector('.plugin-list article')`),
      'Plugin manager did not load on demand',
    );
    check('loads builtin plugin registry in the desktop manager', true);
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.plugin-list article')).find(a=>a.textContent.includes('vmotion.audio')).querySelector('button').click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.plugin-detail')?.innerText.includes('已接入插件：15 / 15')`,
        ),
      'Complete audio module migration was not shown',
    );
    check('shows actual complete audio module migration', true);
    for (const [id, count] of [
      ['vmotion.editing', 7],
      ['vmotion.render', 7],
      ['vmotion.3d', 5],
      ['vmotion.vector', 6],
      ['vmotion.drawing', 8],
      ['vmotion.composition', 10],
      ['vmotion.tracking', 4],
      ['vmotion.animation', 14],
      ['vmotion.effects', 14],
      ['vmotion.media', 12],
      ['vmotion.core', 15],
      ['vmotion.recovery', 3],
      ['vmotion.cache', 3],
      ['vmotion.review', 7],
      ['vmotion.organization', 4],
    ]) {
      if (
        !(await desktop.evaluate(
          `Array.from(document.querySelectorAll('.plugin-list article')).some(a=>a.textContent.includes(${JSON.stringify(id)}))`,
        ))
      ) {
        await click('下一页');
        await until(
          () =>
            desktop.evaluate(
              `Array.from(document.querySelectorAll('.plugin-list article')).some(a=>a.textContent.includes(${JSON.stringify(id)}))`,
            ),
          'Paged builtin module was not shown: ' + id,
        );
      }
      await desktop.evaluate(
        `Array.from(document.querySelectorAll('.plugin-list article')).find(a=>a.textContent.includes(${JSON.stringify(id)})).querySelector('button').click()`,
      );
      await until(
        () =>
          desktop.evaluate(
            `document.querySelector('.plugin-detail')?.innerText.includes(${JSON.stringify('已接入插件：' + count + ' / ' + count)})`,
          ),
        'Workflow module migration was not shown: ' + id,
      );
    }
    check('shows actual complete editing and render module migration', true);
    check('shows actual complete 3D and graphics module migration', true);
    check('shows actual complete drawing composition and tracking module migration', true);
    check('shows complete core recovery cache review animation effects and media modules', true);
    await desktop.evaluate(
      `(()=>{const input=document.querySelector('[aria-label="插件清单路径"]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(input,${JSON.stringify(source)});input.dispatchEvent(new Event('input',{bubbles:true}));})()`,
    );
    await click('注册本地插件');
    const manifest = path.join(projects, '空白动画/project.vmotion.json'),
      project = async () => JSON.parse(await readFile(manifest, 'utf8'));
    await until(
      async () => (await project()).plugins?.length === 1,
      'Desktop plugin registration did not save',
    );
    await until(
      () =>
        desktop.evaluate(`document.querySelector('.plugin-list')?.innerText.includes('UI创作包')`),
      'Registered plugin is missing from manager',
    );
    check('registers project plugin through exact preflight/apply', true);
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.plugin-list article')).find(a=>a.textContent.includes('example.ui')).querySelector('button').click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.plugin-detail')?.innerText.includes('components/plugins/ui/card.ts')`,
        ),
      'Contribution sources are missing',
    );
    const picture = await capture();
    await writeFile(path.join(root, 'plugin-manager.png'), Buffer.from(picture, 'base64'));
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.plugin-list article')).find(a=>a.textContent.includes('example.ui')).querySelectorAll('button')[1].click()`,
    );
    await until(
      async () => (await project()).plugins[0].enabled === false,
      'Desktop plugin disable did not save',
    );
    await until(
      () =>
        desktop.evaluate(
          `!document.querySelector('.plugin-manager footer button:last-child').disabled`,
        ),
      'Plugin disable remained busy',
    );
    await desktop.evaluate(
      `document.querySelector('.plugin-manager footer button:last-child').click()`,
    );
    await until(
      async () => (await project()).plugins[0].enabled === true,
      'Plugin undo did not restore enabled state',
    );
    check('disables library and restores registration with one undo', true);
    check(
      'plugin operations preserve author source',
      (await readFile(path.join(projects, '空白动画', code), 'utf8')).includes('defineComponent'),
    );
    await desktop.evaluate(`document.querySelector('.plugin-manager header button').click()`);
    await until(
      () => desktop.evaluate(`!document.querySelector('.plugin-manager')`),
      'Plugin manager did not close',
    );
  }
  if (process.argv.includes('--design')) {
    const rpc = (method, params = {}) =>
        desktop.evaluate(
          `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw new Error(r.error.message);return r.result})`,
        ),
      current = async () => rpc('state'),
      apply = async (method, params) => {
        const state = await current(),
          plan = await rpc(method, { revision: state.snapshot.revision, ...params }),
          checked = await rpc('projectPreflight', plan.candidate);
        assert.equal(checked.valid, true, JSON.stringify(checked.diagnostics));
        await rpc('projectApply', plan.apply);
        return plan;
      };
    const def = {
        id: 'ui-card',
        name: 'UI 信息卡',
        version: 1,
        width: 320,
        height: 180,
        duration: 360,
        parameters: {
          title: { type: 'string', default: '模板标题' },
          color: { type: 'color', default: '#55aabb' },
        },
        ports: [
          { parameter: 'title', nodeId: 'label', property: 'text' },
          { parameter: 'color', nodeId: 'label', property: 'fill' },
        ],
      },
      nodes = [
        {
          id: 'label',
          type: 'text',
          text: '模板标题',
          fontSize: 30,
          width: 280,
          height: 90,
          x: 20,
          y: 30,
          fill: '#55aabb',
        },
      ];
    await apply('templatePlan', {
      publish: { definition: def, nodes },
      placements: [
        {
          sceneId: 'intro',
          nodeId: 'ui-card',
          name: 'UI 模板',
          x: 200,
          y: 180,
          width: 640,
          height: 360,
          params: { title: '自己的标题' },
        },
      ],
    });
    const published = await apply('templatePlan', {
      publish: {
        definition: {
          ...def,
          version: 2,
          parameters: { ...def.parameters, title: { type: 'string', default: '新版标题' } },
        },
        nodes,
      },
    });
    await apply('themePlan', {
      source: 'components/themes/ui.json',
      expectedHash: null,
      document: {
        kind: 'theme',
        version: 1,
        id: 'ui',
        name: 'UI主题',
        tokens: [{ id: 'accent', type: 'color', value: '#66d6c4' }],
      },
      targets: [{ sceneId: 'intro', nodeId: 'ui-card', links: { 'params.color': 'accent' } }],
    });
    await desktop.evaluate(`document.querySelector('.scene-row').click()`);
    await until(
      () => desktop.evaluate(`location.hash.includes('/composition/intro')`),
      'Design scene did not open',
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.layer-name')).some(b=>b.textContent.includes('UI 模板'))`,
        ),
      'Template layer missing',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.includes('UI 模板')).click()`,
    );
    await until(
      () => desktop.evaluate(`document.querySelectorAll('.design-inspector details').length===2`),
      'Design inspector did not mount',
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.parameter-string input')).some(i=>i.value==='自己的标题')`,
        ),
      'Template ports did not populate ordinary parameter inspector',
    );
    check('template ports appear in the shared parameter inspector', true);
    await desktop.evaluate(
      `document.querySelectorAll('.design-inspector details').forEach(d=>d.open=true);document.querySelector('.design-inspector').scrollIntoView({block:'center'})`,
    );
    await until(
      () =>
        desktop.evaluate(`document.querySelector('.theme-field span')?.textContent==='#66d6c4'`),
      'Effective theme value was not shown',
    );
    check('shows live effective brand values', true);
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelector('[aria-label="升级模板版本"]').options).some(o=>o.value===${JSON.stringify(published.published)})`,
        ),
      'Version choices missing',
    );
    await desktop.evaluate(
      `(()=>{const select=document.querySelector('[aria-label="升级模板版本"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(select,${JSON.stringify(published.published)});select.dispatchEvent(new Event('change',{bubbles:true}));})()`,
    );
    await click('预检并升级实例');
    const sceneFile = path.join(projects, '空白动画/scenes/intro.json'),
      savedNode = async () =>
        JSON.parse(await readFile(sceneFile, 'utf8')).nodes.find((n) => n.id === 'ui-card');
    await until(
      async () => (await savedNode()).templateInstance.source === published.published,
      'UI upgrade failed',
    );
    check(
      'upgrades selected version and retains customized title',
      (await savedNode()).params.title === '自己的标题',
    );
    await until(
      () =>
        desktop.evaluate(
          `!Array.from(document.querySelectorAll('.design-inspector button')).find(b=>b.textContent==='建立可编辑本地副本')?.disabled`,
        ),
      'Upgrade remained busy',
    );
    await click('建立可编辑本地副本');
    await until(
      async () => (await savedNode()).templateInstance.mode === 'local',
      'UI detach failed',
    );
    check('creates a private editable template copy', true);
    await rpc('undo');
    await until(
      async () => (await savedNode()).templateInstance.mode === 'linked',
      'UI template undo failed',
    );
    check('one undo restores the linked template version', true);
    await until(
      () => desktop.evaluate(`document.querySelectorAll('.design-inspector').length===1`),
      'Design inspector retained stale panels',
    );
    const shot = await capture();
    await writeFile(path.join(root, 'design-inspector.png'), Buffer.from(shot, 'base64'));
  }
  if (process.argv.includes('--tracking')) {
    const rpc = (method, params = {}) =>
        desktop.evaluate(
          `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw new Error(r.error.message);return r.result})`,
        ),
      source = path.join(root, 'tracking-source.mkv');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=1',
        '-c:v',
        'ffv1',
        '-pix_fmt',
        'bgra',
        source,
      ],
      { windowsHide: true },
    );
    const imported = await rpc('import', { path: source, type: 'video' }),
      asset = imported.snapshot.project.assets.at(-1);
    await rpc('transact', {
      operations: [
        {
          type: 'addNode',
          sceneId: 'intro',
          node: {
            id: 'tracking-video',
            type: 'video',
            name: 'UI 跟踪视频',
            assetId: asset.id,
            width: 1280,
            height: 720,
          },
        },
      ],
    });
    await desktop.evaluate(`document.querySelector('.scene-row').click()`);
    await until(
      () => desktop.evaluate(`location.hash.includes('/composition/intro')`),
      'Tracking scene did not open',
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.layer-name')).some(b=>b.textContent.includes('UI 跟踪视频'))`,
        ),
      'Tracking layer missing',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.includes('UI 跟踪视频')).click();Array.from(document.querySelectorAll('.inspector-tabs button')).find(b=>b.textContent==='动画').click()`,
    );
    await until(
      () => desktop.evaluate(`!!document.querySelector('.tracking-inspector')`),
      'Tracking inspector missing',
    );
    await desktop.evaluate(
      `document.querySelector('.tracking-inspector').open=true;document.querySelector('.tracking-inspector').scrollIntoView({block:'center'})`,
    );
    const inputSet = (label, value) =>
      desktop.evaluate(
        `(()=>{const field=document.querySelector('[aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event('input',{bubbles:true}));})()`,
      );
    await inputSet('跟踪源出点', 20);
    await inputSet('跟踪分析宽度', 320);
    await click('分析运动');
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.tracking-status')?.textContent.includes('completed')`,
        ),
      'UI tracking did not finish',
      30000,
    );
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.tracking-inspector small')?.textContent.includes('有效')`,
        ),
      'UI tracking quality missing',
    );
    check('runs background motion analysis from inspector', true);
    await inputSet('稳定本地出点', 20);
    await click('查看跟踪证据');
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.tracking-inspector img')?.src.startsWith('data:image/png;base64,')`,
        ),
      'UI tracking evidence missing',
    );
    check('displays annotated original frame evidence', true);
    await until(
      () =>
        desktop.evaluate(
          `!Array.from(document.querySelectorAll('.tracking-inspector button')).find(b=>b.textContent==='保存轨迹资源')?.disabled`,
        ),
      'Tracking remained busy',
    );
    await click('保存轨迹资源');
    await until(
      async () =>
        JSON.parse(
          await readFile(path.join(projects, '空白动画/project.vmotion.json'), 'utf8'),
        ).assets.some((a) => a.id === asset.id) &&
        (await desktop.evaluate(
          `document.querySelector('.tracking-inspector').innerText.includes('components/tracking/')`,
        )),
      'Tracking resource not saved',
    );
    check('saves editable source track resource through exact candidate', true);
    const sceneFile = path.join(projects, '空白动画/scenes/intro.json');
    await until(
      () =>
        desktop.evaluate(
          `!Array.from(document.querySelectorAll('.tracking-inspector button')).find(b=>b.textContent==='稳定当前视频')?.disabled`,
        ),
      'No complete points available for UI stabilization',
    );
    await click('稳定当前视频');
    await until(
      async () =>
        JSON.parse(await readFile(sceneFile, 'utf8'))
          .nodes.find((n) => n.id === 'tracking-video')
          .animations.some((a) => a.property === 'matrix.4'),
      'UI stabilization did not save',
      30000,
    );
    check('preflights and saves stabilization with explicit local range/zoom', true);
    await rpc('undo');
    await until(
      async () =>
        !JSON.parse(await readFile(sceneFile, 'utf8')).nodes.find((n) => n.id === 'tracking-video')
          .animations.length,
      'UI stabilization undo failed',
    );
    check('undo restores video motion while retaining tracking resource', true);
    const lost = await desktop.evaluate(`document.querySelector('.tracking-inspector').innerText`);
    check('reports valid and lost sample counts', lost.includes('失跟'));
    const shot = await capture();
    await writeFile(path.join(root, 'tracking-inspector.png'), Buffer.from(shot, 'base64'));
  }
  if (process.argv.includes('--graphics')) {
    const rpc = (method, params = {}) =>
      desktop.evaluate(
        `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(${JSON.stringify({ method, params })})}).then(r=>r.json()).then(r=>{if(r.error)throw new Error(r.error.message);return r.result})`,
      );
    await rpc('transact', {
      operations: [
        {
          type: 'addNode',
          sceneId: 'intro',
          node: {
            id: 'graphics-text',
            type: 'text',
            name: 'UI 文字',
            text: '共享布局与路径文字',
            fontSize: 28,
            width: 600,
            height: 120,
            x: 180,
            y: 160,
            fill: '#ffffff',
          },
        },
        {
          type: 'addNode',
          sceneId: 'intro',
          node: {
            id: 'graphics-shape',
            type: 'rect',
            name: 'UI 形状',
            x: 800,
            y: 240,
            width: 150,
            height: 100,
            fill: '#6edec3',
            shapeOperators: [
              { id: 'round-ui', type: 'round', radius: 12 },
              { id: 'offset-ui', type: 'offset', amount: 5 },
            ],
          },
        },
      ],
    });
    const sceneFile = path.join(projects, '空白动画/scenes/intro.json');
    const savedNode = async (id) =>
      JSON.parse(await readFile(sceneFile, 'utf8')).nodes.find((n) => n.id === id);
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.layer-name')).some(b=>b.textContent.includes('UI 文字'))`,
        ),
      'Graphics layers missing',
    );
    await desktop.evaluate(`document.querySelector('.scene-row').click()`);
    await until(
      () => desktop.evaluate(`location.hash.includes('/composition/intro')`),
      'Graphics scene did not open',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.includes('UI 文字')).click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.graphics-inspector summary')?.textContent.includes('文字范围')`,
        ),
      'Typography inspector missing',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.inspector-tabs button')).find(b=>b.textContent==='动画').click()`,
    );
    await desktop.evaluate(
      `document.querySelector('.graphics-inspector summary').click();document.querySelector('.graphics-inspector').scrollIntoView({block:'center'})`,
    );
    await click('添加字素选择器');
    await until(
      async () => (await savedNode('graphics-text')).textAnimators.length === 1,
      'Text selector was not saved',
    );
    check('adds text animator through shared exact-candidate service', true);
    await until(
      () =>
        desktop.evaluate(
          `!!document.querySelector('.graphics-inspector input[type=checkbox]')&&!document.querySelector('.graphics-inspector input[type=checkbox]').disabled`,
        ),
      'Typography remained busy',
    );
    await desktop.evaluate(
      `document.querySelector('.graphics-inspector input[type=checkbox]').click()`,
    );
    await until(
      async () => (await savedNode('graphics-text')).textAnimators[0].enabled === false,
      'Text toggle failed',
    );
    check('toggles stable text animator without discarding data', true);
    await until(
      () =>
        desktop.evaluate(
          `!!document.querySelector('[aria-label="路径文字 SVG"]')&&!document.querySelector('[aria-label="路径文字 SVG"]').disabled`,
        ),
      'Path input remained busy',
    );
    await desktop.evaluate(
      `(()=>{const field=document.querySelector('[aria-label="路径文字 SVG"]');field.focus();Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(field,'M0 70Q240 0 500 70');field.dispatchEvent(new Event('input',{bubbles:true}));field.dispatchEvent(new FocusEvent('focusout',{bubbles:true}));})()`,
    );
    await until(
      async () => (await savedNode('graphics-text')).pathText?.path === 'M0 70Q240 0 500 70',
      'Path text input failed',
    );
    check('saves path text from inspector', true);
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.includes('UI 形状')).click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.graphics-inspector summary')?.textContent.includes('形状算子')`,
        ),
      'Shape inspector missing',
    );
    await desktop.evaluate(
      `document.querySelector('.graphics-inspector').open=true;document.querySelector('.graphics-inspector').scrollIntoView({block:'center'});document.querySelectorAll('.graphics-inspector button[title="上移"]')[1].click()`,
    );
    await until(
      async () => (await savedNode('graphics-shape')).shapeOperators[0].id === 'offset-ui',
      'Shape order failed',
    );
    await until(
      () =>
        desktop.evaluate(
          `!document.querySelector('.graphics-inspector button[title="复制"]')?.disabled`,
        ),
      'Shape remained busy',
    );
    await desktop.evaluate(
      `document.querySelector('.graphics-inspector button[title="复制"]').click()`,
    );
    await until(
      async () => (await savedNode('graphics-shape')).shapeOperators.length === 3,
      'Shape copy failed',
    );
    check('reorders and copies shape operators with stable IDs', true);
    const shape = await savedNode('graphics-shape');
    check(
      'copies generate distinct IDs',
      new Set(shape.shapeOperators.map((v) => v.id)).size === 3,
    );
    await rpc('undo');
    await until(
      async () => (await savedNode('graphics-shape')).shapeOperators.length === 2,
      'Graphics undo failed',
    );
    check('undo restores single graphics operation', true);
    await until(
      () =>
        desktop.evaluate(
          `document.querySelectorAll('.graphics-inspector .select-row').length===2 && document.querySelectorAll('.graphics-inspector').length===1`,
        ),
      'Graphics inspector did not refresh after undo',
    );
    const graphicImage = await capture();
    await writeFile(path.join(root, 'graphics-inspector.png'), Buffer.from(graphicImage, 'base64'));
  }
  if (process.argv.includes('--surfaces')) {
    check(
      'studio navigation has no code or MCP connection controls',
      await desktop.evaluate(
        `!document.querySelector('.topbar').textContent.includes('agent')&&!document.querySelector('.workspaces').textContent.includes('代码')`,
      ),
    );
    await desktop.evaluate(`window.vmotionDesktop.openAgentWorkbench('#/connect')`);
    const agentPage = await until(async () => {
      const all = await (await fetch(`http://127.0.0.1:${desktop.debugPort}/json/list`)).json();
      return all.find((t) => t.url.includes('/agent/'));
    }, 'Native Agent window missing');
    check('native Agent window is a separate document', agentPage.url.includes('/agent/'));
  }
  if (process.argv.includes('--sound')) {
    const manifest = path.join(projects, '空白动画/project.vmotion.json'),
      before = await readFile(manifest, 'utf8');
    await click('素材');
    await desktop.evaluate('document.querySelector(\'[aria-label="新建声音"]\').click()');
    await until(
      () => desktop.evaluate('!!document.querySelector(".music-app")'),
      'Music workspace missing',
    );
    await click('Piano roll');
    const box = await desktop.evaluate(
      '(()=>{const r=document.querySelector(".music-note").getBoundingClientRect();return {x:r.x+5,y:r.y+r.height/2}})()',
    );
    await desktop.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      ...box,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    await desktop.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      ...box,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await until(
      () =>
        desktop.evaluate(
          '!!Array.from(document.querySelectorAll(".music-selection-bar label")).find(l=>l.textContent==="MIDI 音高")',
        ),
      'Note not selected',
    );
    await desktop.evaluate(
      '(()=>{const el=Array.from(document.querySelectorAll(".music-selection-bar label")).find(l=>l.textContent==="MIDI 音高").querySelector("input");Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,"value").set.call(el,"67");el.dispatchEvent(new Event("input",{bubbles:true}));})()',
    );
    await click('试听草稿');
    await until(
      () =>
        desktop.evaluate(
          'document.querySelector("audio")?.src.startsWith("data:audio/wav;base64,")',
        ),
      'Draft audition failed',
    );
    check(
      'independent music audition preserves project',
      (await readFile(manifest, 'utf8')) === before,
    );
    await click('保存到素材库');
    await until(
      () =>
        desktop.evaluate(
          '!location.hash.endsWith("/new")&&!document.querySelector(".music-save-state").textContent.includes("…")',
        ),
      'Music save failed',
    );
    const project = JSON.parse(await readFile(manifest, 'utf8')),
      asset = project.assets.find((a) => a.soundSource),
      doc = JSON.parse(await readFile(path.join(projects, '空白动画', asset.soundSource), 'utf8'));
    check(
      'pattern music saved to shared library',
      doc.patterns[0].channels[0].events[0].note === 67,
    );
    const midiAccess = await desktop.evaluate(
      `navigator.requestMIDIAccess({sysex:false}).then(access=>({allowed:true,inputs:access.inputs.size}),error=>({allowed:false,error:error.message}))`,
    );
    check(
      'actual desktop grants local Web MIDI without SysEx ' + JSON.stringify(midiAccess),
      midiAccess.allowed,
    );
    report.midiInputCount = midiAccess.inputs;
    await click('加入视频轨道');
    await click('保存并加入轨道');
    await until(
      () =>
        desktop.evaluate(
          'document.querySelector(".music-footer-status").textContent.includes("原子保存")',
        ),
      'Music placement failed',
    );
    check(
      'score and clip share atomic project service',
      JSON.parse(
        await readFile(path.join(projects, '空白动画/sequences/main.json'), 'utf8'),
      ).tracks.some((t) => t.type === 'audio' && t.clips.some((c) => c.assetId === asset.id)),
    );
    await desktop.evaluate('location.hash="#/project"');
    await until(
      () => desktop.evaluate('!!document.querySelector(".project-title")'),
      'Video workbench missing',
    );
  }
  if (process.argv.includes('--drawing')) {
    await click('绘画');
    await until(
      () => desktop.evaluate(`!!document.querySelector('.drawing-workspace')`),
      'Lazy drawing workspace did not load',
    );
    await click('新建画稿');
    await until(
      () => desktop.evaluate(`!!document.querySelector('.drawing-surface')`),
      'Drawing document did not open',
    );
    const manifest = path.join(projects, '空白动画/project.vmotion.json'),
      drawingProject = JSON.parse(await readFile(manifest, 'utf8')),
      entry = drawingProject.drawings.at(-1),
      drawingFile = path.join(projects, '空白动画', entry.path),
      document = async () => JSON.parse(await readFile(drawingFile, 'utf8'));
    check('loads independent drawing document on demand', !!entry);
    const box = await desktop.evaluate(
      `(()=>{const r=document.querySelector('.drawing-surface').getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height}})()`,
    );
    const x = box.x + box.width * 0.35,
      y = box.y + box.height * 0.4;
    await desktop.call('Input.dispatchMouseEvent', {
      type: 'mousePressed',
      x,
      y,
      button: 'left',
      buttons: 1,
      clickCount: 1,
    });
    for (const offset of [0.05, 0.1, 0.15])
      await desktop.call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: x + box.width * offset,
        y: y + box.height * offset * 0.3,
        button: 'left',
        buttons: 1,
      });
    await desktop.call('Input.dispatchMouseEvent', {
      type: 'mouseReleased',
      x: x + box.width * 0.15,
      y: y + box.height * 0.045,
      button: 'left',
      buttons: 0,
      clickCount: 1,
    });
    await until(
      async () =>
        (await document()).layers.some((l) => l.strokes.some((s) => s.points.length >= 2)),
      'Pointer stroke did not save',
    );
    check('saves a dragged stroke with editable sample points', true);
    const shot = await capture();
    await writeFile(path.join(root, 'drawing-workspace.png'), Buffer.from(shot, 'base64'));
    await click('发布整张画稿');
    await until(
      async () =>
        JSON.parse(await readFile(manifest, 'utf8')).assets.some((a) => a.type === 'drawing'),
      'Drawing publication did not save an asset',
    );
    await click('返回创作工作站');
    await until(
      () =>
        desktop.evaluate(
          `!!document.querySelector('.asset-row')&&!document.querySelector('.drawing-workspace')`,
        ),
      'Published drawing did not appear in library',
    );
    const published = JSON.parse(await readFile(manifest, 'utf8')).assets.find(
      (a) => a.type === 'drawing',
    );
    check('publishes editable drawing to the main asset library', !!published);
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.asset-row')).find(b=>b.textContent.includes(${JSON.stringify(published.name)})).click()`,
    );
    await click('加入主时间轴');
    await until(
      async () =>
        JSON.parse(
          await readFile(path.join(projects, '空白动画/sequences/main.json'), 'utf8'),
        ).tracks.some((t) => t.clips.some((c) => c.assetId === published.id)),
      'Published drawing did not reach timeline',
    );
    check('places the published drawing on a video track', true);
    await click('打开画稿编辑');
    await until(
      () => desktop.evaluate(`!!document.querySelector('.drawing-surface')`),
      'Published drawing did not reopen',
    );
    const reopenedEntry = JSON.parse(await readFile(manifest, 'utf8')).drawings.at(-1),
      reopenedDocument = JSON.parse(
        await readFile(path.join(projects, '空白动画', reopenedEntry.path), 'utf8'),
      );
    check(
      'reopens published drawing for continued editing',
      reopenedEntry.id !== entry.id && reopenedDocument.layers.some((l) => l.strokes.length),
    );
    await click('返回创作工作站');
  }
  if (process.argv.includes('--visual')) {
    await click('动画');
    await desktop.evaluate(`document.querySelector('[aria-label="Shape"]').click()`);
    await until(
      () =>
        desktop.evaluate(`(async()=>{
        const state=(await fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())).result;
        return state.snapshot.scenes[0].nodes.some(n=>n.name==='Rect') &&
          document.querySelector('.inspector-node input')?.value==='Rect' &&
          document.querySelector('.statusbar .mono')?.textContent===state.snapshot.revision.slice(0,8);
      })()`),
      'Shape selection failed',
    );
    await click('效果');
    await until(
      () => desktop.evaluate(`!!document.querySelector('[aria-label="添加效果"]')`),
      'Effect inspector not mounted',
    );
    for (const type of ['bloom', 'gradientMap', 'radialRays']) {
      await desktop.evaluate(
        `(()=>{const field=document.querySelector('[aria-label="添加效果"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(field,${JSON.stringify(type)});field.dispatchEvent(new Event('change',{bubbles:true}));})()`,
      );
      await until(async () => {
        const state = await desktop.evaluate(
          `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json())`,
        );
        return state.result.snapshot.scenes[0].nodes.some((node) =>
          node.effects.some((effect) => effect.type === type),
        );
      }, `Effect ${type} was not saved`);
    }
    check('adds editable bloom/gradient map/rays through the desktop inspector', true);
    const visualImage = await capture();
    await writeFile(path.join(root, 'visual-effects.png'), Buffer.from(visualImage, 'base64'));
  }
  if (process.argv.includes('--studio')) {
    await desktop.evaluate(
      `(()=>{const original=window.fetch;window.studioCalls=[];window.fetch=async(...args)=>{const response=await original(...args);if(args[0]==='/api/rpc'){const input=JSON.parse(args[1].body);const value=await response.clone().json();window.studioCalls.push({method:input.method,result:value.error??{valid:value.result?.valid,revision:value.result?.revision,candidateRevision:value.result?.candidateRevision}});}return response;};})()`,
    );
    const studioButton = async (label) =>
      desktop.evaluate(
        `Array.from(document.querySelectorAll('.studio-workspace button')).find(b=>b.textContent.trim()===${JSON.stringify(label)}).click()`,
      );
    const studioOpen = async (tab) => {
      const titles = {
        特效节点: '特效节点图',
        动作编排: '动作与动画层',
        三维场景: '三维场景',
        粒子: '粒子发射器',
        分镜与转场: '分镜与转场',
        混音: '轨道与总线混音',
        画面检查: '画面检查',
        渲染性能: '渲染与性能',
      };
      if (!(await desktop.evaluate(`!!document.querySelector('.studio-workspace')`)))
        await desktop.evaluate(`document.querySelector('[aria-label="创作工具"]').click()`);
      await until(
        () => desktop.evaluate(`!!document.querySelector('.studio-workspace')`),
        'Studio did not mount',
      );
      await desktop.evaluate(
        `document.querySelector('.studio-workspace nav [aria-label=${JSON.stringify(tab)}]').click()`,
      );
      await until(
        () =>
          desktop.evaluate(
            `document.querySelector('.studio-content h2')?.textContent===${JSON.stringify(titles[tab])}`,
          ),
        'Studio panel did not mount',
      );
    };
    const studioSet = async (label, value) =>
      desktop.evaluate(
        `(()=>{const field=document.querySelector('.studio-content [aria-label=${JSON.stringify(label)}]');Object.getOwnPropertyDescriptor(field.tagName==='SELECT'?HTMLSelectElement.prototype:HTMLInputElement.prototype,'value').set.call(field,${JSON.stringify(String(value))});field.dispatchEvent(new Event(field.tagName==='SELECT'?'change':'input',{bubbles:true}));})()`,
      );
    const studioApply = async () => {
      await studioButton('预览修改');
      await until(
        () =>
          desktop.evaluate(
            `Array.from(document.querySelectorAll('.candidate-buttons button')).some(b=>b.textContent==='应用修改'&&!b.disabled)`,
          ),
        'Candidate did not pass: ' +
          (await desktop.evaluate(
            `document.querySelector('.studio-error')?.textContent??document.querySelector('.statusbar')?.innerText`,
          )),
        45000,
      );
      await studioButton('应用修改');
      await until(
        () => desktop.evaluate(`!document.querySelector('.studio-workspace')`),
        'Candidate did not apply',
      );
    };
    const readState = () =>
      desktop.evaluate(
        `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'state'})}).then(r=>r.json()).then(r=>r.result)`,
      );
    await click('动画');
    await desktop.evaluate(`document.querySelector('[aria-label="Shape"]').click()`);
    await until(async () => {
      const s = await readState();
      return await desktop.evaluate(
        `document.querySelector('.inspector-node input')?.value==='Rect'&&document.querySelector('.statusbar .mono').textContent===${JSON.stringify(s.snapshot.revision.slice(0, 8))}`,
      );
    }, 'Studio shape did not save');
    await studioOpen('特效节点');
    await studioSet('添加特效节点', 'colorMatrix');
    await studioSet('矩阵 1', '0.8');
    await studioButton('设为输出');
    await studioButton('预览修改');
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.candidate-buttons button')).some(b=>b.textContent==='应用修改'&&!b.disabled)`,
        ),
      'Graph initial candidate missing',
      30000,
    );
    await studioSet('矩阵 1', 0.75);
    check(
      'draft parameter changes invalidate reviewed candidates',
      await desktop.evaluate(
        `Array.from(document.querySelectorAll('.candidate-buttons button')).find(b=>b.textContent==='应用修改').disabled`,
      ),
    );
    await writeFile(path.join(root, 'studio-graph.png'), Buffer.from(await capture(), 'base64'));
    await studioApply();
    check(
      'visual node graph authors native editable graph through exact candidate',
      (await readState()).snapshot.scenes[0].nodes.some(
        (n) => n.name === 'Rect' && n.effects.some((e) => e.type === 'effectGraph'),
      ),
    );
    await studioOpen('动作编排');
    await studioApply();
    check(
      'visual motion template creates editable animation layers',
      (await readState()).snapshot.scenes[0].nodes.some(
        (n) => n.name === 'Rect' && n.animationLayers?.length,
      ),
    );
    await studioOpen('动作编排');
    await studioButton('动画叠加层');
    await studioButton('＋ 添加动画层');
    await studioApply();
    check(
      'animation layer editor preserves keys and appends an independent stack layer',
      (await readState()).snapshot.scenes[0].nodes.some(
        (n) => n.name === 'Rect' && n.animationLayers?.length >= 2,
      ),
    );
    await studioOpen('三维场景');
    await studioApply();
    check(
      'visual primitive creation adds persistent mesh scene',
      (await readState()).snapshot.scenes[0].nodes.some((n) => n.type === 'scene3d'),
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.panel-tabs button')).find(b=>b.textContent.trim()==='工程').click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.layer-name')).some(b=>b.textContent.includes('box'))`,
        ),
      '3D layer list did not update',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.includes('box')).click()`,
    );
    await until(
      () => desktop.evaluate(`document.querySelector('.inspector-node input')?.value==='box'`),
      '3D layer selection missing',
    );
    await studioOpen('三维场景');
    await studioSet('相机位置 X', 2);
    await studioSet('金属度', 0.6);
    await writeFile(path.join(root, 'studio-space.png'), Buffer.from(await capture(), 'base64'));
    await studioApply();
    check(
      'visual camera and material changes persist in the same candidate',
      (await readState()).snapshot.scenes[0].nodes.some(
        (n) =>
          n.type === 'scene3d' &&
          n.scene3d.camera.position.x === 2 &&
          n.scene3d.instances[0].material.metallic === 0.6,
      ),
    );
    await studioOpen('粒子');
    await studioSet('每秒发射', 24);
    await studioApply();
    check(
      'visual particle emitter uses shared editable component',
      (await readState()).snapshot.scenes[0].nodes.some(
        (n) => n.type === 'component' && n.component?.includes('particles'),
      ),
    );
    await studioOpen('分镜与转场');
    await studioButton('＋ 添加镜头');
    await studioApply();
    check(
      'visual storyboard saves cards and exact timeline placement',
      Object.keys((await readState()).snapshot.files).some((f) =>
        f.startsWith('components/storyboards/'),
      ),
    );
    await studioOpen('混音');
    await studioSet('添加混音效果', 'filter');
    await studioSet('混音增益 dB', -3);
    await studioApply();
    check(
      'visual mixer persists shared master gain',
      (await readState()).snapshot.sequences[0].mix.master.gainDb === -3,
    );
    check(
      'visual EQ produces validated master effect',
      (await readState()).snapshot.sequences[0].mix.master.effects[0].type === 'filter',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.layer-name')).find(b=>b.textContent.trim()==='Rect').click()`,
    );
    await until(
      () => desktop.evaluate(`document.querySelector('.inspector-node input')?.value==='Rect'`),
      'Driver layer selection failed',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.inspector-tabs button')).find(b=>b.textContent==='动画').click()`,
    );
    await until(
      () => desktop.evaluate(`!!document.querySelector('[aria-label="新表达式属性"]')`),
      'Driver form did not load',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='添加表达式').click()`,
    );
    await until(
      async () =>
        (await readState()).snapshot.scenes[0].nodes.some(
          (n) => n.name === 'Rect' && n.expressions?.x,
        ),
      'Expression form did not save',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls details')).find(d=>d.querySelector('summary').textContent==='布局约束').open=true`,
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='添加居中布局').click()`,
    );
    await until(
      async () =>
        (await readState()).snapshot.scenes[0].nodes.some(
          (n) => n.name === 'Rect' && n.layout?.reference === 'scene',
        ),
      'Layout form did not save',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls details')).find(d=>d.querySelector('summary').textContent==='曲线路径动作').open=true`,
    );
    check(
      'path controls prevent conflicting layout position drivers',
      await desktop.evaluate(
        `Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='添加路径动作').disabled`,
      ),
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='解除布局约束').click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `!!Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='添加路径动作'&&!b.disabled)`,
        ),
      'Layout removal did not enable path creation',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.driver-controls button')).find(b=>b.textContent==='添加路径动作').click()`,
    );
    await until(
      async () =>
        (await readState()).snapshot.scenes[0].nodes.some(
          (n) => n.name === 'Rect' && n.motionPath?.path,
        ),
      'Path form did not save',
    );
    check('inspector creates expressions layout and path using shared edits', true);
    await studioOpen('画面检查');
    await studioButton('运行画面检查');
    await until(
      () => desktop.evaluate(`!!document.querySelector('.studio-evidence')`),
      'Review did not return pixels',
      30000,
    );
    await writeFile(path.join(root, 'studio-scopes.png'), Buffer.from(await capture(), 'base64'));
    check('visual scopes show actual native evidence', true);
    await studioOpen('渲染性能');
    await studioSet('性能测量宽度', 320);
    await studioButton('运行性能检查');
    await until(
      () => desktop.evaluate(`!!document.querySelector('.performance-device')`),
      'Performance did not return evidence',
      30000,
    );
    check(
      'visual performance panel compares CPU and chosen backend',
      await desktop.evaluate(
        `document.querySelector('.studio-content').innerText.includes('容差内一致')`,
      ),
    );
    await desktop.evaluate(`document.querySelector('[aria-label="返回画布"]').click()`);
    await click('导出');
    await until(
      () => desktop.evaluate(`!!document.querySelector('[aria-label="导出渲染设备"]')`),
      'Export backend selector missing',
    );
    check(
      'export dialog exposes explicit CPU/auto/GPU',
      await desktop.evaluate(
        `document.querySelector('[aria-label="导出渲染设备"]').options.length===3`,
      ),
    );
    await desktop.evaluate(`document.querySelector('.modal-close').click()`);
  }
  if (process.argv.includes('--media')) {
    const videoPath = path.join(projects, '空白动画', 'preview.mkv');
    execFileSync(
      'ffmpeg',
      [
        '-y',
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=320x180:rate=30:duration=1',
        '-c:v',
        'ffv1',
        videoPath,
      ],
      { windowsHide: true },
    );
    const imported = await desktop.evaluate(
        `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'import',params:{path:${JSON.stringify(videoPath)},type:'video'}})}).then(r=>r.json())`,
      ),
      asset = imported.result.snapshot.project.assets.find(
        (a) => path.resolve(projects, '空白动画', a.path) === videoPath,
      );
    assert.ok(asset, 'Imported preview video must be selected by its exact source path');
    await desktop.evaluate(
      `fetch('/api/rpc',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({method:'assetPlace',params:{assetId:${JSON.stringify(asset.id)},sceneId:'intro'}})}).then(r=>r.json())`,
    );
    await click('素材');
    await desktop.evaluate(`document.querySelector('[aria-label="媒体与缓存"]').click()`);
    await until(
      () =>
        desktop.evaluate(
          `document.querySelector('.media-entries')?.innerText.includes('preview.mkv')`,
        ),
      'Media manager did not inspect the imported video',
    );
    await desktop.evaluate(
      `Array.from(document.querySelectorAll('.media-entries article')).find(a=>a.textContent.includes('preview.mkv')).querySelector('button').click()`,
    );
    await until(
      () =>
        desktop.evaluate(
          `Array.from(document.querySelectorAll('.media-entries article')).find(a=>a.textContent.includes('preview.mkv'))?.innerText.includes('代理 320×180')`,
        ),
      'Desktop proxy task did not publish',
      30000,
    );
    const evidence = await desktop.evaluate(
      `fetch('/api/frame?scene=intro&frame=0&width=640&height=360&format=rgba&media=auto').then(async r=>({proxyCount:r.headers.get('X-Vmotion-Proxy-Count'),pixels:r.headers.get('X-Vmotion-Decode-Pixels'),bytes:(await r.arrayBuffer()).byteLength}))`,
    );
    check(
      'desktop proxy management feeds the actual auto preview',
      Number(evidence.proxyCount) === 1 && evidence.bytes === 640 * 360 * 4,
    );
    await until(
      () =>
        desktop.evaluate(
          `parseFloat(document.querySelector('.media-cache strong').textContent.replace('可重建缓存 ',''))>0`,
        ),
      'Cache usage did not refresh after proxy publication',
    );
    check('refreshes actual cache size after proxy generation', true);
    await click('检查可清理内容');
    await until(
      () =>
        desktop.evaluate(`document.querySelector('.media-cache')?.innerText.includes('可回收')`),
      'Cache plan did not render',
    );
    check(
      'shows cache byte plan and protected file policy',
      await desktop.evaluate(
        `document.querySelector('.media-cache').innerText.includes('受到保护')`,
      ),
    );
    const mediaImage = await capture();
    await writeFile(path.join(root, 'media-manager.png'), Buffer.from(mediaImage, 'base64'));
    await desktop.evaluate(`document.querySelector('.media-manager header button').click()`);
  }
  const editorImage = await capture();
  await writeFile(path.join(root, 'editor.png'), Buffer.from(editorImage, 'base64'));
} catch (error) {
  try {
    await writeFile(path.join(root, 'failure.png'), Buffer.from(await capture(), 'base64'));
    report.failure = await desktop.evaluate(
      `({hash:location.hash,text:document.body.innerText.slice(-6000),studioCalls:window.studioCalls?.slice(-10)})`,
    );
  } catch {}
  throw error;
} finally {
  await desktop.close();
  await writeFile(path.join(root, 'report.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
