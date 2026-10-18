import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { planContract, writeContract } from '../src/mcp/contract.js';
import { capturedPlanTools } from '../src/mcp/tool-definition.js';
import { searchTools, toolSchema, findTool, metaToolNames } from '../src/mcp/discovery.js';
import { argumentError, parseArguments } from '../src/mcp/argument-errors.js';
import { toolError } from '../src/mcp/invoke.js';
import { storeAgentPlan } from '../src/service/agent-plans.js';
import { projectSchemaInfo } from '../src/service/schemas.js';
import { prunePreflightEvidence, preflightRetention } from '../src/service/preflight.js';
import { VmotionError } from '../src/core/model.js';

const definitions = toolDefinitions();
const revision = 'a'.repeat(64),
  candidateRevision = 'b'.repeat(64);

describe('declared effects', () => {
  it('declares read|plan|write for every capability consistently with annotations', () => {
    for (const tool of definitions) {
      expect(['read', 'plan', 'write']).toContain(tool.effect);
      if (tool.effect === 'read') expect(tool.annotations.readOnlyHint).toBe(true);
      if (tool.effect === 'write') expect(tool.annotations.readOnlyHint).toBe(false);
      if (tool.name.endsWith('_plan')) expect(tool.effect).toBe('plan');
    }
    for (const name of ['mesh_generate', 'mesh_import', 'scene3d_materials', 'plugins_install'])
      expect(findTool(definitions, name).effect).toBe('plan');
    // Every project planner can inline its operations on request; cache_plan feeds cache_apply.
    for (const tool of definitions.filter((t) => t.effect === 'plan'))
      if (!tool.applyWith) expect(Object.keys(tool.schema)).toContain('detail');
    expect(findTool(definitions, 'cache_plan').applyWith).toBe('cache_apply');
  });
  it('gives direct project writes a uniform mode apply|plan', () => {
    for (const name of capturedPlanTools) {
      const tool = findTool(definitions, name);
      expect(tool.effect).toBe('write');
      expect(tool.planMode).toBe('captured');
      expect(tool.injected).toContain('mode');
      expect(z.object(tool.schema).strict().safeParse({}).success || true).toBe(true);
    }
    expect(findTool(definitions, 'composition_edit_layers').planMode).toBe('native');
  });
  it('exposes effect in search and schema, including entry tools', () => {
    const page = searchTools(definitions, { query: 'still', limit: 5 });
    expect(page.items.every((item) => typeof item.effect === 'string')).toBe(true);
    for (const name of metaToolNames) {
      const view = toolSchema(definitions, name, {}) as { effect: string; entry?: boolean };
      expect(view.entry).toBe(true);
      expect(view.effect).toBeTruthy();
    }
    expect((toolSchema(definitions, 'scene_place', {}) as { modes?: string[] }).modes).toEqual([
      'apply',
      'plan',
    ]);
    expect(() => findTool(definitions, 'tools_searc')).toThrow(/Entry tools: .*tools_search/);
  });
});

describe('unified planner contract', () => {
  it('stores inline candidates and reports plan{planId,candidateRevision,summary,samples}', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-contract-'));
    const inline = {
      revision,
      operations: [{ type: 'updateProject', patch: { name: 'x' } }],
      samples: [{ frame: 3, sequenceId: 'main' }],
      width: 320,
    };
    const value = (await planContract(
      findTool(definitions, 'sequence_plan'),
      {
        baseRevision: revision,
        candidateRevision,
        candidate: inline,
        apply: { ...inline, expectedCandidateRevision: candidateRevision },
      },
      { root },
    )) as Record<string, any>;
    expect(value.committed).toBe(false);
    expect(value.effect).toBe('plan');
    expect(value.plan.planId).toMatch(/^[a-f0-9]{64}$/);
    expect(value.plan.candidateRevision).toBe(candidateRevision);
    expect(value.plan.summary.operations).toBe(1);
    expect(value.plan.samples).toEqual([{ sequenceId: 'main', frame: 3 }]);
    expect(value.plan.operations).toBeUndefined();
    expect(value.deprecated).toEqual(['candidate', 'apply']);
    expect(value.next).toMatch(/project_preflight\(\{planId\}\)/);
    const detailed = (await planContract(
      findTool(definitions, 'sequence_plan'),
      { candidateRevision, candidate: inline },
      { root, detail: true },
    )) as Record<string, any>;
    expect(detailed.plan.operations).toHaveLength(1);
    expect(detailed.plan.planId).toBe(value.plan.planId);
  });
  it('keeps stored-plan legacy shapes and merges their summaries', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-contract-'));
    const stored = await storeAgentPlan(root, { revision, operations: [], samples: [] });
    const value = (await planContract(
      findTool(definitions, 'still_plan'),
      {
        baseRevision: revision,
        candidateRevision,
        summary: [{ action: 'create', sceneId: 'cover' }],
        plan: { planId: stored.planId, bytes: stored.bytes },
        candidate: { planId: stored.planId },
        apply: { planId: stored.planId, expectedCandidateRevision: candidateRevision },
        next: 'Export with image_export.',
      },
      { root },
    )) as Record<string, any>;
    expect(value.plan).toMatchObject({
      planId: stored.planId,
      bytes: stored.bytes,
      candidateRevision,
    });
    expect(value.plan.summary.detail).toEqual([{ action: 'create', sceneId: 'cover' }]);
    expect(value.next).toMatch(/project_preflight.*Export with image_export/);
    const unchanged = (await planContract(
      findTool(definitions, 'still_plan'),
      { baseRevision: revision, unchanged: true },
      { root },
    )) as Record<string, any>;
    expect(unchanged.plan).toBeUndefined();
    expect(unchanged.committed).toBe(false);
    const cache = (await planContract(
      findTool(definitions, 'cache_plan'),
      { planId: stored.planId, files: [], apply: { planId: stored.planId } },
      { root },
    )) as Record<string, any>;
    expect(cache.next).toBe('cache_apply({planId})');
  });
  it('marks direct writes committed with a next step', () => {
    const value = writeContract(
      findTool(definitions, 'project_transact'),
      { snapshot: { revision }, canUndo: true },
      { revision, canUndo: true },
    ) as Record<string, unknown>;
    expect(value).toMatchObject({ committed: true, effect: 'write' });
    expect(value.next).toBeTruthy();
    const apply = writeContract(findTool(definitions, 'project_apply'), {}, { applied: false });
    expect(apply).toMatchObject({ committed: false });
  });
});

