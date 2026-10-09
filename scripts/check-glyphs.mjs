// Real external stdio MCP check for glyphs_inspect / glyphs_plan (radical-composed glyph sets).
//   node scripts/check-stills.mjs            (built dist/cli/index.mjs)
//   node scripts/check-stills.mjs --dev      (src via tsx, no build needed)
//   node scripts/check-stills.mjs --packaged (release/Vmotion)
// Chinese glyphs need a runtime with CJK fonts; set VMOTION_RUNTIME when the default has none.
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const packaged = process.argv.includes('--packaged'),
  dev = process.argv.includes('--dev'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cliArgs = packaged
    ? [path.join(packageRoot, 'resources/app/dist/cli/index.mjs')]
    : dev
      ? [path.resolve('node_modules/tsx/dist/cli.mjs'), path.resolve('src/cli/index.ts')]
      : [path.resolve('dist/cli/index.mjs')],
  env = {
    ...Object.fromEntries(Object.entries(process.env).filter(([, v]) => typeof v === 'string')),
    ...(packaged
      ? {
          ELECTRON_RUN_AS_NODE: '1',
          ESBUILD_BINARY_PATH: path.join(packageRoot, 'resources/compiler/esbuild.exe'),
        }
      : {}),
  };
await mkdir('artifacts', { recursive: true });
const root = await mkdtemp(path.resolve('artifacts/glyphs-'));
execFileSync(executable, [...cliArgs, 'init', '--project', root, '--name', '字形实验', '--kind', 'still', '--preset', 'video-cover-1080', '--still-template', 'blank'], { env, windowsHide: true });
const client = new Client({ name: 'real-glyph-agent', version: '1.0.0' }),
  transport = new StdioClientTransport({
    command: executable,
    args: [...cliArgs, 'mcp', '--project', root],
    env,
    stderr: 'pipe',
  }),
  report = { root, packaged, dev, checks: [], bytes: {}, images: {} },
  parse = (r) =>
    r.structuredContent?.error ??
    r.structuredContent ??
    JSON.parse(r.content.find((c) => c.type === 'text').text),
  bytes = (v) => Buffer.byteLength(JSON.stringify(v)),
  direct = new Set(['tools_search', 'tool_schema', 'tools_load']);
async function call(name, args = {}) {
  const r = await client.callTool(
    direct.has(name)
      ? { name, arguments: args }
      : { name: 'tool_call', arguments: { name, arguments: args } },
  );
  if (r.isError) throw new Error(name + ':' + JSON.stringify(parse(r)));
  return { value: parse(r), raw: r };
}
const rev = async () => (await call('project_context')).value.revision;
async function commit(plan) {
  const checked = await call('project_preflight', plan.candidate);
  assert.equal(checked.value.valid, true, JSON.stringify(checked.value.diagnostics));
  await call('project_apply', plan.apply);
  assert.equal(await rev(), plan.candidateRevision);
}
async function invalid(name, args, code) {
  const before = await rev();
  const r = await client.callTool({ name: 'tool_call', arguments: { name, arguments: args } });
  assert.equal(r.isError, true, name + ' should fail');
  assert.equal(parse(r).code, code, JSON.stringify(parse(r)));
  assert.equal(await rev(), before, 'failed request must not change the project');
}
/** Width/height/DPI straight from the PNG header and pHYs chunk. */
async function pngInfo(file) {
  const b = await readFile(file);
  assert.equal(b.toString('latin1', 1, 4), 'PNG');
  const info = { width: b.readUInt32BE(16), height: b.readUInt32BE(20), colorType: b[25] };
  for (let o = 8; o < b.length;) {
    const len = b.readUInt32BE(o),
      type = b.toString('latin1', o + 4, o + 8);
    if (type === 'pHYs' && b[o + 16] === 1) info.dpi = Math.round(b.readUInt32BE(o + 8) * 0.0254);
    if (type === 'IDAT') break;
    o += 12 + len;
  }
  return info;
}
const check = (name) => {
  report.checks.push(name);
  console.log('ok -', name);
};
const media = (r) => r.content.filter((c) => c.type === 'image');
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 10);
  assert.ok(!listed.tools.some((t) => t.name.startsWith('glyphs_')));
  check('compact catalog keeps 10 entries; glyph tools are discovered on demand');

  const search = (await call('tools_search', { query: '偏旁 部件 拼字', category: 'glyphs', limit: 5 })).value;
  const names = (search.items ?? search.tools ?? []).map((i) => i.name);
  assert.deepEqual(names.sort(), ['glyphs_inspect', 'glyphs_plan']);
  const schema = (await call('tool_schema', { name: 'glyphs_plan' })).value;
  report.bytes.planSchema = bytes(schema);
  assert.equal((await call('tool_schema', { name: 'glyphs_plan', ifHash: schema.schemaHash })).value.notModified, true);
  const guide = (await call('agent_guide', { topic: 'glyphs' })).value;
  assert.ok(guide.workflow.tools.includes('glyphs_plan'));
  check('tools_search category=glyphs finds both tools; tool_schema ifHash; agent_guide topic=glyphs');

  const listedSets = (await call('glyphs_inspect', {})).value;
  report.bytes.inspect = bytes(listedSets);
  assert.ok(listedSets.sets.some((s) => s.id === 'builtin:demo' && s.glyphs > 300 && s.components > 80));
  const preview = await call('glyphs_inspect', { set: 'builtin:demo', expression: '⿰氵⿱木口', preview: '明月照江河', previewSize: 64 });
  assert.equal(preview.value.expression.ok, true);
  assert.equal(media(preview.raw).length, 1, 'preview sheet arrives as one native media block');
  assert.ok(!JSON.stringify(preview.value).includes('base64') && preview.value.data === undefined);
  report.bytes.preview = bytes(preview.value);
  const noMedia = await client.callTool({ name: 'tool_call', arguments: { name: 'glyphs_inspect', arguments: { set: 'builtin:demo', preview: '江' }, media: false } });
  assert.equal(media(noMedia).length, 0);
  check('glyphs_inspect lists builtin:demo; IDS live preview returns a PNG media block, media=false omits it');

  // Title layer using the demo set with font fallback.
  const base = await rev();
  await call('project_transact', {
    revision: base,
    operations: [{ type: 'addNode', sceneId: 'image', node: { id: 'title', type: 'text', text: '明月照江河 Vmotion 龘', x: 80, y: 420, width: 1760, height: 200, fontSize: 120, fill: '#ffffff', align: 'center', glyphSet: 'builtin:demo' } }],
  });
  const coverage = (await call('glyphs_inspect', { project: true })).value.project[0];
  assert.equal(coverage.set, 'builtin:demo');
  assert.ok(coverage.missing.some((m) => m.char === '龘' && m.where.includes('image/title')));
  check('project coverage reports missing 龘 with its layer location');

  await invalid('glyphs_plan', { set: 'demo', actions: [{ action: 'setStyle', style: { slant: 5 } }] }, 'GLYPH_READONLY');
  await invalid('glyphs_plan', { actions: [{ action: 'create', id: 'mine', name: 'x' }, { action: 'setGlyph', char: '龘', glyph: '⿰木' }] }, 'GLYPH_IDS');
  await invalid('glyphs_plan', { revision: 'stale', actions: [{ action: 'create', id: 'mine', name: 'x' }] }, 'REVISION_CONFLICT');
  check('read-only builtin, malformed IDS and stale revision are rejected without changing the project');

  const before = await rev();
  const plan = await call('glyphs_plan', {
    revision: before,
    actions: [
      { action: 'create', id: 'mine', name: '我的部件体', extends: 'builtin:demo', style: { strokeWidth: 96, slant: 6 } },
      { action: 'setGlyph', char: '龘', glyph: '⿰木⿱口口' },
      { action: 'assign', sceneId: 'image', nodeIds: ['title'], glyphSet: 'mine', fallback: 'font' },
    ],
    preview: '龘江',
  });
  assert.equal(media(plan.raw).length, 1);
  report.bytes.plan = bytes(plan.value);
  assert.equal(await rev(), before, 'planning does not modify the project');
  await commit(plan.value);
  const after = (await call('glyphs_inspect', { project: true, set: 'mine' })).value.project[0];
  assert.ok(!after.missing.some((m) => m.char === '龘'));
  const frame = await call('frame_capture', { sceneId: 'image', frame: 0, width: 480 });
  assert.equal(media(frame.raw).length, 1);
  await call('project_undo');
  assert.equal(await rev(), before);
  check('glyphs_plan create+setGlyph+assign: one candidate, preflight/apply, frame capture, one undo');
  report.ok = true;
} finally {
  await client.close().catch(() => {});
  await writeFile(path.join(root, 'glyphs-mcp-report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify({ checks: report.checks.length, bytes: report.bytes, root }, null, 2));
}
