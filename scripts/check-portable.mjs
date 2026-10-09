import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
await mkdir('artifacts', { recursive: true });
const test = await mkdtemp(path.resolve('artifacts/portable-')),
  moved = path.join(test, '新电脑 可复制/Vmotion'),
  project = path.join(test, '新电脑 可复制/视频工程');
await cp(path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'), moved, {
  recursive: true,
  filter: (file) => path.basename(file) !== 'profile',
});
const env = Object.fromEntries(
  Object.entries(process.env).filter(
    ([key, value]) =>
      typeof value === 'string' &&
      !/^(?:VMOTION_|ESBUILD_BINARY_PATH|NODE_PATH|NODE_OPTIONS|ELECTRON_|PATH$)/i.test(key),
  ),
);
env.Path = path.join(process.env.SystemRoot ?? 'C:/Windows', 'System32');
env.ELECTRON_RUN_AS_NODE = '1';
const exe = path.join(moved, 'Vmotion.exe'),
  cli = path.join(moved, 'resources/app/dist/cli/index.mjs'),
  ffmpeg = path.join(moved, 'resources/runtime/media/bin/ffmpeg.exe'),
  ffprobe = path.join(moved, 'resources/runtime/media/bin/ffprobe.exe');
const report = { test, moved, project, isolatedPath: env.Path, checks: [] };
const run = (args) =>
  JSON.parse(
    execFileSync(exe, [cli, ...args], {
      env,
      cwd: test,
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
    }),
  );
run([
  'init',
  '--project',
  project,
  '--template',
  'blank',
  '--width',
  '640',
  '--height',
  '360',
  '--duration',
  '2',
]);
await stat(ffmpeg);
await stat(ffprobe);
const manifest = JSON.parse(
  await readFile(path.join(moved, 'resources/runtime/manifest.json'), 'utf8'),
);
assert.ok(!/--enable-(gpl|nonfree)(?:\s|$)/.test(manifest.configuration));
assert.ok(
  execFileSync(ffmpeg, ['-version'], {
    env,
    cwd: test,
    windowsHide: true,
    encoding: 'utf8',
  }).includes('8.1.3'),
);
const footage = path.join(project, 'source.mkv'),
  audio = path.join(project, 'tone.wav');
execFileSync(
  ffmpeg,
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'testsrc2=size=320x180:rate=30:duration=2',
    '-c:v',
    'ffv1',
    footage,
  ],
  { env, cwd: test, windowsHide: true },
);
execFileSync(
  ffmpeg,
  [
    '-y',
    '-v',
    'error',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:duration=2',
    '-c:a',
    'pcm_s16le',
    audio,
  ],
  { env, cwd: test, windowsHide: true },
);
const client = new Client({ name: 'portable-clean-machine', version: '1.0' }),
  transport = new StdioClientTransport({
    command: exe,
    args: [cli, 'mcp', '--project', project],
    env,
    cwd: test,
    stderr: 'pipe',
  }),
  parse = (r) => JSON.parse(r.content.find((c) => c.type === 'text').text);
