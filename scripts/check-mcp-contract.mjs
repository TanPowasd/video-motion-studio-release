// Regression checks for the MCP agent contract, driven by a real external stdio MCP client.
// Each numbered check reproduces one externally reported problem (Claude Code driving Vmotion):
//  1 unified planner return contract   2 compact-mode hidden tools / meta tool_schema
//  3 declared read/plan/write effects   4 node animations + keyframe in project_schema
//  5 scene-wide animation_inspect       6 visual:false/samples:false win over plan samples
//  7 argument errors carry full allowed values / bounds / example
// Usage: node scripts/check-mcp-contract.mjs [--packaged] [--cli path/to/cli/index.mjs]
import { mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const argv = process.argv.slice(2),
  packaged = argv.includes('--packaged'),
  cliIndex = argv.indexOf('--cli'),
  packageRoot = path.resolve('release/Vmotion'),
  executable = packaged ? path.join(packageRoot, 'Vmotion.exe') : process.execPath,
  cli = packaged
    ? path.join(packageRoot, 'resources/app/dist/cli/index.mjs')
    : path.resolve(cliIndex >= 0 ? argv[cliIndex + 1] : 'dist/cli/index.mjs'),
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
const root = await mkdtemp(path.resolve('artifacts/mcp-contract-'));
execFileSync(executable, [cli, 'init', '--project', root, '--template', 'science'], {
  env,
  windowsHide: true,
});
const text = (result) => result.content.find((c) => c.type === 'text')?.text ?? '',
  parse = (result) => {
    const value = text(result);
    try {
      return JSON.parse(value);
    } catch {
      return { raw: value };
    }
  },
  bytes = (value) => Buffer.byteLength(JSON.stringify(value)),
  isHash = (value) => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);

async function connect(extra = []) {
  const client = new Client({ name: 'mcp-contract-check', version: '1.0.0' }),
    transport = new StdioClientTransport({
      command: executable,
      args: [cli, 'mcp', '--project', root, ...extra],
      env,
      stderr: 'pipe',
    });
  await client.connect(transport);
  return client;
}
const client = await connect();
const raw = (name, args = {}) => client.callTool({ name, arguments: args });
async function call(name, args = {}) {
  const result = await raw(name, args);
  if (result.isError) throw new Error(`${name} failed: ${text(result).slice(0, 600)}`);
  return result;
}
const via = (name, args = {}, extra = {}) =>
  call('tool_call', { name, arguments: args, ...extra }).then(parse);
const revision = async () => (await via('project_context', { limit: 1 })).revision;
const preflightPngs = async () => {
  try {
    return (await readdir(path.join(root, '.vmotion/preflight'))).filter((f) => f.endsWith('.png'));
  } catch {
    return [];
  }
};

const results = [];
async function check(id, title, body) {
  const started = Date.now();
  try {
    const evidence = await body();
    results.push({ id, title, pass: true, ms: Date.now() - started, evidence });
  } catch (e) {
    results.push({
      id,
      title,
      pass: false,
      ms: Date.now() - started,
      error: String(e?.message ?? e).slice(0, 900),
    });
  }
}
function expectPlan(value, label) {
  assert.ok(value && typeof value.plan === 'object', `${label}: response has plan object`);
  assert.ok(isHash(value.plan.planId), `${label}: plan.planId is a stored SHA-256 id`);
  assert.ok(isHash(value.plan.candidateRevision), `${label}: plan.candidateRevision`);
  assert.ok(value.plan.summary !== undefined, `${label}: plan.summary`);
  assert.equal(value.committed, false, `${label}: committed=false`);
  assert.equal(value.effect, 'plan', `${label}: effect=plan`);
  assert.match(
    JSON.stringify(value.next ?? ''),
    /project_preflight/,
    `${label}: next names preflight`,
  );
  return value.plan;
}
async function commitPlan(plan, label, extra = {}) {
  const checked = await via(
    'project_preflight',
    { planId: plan.planId, ...extra },
    { media: false },
  );
  assert.equal(
    checked.valid,
    true,
    `${label}: preflight valid ${JSON.stringify(checked.diagnostics ?? '').slice(0, 300)}`,
  );
  const applied = await via('project_apply', { planId: plan.planId, ...extra }, { media: false });
  assert.equal(applied.applied, true, `${label}: applied`);
  assert.equal(
    applied.revision,
    plan.candidateRevision,
    `${label}: applied revision = candidateRevision`,
  );
  assert.equal(applied.committed, true, `${label}: apply reports committed=true`);
  return applied;
}

