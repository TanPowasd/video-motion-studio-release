// Real external stdio MCP check for still_inspect / still_plan / image_export.
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
  packageRoot = path.resolve(process.env.VMOTION_PACKAGE_ROOT ?? 'release/Vmotion'),
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
const root = await mkdtemp(path.resolve('artifacts/stills-'));
execFileSync(
  executable,
  [
    ...cliArgs,
    'init',
    '--project',
    root,
    '--name',
    '秋季海报',
    '--kind',
    'still',
    '--preset',
    'poster-a4',
    '--still-template',
    'poster',
  ],
  { env, windowsHide: true },
);
const client = new Client({ name: 'real-still-agent', version: '1.0.0' }),
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
try {
  await client.connect(transport);
  const listed = await client.listTools();
  assert.equal(listed.tools.length, 10);
  assert.ok(!listed.tools.some((t) => /^(still_|image_export)/.test(t.name)));
  report.bytes.startup = bytes(listed);
  check('compact catalog keeps 10 entries; still tools are discovered on demand');

  const search = (await call('tools_search', { query: '海报', category: 'image', limit: 8 })).value;
  const names = search.items?.map((i) => i.name) ?? search.tools?.map((i) => i.name) ?? [];
  for (const n of ['still_inspect', 'still_plan', 'image_export'])
    assert.ok(names.includes(n), JSON.stringify(names));
  report.bytes.search = bytes(search);
  const schema = (await call('tool_schema', { name: 'image_export' })).value;
  report.bytes.exportSchema = bytes(schema);
  const cached = (await call('tool_schema', { name: 'image_export', ifHash: schema.schemaHash }))
    .value;
  assert.equal(cached.notModified, true);
  report.bytes.exportSchemaCached = bytes(cached);
  const guide = (await call('agent_guide', { topic: 'image' })).value;
  assert.ok(guide.workflow.tools.includes('image_export'));
  report.bytes.guide = bytes(guide);
  check('tools_search category=image finds all three; tool_schema ifHash; agent_guide topic=image');

  const inspected = (await call('still_inspect', {})).value;
  report.bytes.inspect = bytes(inspected);
  assert.equal(inspected.projectKind, 'still');
  const poster = inspected.stills[0];
  assert.equal(poster.width, 2552);
  assert.equal(poster.height, 3580);
  assert.equal(poster.still.bleed, 36);
  assert.equal(poster.still.dpi, 300);
  assert.deepEqual(poster.trim, { x: 36, y: 36, width: 2480, height: 3508 });
  assert.equal(inspected.presetIds.length, 8);
  assert.equal(inspected.budget.maxSide, 8192);
  const full = (await call('still_inspect', { presets: true, templates: true })).value;
  assert.equal(full.presets.length, 8);
  assert.equal(full.templates.length, 4);
  report.bytes.inspectFull = bytes(full);
  check('still_inspect: A4 300dpi poster with 36px bleed, trim 2480x3508, 8 presets/4 templates');

  // Trimmed print PNG at 1x carries 300dpi.
  const printed = (
    await call('image_export', {
      sceneId: poster.sceneId,
      trim: true,
      revision: inspected.revision,
      output: path.join(root, 'exports/poster-a4-trim.png'),
    })
  ).value;
  report.bytes.exportResult = bytes(printed);
  assert.ok(!JSON.stringify(printed).includes('base64'));
  const pi = await pngInfo(printed.images[0].path);
  assert.deepEqual([pi.width, pi.height, pi.dpi], [2480, 3508, 300]);
  report.images.poster = printed.images[0];
  // JPEG at 0.5x with scaled DPI; WebP transparent.
  const jpeg = (
    await call('image_export', { sceneId: poster.sceneId, format: 'jpeg', quality: 80, scale: 0.5 })
  ).value.images[0];
  assert.deepEqual([jpeg.width, jpeg.height, jpeg.dpi], [1276, 1790, 150]);
  const webp = (
    await call('image_export', {
      sceneId: poster.sceneId,
      format: 'webp',
      transparent: true,
      scale: 0.25,
    })
  ).value;
  assert.equal(webp.images[0].transparent, true);
  assert.ok(webp.warnings.some((w) => /DPI/.test(w)));
  check(
    'image_export PNG trim 2480x3508@300dpi, JPEG 0.5x @150dpi, WebP transparent (no DPI warning)',
  );

  // Add a 1080p cover with variants as one exact candidate; export the unapplied plan by planId.
  const base = await rev();
  const create = (
    await call('still_plan', {
      revision: base,
      actions: [
        {
          action: 'create',
          sceneId: 'cover',
          name: '视频封面',
          preset: 'video-cover-1080',
          template: 'cover',
          variants: [
            { id: 'square', name: '方图', width: 1080, height: 1080, fit: 'cover' },
            { id: 'thumb', name: '缩略图', width: 640, height: 360, fit: 'reflow' },
          ],
        },
      ],
    })
  ).value;
  report.bytes.planResult = bytes(create);
  const pinned = (
    await call('image_export', {
      planId: create.candidate.planId,
      sceneId: 'cover',
      variants: 'all',
      scale: 0.5,
    })
  ).value;
  assert.deepEqual(
    pinned.images.map((i) => [i.variant, i.width, i.height]),
    [
      ['main', 960, 540],
      ['square', 540, 540],
      ['thumb', 320, 180],
    ],
  );
  assert.equal(await rev(), base, 'planId export must not apply the candidate');
  check(
    'still_plan create returns exact candidate; image_export planId renders main+cover+reflow variants without applying',
  );

  await commit(create);
  const applied = await rev();
  const coverScene = JSON.parse(
    await readFile(
      path.join(
        root,
        JSON.parse(await readFile(path.join(root, 'project.vmotion.json'), 'utf8')).scenes.find(
          (s) => s.includes('cover'),
        ),
      ),
      'utf8',
    ),
  );
  const ids = coverScene.nodes.slice(0, 2).map((n) => n.id);
  const align = (
    await call('still_plan', {
      revision: applied,
      actions: [
        { action: 'align', sceneId: 'cover', nodeIds: ids, mode: 'left', relativeTo: 'safe' },
      ],
    })
  ).value;
  report.align = { unchanged: !!align.unchanged, summary: align.summary };
  if (!align.unchanged) await commit(align);
  const afterExport = (
    await call('image_export', { sceneId: 'cover', revision: await rev(), scale: 0.5 })
  ).value.images[0];
  assert.deepEqual([afterExport.width, afterExport.height], [960, 540]);
  await call('project_undo', {});
  if (!align.unchanged) {
    assert.equal(await rev(), applied);
    await call('project_undo', {});
  }
  assert.equal(await rev(), base);
  const back = (await call('still_inspect', {})).value;
  assert.ok(!back.stills.some((s) => s.sceneId === 'cover'));
  check('preflight/apply create + align (safe box), revision-pinned export, one undo per plan');

  // Negative requests never touch the project.
  await invalid('image_export', { sceneId: poster.sceneId, scale: 3 }, 'RESOLUTION');
  await invalid(
    'image_export',
    { sceneId: poster.sceneId, revision: 'stale-revision' },
    'REVISION_CONFLICT',
  );
  await invalid(
    'still_plan',
    { revision: 'stale', actions: [{ action: 'create', preset: 'square' }] },
    'REVISION_CONFLICT',
  );
  await invalid('image_export', { sceneId: 'missing' }, 'MISSING_SCENE');
  check(
    'over-budget scale -> RESOLUTION (no downscale), stale revisions and missing scene rejected without mutation',
  );
  report.ok = true;
} finally {
  await client.close().catch(() => {});
  await writeFile('artifacts/stills-mcp.json', JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report.bytes));
}