async function call(name, args = {}) {
  const result = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.notEqual(result.isError, true, JSON.stringify(parse(result)));
  return { result, value: parse(result) };
}
async function wait(id) {
  for (let i = 0; i < 500; i++) {
    const job = (await call('render_status', { id })).value;
    if (['completed', 'failed', 'cancelled'].includes(job.status)) {
      assert.equal(job.status, 'completed', job.error);
      return job;
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw Error('Portable render timeout');
}
try {
  await client.connect(transport);
  assert.equal((await client.listTools()).tools.length, 10);
  const source =
    "import{defineComponent,node,measureTextBlock}from'@vmotion/sdk';export default defineComponent({name:'Portable',parameters:{},render(ctx){const text='复制到新电脑，也能制作中文动画';const measured=measureTextBlock(text,{fontFamily:'Vmotion Sans',fontSize:28,width:580});return[node({id:'label',type:'text',fontFamily:'Vmotion Sans',text,x:30,y:32,width:580,height:measured.height+4,fontSize:28,fill:'#77d4bd'}),node({id:'box',type:'rect',x:40+ctx.frame,y:230,width:80,height:40,fill:'#8da8ef'})]}});";
  const before = (await call('project_context')).value.revision;
  await call('project_transact', {
    revision: before,
    operations: [
      { type: 'writeSource', path: 'components/portable.ts', content: source },
      {
        type: 'addAsset',
        asset: {
          id: 'footage',
          type: 'video',
          name: '素材',
          path: 'source.mkv',
          managed: false,
          metadata: { duration: 2, width: 320, height: 180 },
        },
      },
      {
        type: 'addAsset',
        asset: {
          id: 'audio',
          type: 'audio',
          name: '声音',
          path: 'tone.wav',
          managed: false,
          metadata: { duration: 2 },
        },
      },
      {
        type: 'updateScene',
        sceneId: 'intro',
        patch: {
          nodes: [
            {
              id: 'film',
              type: 'video',
              assetId: 'footage',
              width: 640,
              height: 360,
              opacity: 0.2,
            },
            {
              id: 'code',
              type: 'component',
              component: 'components/portable.ts',
              width: 640,
              height: 360,
            },
          ],
        },
      },
      {
        type: 'addClip',
        sequenceId: 'main',
        trackId: 'voice',
        clip: {
          id: 'sound',
          assetId: 'audio',
          start: 0,
          duration: 60,
          sourceIn: 0,
          speed: 1,
          volume: 0.5,
          fadeIn: 0,
          fadeOut: 0,
        },
      },
    ],
  });
  const revision = (await call('project_context')).value.revision;
  const preview = await call('frame_capture', {
    frame: 59,
    width: 640,
    height: 360,
    output: path.join(project, 'exports/preview.png'),
  });
  assert.equal(preview.result.content.filter((c) => c.type === 'image').length, 1);
  const png = (
    await call('render_start', {
      revision,
      format: 'png',
      start: 59,
      end: 60,
      width: 640,
      height: 360,
      gpu: 'cpu',
      output: path.join(project, 'exports/parity'),
    })
  ).value;
  await wait(png.id);
  assert.ok(
    (await readFile(preview.value.output)).equals(
      await readFile(path.join(project, 'exports/parity/frame-00000059.png')),
    ),
  );
  const movie = (
    await call('render_start', {
      revision,
      format: 'mp4',
      gpu: 'cpu',
      width: 640,
      height: 360,
      output: path.join(project, 'exports/portable.mp4'),
    })
  ).value;
  await wait(movie.id);
  const probe = JSON.parse(
    execFileSync(
      ffprobe,
      ['-v', 'error', '-show_streams', '-of', 'json', path.join(project, 'exports/portable.mp4')],
      { env, cwd: test, encoding: 'utf8', windowsHide: true },
    ),
  );
  assert.ok(probe.streams.some((s) => s.codec_type === 'audio'));
  assert.equal(Number(probe.streams.find((s) => s.codec_type === 'video').nb_frames), 60);
  const request = path.join(project, 'inspect.json');
  await writeFile(request, JSON.stringify({ frames: [30], width: 320, gpu: 'cpu' }));
  const profile = run(['render-profile', '--project', project, '--request', request]);
  assert.ok(profile.frames[0].pixelHash);
  await call('project_undo');
  assert.equal((await call('project_context')).value.revision, before);
  await call('project_redo');
  assert.equal((await call('project_context')).value.revision, revision);
  report.checks = [
    'copied into Chinese/space directory with PATH limited to Windows System32',
    'no Node/Rust/FFmpeg/esbuild settings; bundled compiler builds TypeScript + SDK',
    'LGPL shared media binaries with matching source/font licenses',
    'portable Chinese Vmotion Sans measurement/rendering in isolated workers',
    'real stdio MCP 10 entries and source/asset/audio editing',
    'original video last-frame decode; exact native preview/export PNG',
    '60-frame H264/AAC video through bundled FFmpeg/FFprobe',
    'CLI current-service bridge; shared undo and redo',
  ];
  report.output = path.join(project, 'exports/portable.mp4');
  report.passed = true;
} catch (error) {
  report.error = error.stack;
  process.exitCode = 1;
} finally {
  await client.close();
  await transport.close();
  await writeFile(path.join(test, 'report.json'), JSON.stringify(report, null, 2));
}
console.log(JSON.stringify(report));
