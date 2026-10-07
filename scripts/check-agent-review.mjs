import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
const packaged = process.argv.includes('--packaged'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve('dist/cli/index.mjs'),
  env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter(([, value]) => typeof value === 'string'),
    ),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/agent-review-'));
execFileSync(
  executable,
  [
    cli,
    'init',
    '--project',
    root,
    '--name',
    'Agent 创作闭环',
    '--width',
    '640',
    '--height',
    '360',
    '--duration',
    '2',
  ],
  { env, windowsHide: true, stdio: 'pipe' },
);
const client = new Client({ name: 'review-e2e', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [cli, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  });
const parse = (result) => JSON.parse(result.content.find((block) => block.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  if (result.isError) throw new Error(`${name}: ${JSON.stringify(parse(result))}`);
  return { value: parse(result), content: result.content };
}
async function waitJob(id) {
  for (let i = 0; i < 200; i++) {
    const job = (await call('render_status', { id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      assert.equal(job.status, 'completed', job.error);
      return job;
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
  throw new Error('Render timeout');
}
const report = { packaged, root, checks: [] };
const source = `import {defineComponent,node} from '@vmotion/sdk';
export default defineComponent({name:'Review example',parameters:{},render(){return [
  node({id:'heading',type:'text',text:'Agent 创作闭环',x:32,y:28,width:560,height:50,fontSize:30,fontWeight:700,fill:'#e8edff'}),
  node({id:'rule',type:'rect',x:32,y:92,width:570,height:2,fill:'#41698e'}),
  node({id:'caption',type:'text',text:'检查画面，定位对象\\n批量修复，预检，再导出',x:40,y:124,width:500,height:12,fontSize:27,fill:'#b9d1fa'}),
  node({id:'aside',type:'text',text:'稳定对象 ID',x:-65,y:286,width:240,height:44,fontSize:23,fill:'#99bdff',animations:[{property:'x',keys:[{frame:0,value:-65,easing:'easeInOut'},{frame:59,value:-45,easing:'linear'}]}]})
]}});`;
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const found = parse(
    await client.callTool({
      name: 'tools_search',
      arguments: { query: '画面 修复', category: 'composition', limit: 3 },
    }),
  );
  assert.ok(found.items.some((item) => item.name === 'visual_repair_plan'));
  await call('project_transact', {
    operations: [
      { type: 'writeSource', path: 'components/review.ts', content: source },
      {
        type: 'addNode',
        sceneId: 'intro',
        node: {
          id: 'review',
          type: 'component',
          component: 'components/review.ts',
          width: 640,
          height: 360,
        },
      },
    ],
  });
  const before = (await call('project_context')).value.revision,
    fileHash = (await call('project_file_read', { path: 'components/review.ts' })).value.hash,
    audit = await call('visual_audit', {
      sceneId: 'intro',
      frames: [0, 30, 59],
      images: true,
      width: 320,
      maxImages: 3,
      output: path.join(root, 'exports/before.png'),
    });
  assert.ok(
    audit.value.findings.some(
      (finding) => finding.code === 'TEXT_TRUNCATED' && finding.locator.nodeId === 'review/caption',
    ),
  );
  assert.ok(audit.content.some((block) => block.type === 'image'));
  const planned = await call('visual_repair_plan', {
    sceneId: 'intro',
    revision: before,
    frame: 30,
    frames: [0, 30, 59],
    targets: [
      { nodeId: 'review/caption', actions: [{ type: 'fitText' }] },
      { nodeId: 'review/aside', actions: [{ type: 'insideCanvas', padding: 20 }] },
    ],
  });
  assert.equal(planned.value.after.summary.errors, 0);
  assert.ok(planned.value.candidate.planId);
  assert.equal((await call('project_context')).value.revision, before);
  const checked = await call('project_preflight', planned.value.candidate);
  assert.equal(checked.value.valid, true);
  assert.ok(checked.content.some((block) => block.type === 'image'));
  const accepted = (await call('project_apply', planned.value.apply)).value.revision;
  assert.equal(accepted, planned.value.candidateRevision);
  assert.equal(
    (await call('project_file_read', { path: 'components/review.ts' })).value.hash,
    fileHash,
  );
  const after = await call('visual_audit', {
    sceneId: 'intro',
    frames: [0, 30, 59],
    images: true,
    width: 320,
    maxImages: 3,
    output: path.join(root, 'exports/after.png'),
  });
  assert.equal(after.value.summary.status, 'clear');
  const stale = await client.callTool({
    name: 'tool_call',
    arguments: {
      name: 'render_start',
      arguments: { output: path.join(root, 'exports/stale.mp4'), revision: before },
    },
  });
  assert.equal(stale.isError, true);
  assert.equal(parse(stale).code, 'REVISION_CONFLICT');
  const preview = await call('frame_capture', { frame: 30, width: 640, height: 360 }),
    png = await call('render_start', {
      output: path.join(root, 'exports/parity'),
      format: 'png',
      start: 30,
      end: 31,
      width: 640,
      height: 360,
      revision: accepted,
    });
  await waitJob(png.value.id);
  const block = preview.content.find((block) => block.type === 'image');
  assert.ok(block);
  assert.deepEqual(
    await readFile(path.join(root, 'exports/parity/frame-00000030.png')),
    Buffer.from(block.data, 'base64'),
  );
  const output = path.join(root, 'exports/agent-review.mp4'),
    render = await call('render_start', { output, revision: accepted });
  assert.equal((await waitJob(render.value.id)).revision, accepted);
  const probe = JSON.parse(
    execFileSync(
      process.env.VMOTION_FFPROBE ?? 'ffprobe',
      ['-v', 'error', '-show_streams', '-show_format', '-of', 'json', output],
      { encoding: 'utf8', windowsHide: true },
    ),
  );
  const video = probe.streams.find((stream) => stream.codec_type === 'video');
  assert.equal(video.width, 640);
  assert.equal(video.height, 360);
  assert.equal(Number(video.nb_frames), 60);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_apply', planned.value.apply);
  report.checks = [
    'compact discovery',
    'revision-bound finding locators',
    'generated batch repair',
    'before/after audit',
    'native preflight pictures',
    'unchanged component source',
    'exact candidate apply',
    'stale export rejection',
    'preview/export PNG parity',
    '60-frame MP4',
    'single undo',
  ];
  report.output = output;
  report.acceptedRevision = accepted;
} finally {
  await client.close();
  await writeFile(path.join(root, 'review-check.json'), JSON.stringify(report, null, 2));
}
process.stdout.write(JSON.stringify(report, null, 2) + '\n');