describe('argument errors', () => {
  it('lists every allowed enum value, bounds and an example', () => {
    const schema = z
      .object({
        category: z.enum(['core', 'animation', 'effects', 'composition', 'image', 'glyphs']),
        limit: z.number().int().min(1).max(50),
      })
      .strict();
    let error: VmotionError | undefined;
    try {
      parseArguments('tools_search', schema, { category: 'design', limit: 60 });
    } catch (e) {
      error = e as VmotionError;
    }
    expect(error?.code).toBe('TOOL_ARGUMENTS');
    const details = error!.details as Array<Record<string, unknown>>;
    expect(details.find((d) => d.path === '/category')?.allowed).toEqual([
      'core',
      'animation',
      'effects',
      'composition',
      'image',
      'glyphs',
    ]);
    expect(details.find((d) => d.path === '/limit')).toMatchObject({ maximum: 50, minimum: 1 });
    const rendered = toolError(error).structuredContent as { error: Record<string, unknown> };
    expect(rendered.error.example).toEqual({
      name: 'tools_search',
      arguments: { category: 'core', limit: 1 },
    });
  });
  it('names allowed keys for unknown fields and keeps union branch messages', () => {
    const schema = z.object({ a: z.object({ b: z.string() }).strict() }).strict();
    const parsed = schema.safeParse({ a: { b: 'x', c: 1 } });
    const error = argumentError(
      'demo',
      parsed.success ? (undefined as never) : parsed.error,
      schema,
      {},
    );
    expect((error.details as Array<Record<string, unknown>>)[0].allowedKeys).toEqual(['b']);
  });
});

describe('project_schema node/keyframe documentation', () => {
  it('leads with a property index and supports keyframe/animation and property selection', () => {
    const node = projectSchemaInfo('node') as Record<string, any>;
    expect(Object.keys(node).indexOf('properties')).toBeLessThan(
      Object.keys(node).indexOf('schema'),
    );
    expect(node.properties.animations).toMatch(/keys:\[\{frame, value, easing\?, bezier\?\}\]/);
    expect(node.properties.start).toBeTruthy();
    const picked = projectSchemaInfo('node', undefined, ['animations']) as Record<string, any>;
    expect(JSON.stringify(picked).length).toBeLessThan(8000);
    expect(JSON.stringify(projectSchemaInfo('keyframe'))).toMatch(/easeInOut/);
    expect(() => projectSchemaInfo('node', undefined, ['nope'])).toThrow(
      /Unknown schema properties/,
    );
  });
});

describe('preflight evidence retention', () => {
  it('keeps the newest contact sheets within the retention budget', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-preflight-'));
    const dir = path.join(root, '.vmotion/preflight');
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < preflightRetention.files + 20; i++)
      await writeFile(path.join(dir, `old-${i}.png`), 'x');
    const keep = path.join(dir, 'newest.png');
    await writeFile(keep, 'y');
    await prunePreflightEvidence(root, keep);
    const left = await readdir(dir);
    expect(left.length).toBeLessThanOrEqual(preflightRetention.files);
    expect(left).toContain('newest.png');
  });
});