try {
  const initial = await client.listTools();
  const catalogBytes = bytes(initial);

  await check(
    1,
    'every planner returns plan{planId,candidateRevision,summary}; preflight/apply by planId',
    async () => {
      const evidence = {};
      const still = await via('still_plan', {
        actions: [{ action: 'create', sceneId: 'cover', preset: 'square' }],
      });
      evidence.still_plan = Object.keys(still);
      await commitPlan(expectPlan(still, 'still_plan'), 'still_plan', { visual: false });
      const sequence = await via('sequence_plan', {
        sequenceId: 'main',
        items: [{ source: { type: 'scene', id: 'intro' }, trackId: 'visual', duration: 30 }],
      });
      evidence.sequence_plan = Object.keys(sequence);
      const seqPlan = expectPlan(sequence, 'sequence_plan');
      assert.equal(
        sequence.plan.operations,
        undefined,
        'sequence_plan: no inline plan operations by default',
      );
      assert.ok(
        Array.isArray(sequence.deprecated),
        'sequence_plan: legacy inline fields listed as deprecated',
      );
      const detailed = await via('sequence_plan', {
        sequenceId: 'main',
        detail: true,
        items: [{ source: { type: 'scene', id: 'intro' }, trackId: 'visual', duration: 30 }],
      });
      assert.ok(
        Array.isArray(detailed.plan.operations),
        'sequence_plan detail:true inlines operations',
      );
      await commitPlan(seqPlan, 'sequence_plan', { visual: false });
      const inline = await via('composition_edit_layers', {
        mode: 'plan',
        delivery: 'inline',
        sceneId: 'intro',
        edits: [{ nodeId: 'subtitle', patch: { x: 120 } }],
      });
      await commitPlan(
        expectPlan(inline, 'composition_edit_layers inline'),
        'composition_edit_layers',
        {
          visual: false,
        },
      );
      // More planners with different legacy return shapes, normalized to the same contract.
      const shapes = {
        mesh_generate: { primitive: { kind: 'box' }, place: { sceneId: 'cover' } },
        glyphs_plan: {
          actions: [
            { action: 'create', id: 'contract-set', name: 'Contract', extends: 'builtin:demo' },
          ],
        },
        transition_plan: { items: [{ fromSceneId: 'intro', toSceneId: 'cover', duration: 12 }] },
        motion_plan: {
          revision: await revision(),
          cues: [{ id: 'enter', template: { builtin: 'fadeSlide' }, start: 0, duration: 20 }],
          targets: [{ sceneId: 'intro', nodeId: 'eyebrow' }],
        },
      };
      evidence.extraPlanners = {};
      for (const [name, args] of Object.entries(shapes)) {
        const result = await raw('tool_call', { name, arguments: args, media: false });
        assert.notEqual(result.isError, true, `${name}: ${text(result).slice(0, 400)}`);
        const value = parse(result);
        const plan = expectPlan(value, name);
        const checked = await via(
          'project_preflight',
          { planId: plan.planId, samples: false },
          { media: false },
        );
        assert.equal(
          checked.candidateRevision,
          plan.candidateRevision,
          `${name}: preflight resolves the same candidate`,
        );
        evidence.extraPlanners[name] = { bytes: bytes(value), operations: plan.summary.operations };
      }
      // Audit the registry: every capability declared as a planner must say so in discovery.
      const planners = [];
      for (let offset = 0; offset !== undefined;) {
        const page = parse(await call('tools_search', { limit: 50, offset }));
        planners.push(...page.items.filter((i) => i.effect === 'plan').map((i) => i.name));
        offset = page.nextOffset;
      }
      for (const name of [
        'still_plan',
        'sequence_plan',
        'effects_plan',
        'motion_plan',
        'mesh_generate',
        'glyphs_plan',
        'storyboard_plan',
        'tracking_plan',
      ])
        assert.ok(planners.includes(name), `registry declares ${name} as effect=plan`);
      evidence.planners = planners.length;
      return evidence;
    },
  );

  await check(
    2,
    'compact mode explains tool_call for hidden capabilities; tool_schema covers entry/meta tools',
    async () => {
      const context = parse(await call('project_context', { limit: 1 }));
      assert.ok(context.mcp, 'project_context carries an mcp routing block');
      assert.ok(
        Array.isArray(context.mcp.directTools),
        'mcp.directTools lists loaded direct tools',
      );
      assert.ok(context.mcp.directTools.includes('tool_call'));
      assert.ok(!context.mcp.directTools.includes('still_inspect'));
      assert.match(context.mcp.hidden, /tool_call/);
      const guide = parse(await call('agent_guide', {}));
      assert.ok(guide.mcp?.directTools?.includes('tools_load'), 'agent_guide lists direct tools');
      const evidence = { contextMcpBytes: bytes(context.mcp) };
      // Clients that still send a hidden name get a routing answer, not "Tool X disabled".
      const hidden = await raw('still_inspect', {});
      assert.equal(hidden.isError, true);
      assert.equal(parse(hidden).code, 'TOOL_NOT_LOADED', text(hidden));
      assert.match(parse(hidden).message, /tool_call/);
      for (const name of ['tools_search', 'tool_schema', 'tool_call', 'tools_load']) {
        const schema = parse(await call('tool_schema', { name }));
        assert.equal(schema.name, name, `tool_schema ${name}`);
        assert.ok(schema.inputSchema?.properties, `tool_schema ${name} has properties`);
        assert.equal(schema.effect ? true : false, true, `tool_schema ${name} effect`);
      }
      const missing = await raw('tool_schema', { name: 'no_such_tool' });
      assert.equal(missing.isError, true);
      const message = parse(missing).message ?? '';
      assert.doesNotMatch(message, /Unknown Vmotion tool tools_search/);
      assert.match(message, /no_such_tool/);
      assert.match(message, /tools_search \{/);
      evidence.notFound = message;
      const auto = await connect(['--tools', 'auto']);
      try {
        const before = (await auto.listTools()).tools.length;
        const viaCall = await auto.callTool({
          name: 'tool_call',
          arguments: { name: 'still_inspect', arguments: {} },
        });
        assert.notEqual(viaCall.isError, true);
        const after = (await auto.listTools()).tools.map((t) => t.name);
        assert.ok(
          after.includes('still_inspect'),
          '--tools auto loads a capability after first tool_call',
        );
        evidence.auto = { before, after: after.length };
      } finally {
        await auto.close();
      }
      return evidence;
    },
  );

  await check(
    3,
    'declared effect read|plan|write in search/schema/responses; uniform mode=plan on direct writes',
    async () => {
      const search = parse(await call('tools_search', { query: 'animation_edit', limit: 3 }));
      assert.equal(search.items.find((i) => i.name === 'animation_edit')?.effect, 'write');
      assert.equal(parse(await call('tool_schema', { name: 'still_plan' })).effect, 'plan');
      assert.equal(parse(await call('tool_schema', { name: 'project_context' })).effect, 'read');
      const schema = parse(await call('tool_schema', { name: 'scene_place' }));
      assert.equal(schema.effect, 'write');
      assert.ok(schema.inputSchema.properties.mode, 'scene_place exposes mode apply|plan');
      const base = await revision();
      const planned = await via('animation_edit', {
        mode: 'plan',
        sceneId: 'intro',
        edits: [
          {
            nodeId: 'subtitle',
            actions: [
              {
                type: 'upsert',
                property: 'x',
                keys: [
                  { frame: 0, value: 10 },
                  { frame: 30, value: 200, easing: 'easeOut' },
                ],
              },
            ],
          },
        ],
      });
      const plan = expectPlan(planned, 'animation_edit mode=plan');
      assert.equal(await revision(), base, 'plan mode leaves the project unchanged');
      await commitPlan(plan, 'animation_edit plan');
      const direct = await via('composition_edit_layer', {
        sceneId: 'intro',
        nodeId: 'badge',
        patch: { x: 64 },
      });
      assert.equal(direct.committed, true, 'direct write reports committed=true');
      assert.equal(direct.effect, 'write');
      assert.ok(direct.next, 'direct write names next step');
      return { planBytes: bytes(planned), writeBytes: bytes(direct) };
    },
  );

  await check(4, 'project_schema documents node animations and keyframe format', async () => {
    const node = await via('project_schema', { name: 'node' });
    const keys = Object.keys(node);
    assert.ok(node.properties, 'node schema has a leading property index');
    assert.ok(
      keys.indexOf('properties') < keys.indexOf('schema'),
      'index precedes the large schema',
    );
    assert.ok(node.properties.animations, 'index lists animations');
    assert.ok(node.properties.start, 'index lists start');
    const picked = await via('project_schema', {
      name: 'node',
      properties: ['animations', 'start'],
    });
    assert.ok(bytes(picked) < 8000, 'selected node properties stay small');
    assert.match(JSON.stringify(picked), /easing/);
    const keyframe = await via('project_schema', { name: 'keyframe' });
    for (const field of ['frame', 'value', 'easing', 'bezier'])
      assert.match(JSON.stringify(keyframe.schema), new RegExp(`"${field}"`), `keyframe.${field}`);
    return { nodeBytes: bytes(node), pickedBytes: bytes(picked), keyframeBytes: bytes(keyframe) };
  });

  await check(5, 'animation_inspect without nodeId returns a bounded scene overview', async () => {
    const overview = await via('animation_inspect', { sceneId: 'intro', limit: 2 });
    assert.ok(Array.isArray(overview.nodes), 'overview.nodes');
    assert.ok(overview.nodes.length <= 2, 'bounded by limit');
    const all = await via('animation_inspect', { sceneId: 'intro' });
    const title = all.nodes.find((n) => n.id === 'title');
    assert.ok(title, 'animated node listed');
    assert.ok(title.channels.some((c) => c.property === 'opacity' && c.keyCount > 0));
    assert.ok(Array.isArray(title.frameRange));
    return { overviewBytes: bytes(all), total: all.total };
  });

  await check(
    6,
    'visual:false / samples:false suppress plan sample rendering; preflight dir is bounded',
    async () => {
      const plan = (
        await via('still_plan', {
          actions: [{ action: 'create', sceneId: 'thumb', preset: 'square' }],
        })
      ).plan;
      assert.ok(isHash(plan?.planId), 'still_plan planId');
      const before = (await preflightPngs()).length;
      const quiet = await via('project_preflight', { planId: plan.planId, visual: false });
      assert.equal(quiet.output, undefined, 'visual:false preflight writes no contact sheet');
      assert.equal((await preflightPngs()).length, before, 'visual:false wrote no PNG');
      const off = await via('project_preflight', { planId: plan.planId, samples: false });
      assert.equal(off.output, undefined, 'samples:false preflight writes no contact sheet');
      const applied = await via('project_apply', { planId: plan.planId, visual: false });
      assert.equal(applied.applied, true);
      assert.equal((await preflightPngs()).length, before, 'visual:false apply wrote no PNG');
      const dir = path.join(root, '.vmotion/preflight');
      await mkdir(dir, { recursive: true });
      for (let i = 0; i < 80; i++) await writeFile(path.join(dir, `stale-${i}.png`), 'x');
      await via(
        'project_preflight',
        { samples: [{ sceneId: 'intro', frame: 0 }], width: 160 },
        { media: false },
      );
      const remaining = (await preflightPngs()).length;
      assert.ok(remaining <= 48, `preflight retention bounded (${remaining})`);
      return { remaining };
    },
  );

  await check(
    7,
    'argument errors list full allowed values, bounds and a valid example',
    async () => {
      const limit = await raw('tools_search', { limit: 60 });
      assert.equal(limit.isError, true);
      const limitError = parse(limit);
      assert.match(JSON.stringify(limitError), /"maximum":50/);
      assert.ok(limitError.example, 'limit error has example');
      const category = await raw('tools_search', { category: 'design' });
      const categoryError = parse(category);
      const allowed = categoryError.details?.[0]?.allowed ?? [];
      for (const value of [
        'core',
        'animation',
        'effects',
        'composition',
        'vector',
        'drawing',
        'media',
        'editing',
        'audio',
        '3d',
        'math',
        'render',
        'recovery',
        'image',
        'glyphs',
      ])
        assert.ok(allowed.includes(value), `category allowed lists ${value}`);
      assert.ok(categoryError.example, 'category error has example');
      const easing = await raw('tool_call', {
        name: 'animation_edit',
        arguments: {
          sceneId: 'intro',
          edits: [{ nodeId: 'title', actions: [{ type: 'ease', easing: 'bouncy' }] }],
        },
      });
      const easingError = parse(easing);
      assert.match(JSON.stringify(easingError), /easeInOut/);
      assert.ok(easingError.example, 'tool_call argument error has example');
      return {
        limitBytes: bytes(limitError),
        categoryBytes: bytes(categoryError),
        easingBytes: bytes(easingError),
      };
    },
  );

  const report = {
    root,
    packaged,
    cli,
    catalogTools: initial.tools.length,
    catalogBytes,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    results,
  };
  await writeFile(path.join(root, 'contract-report.json'), JSON.stringify(report, null, 2));
  process.stdout.write(JSON.stringify(report, null, 2) + '\n');
  if (report.failed) process.exitCode = 1;
} finally {
  await client.close();
}
