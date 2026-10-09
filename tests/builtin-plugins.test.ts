import { it, expect, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { z } from 'zod';
import { BuiltinPluginRegistry } from '../src/plugins/registry.js';
import { builtinPlugins } from '../src/plugins/index.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from '../src/plugins/types.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { toolCategories } from '../src/mcp/discovery.js';
import { inspectAudioTimeline } from '../src/plugins/audio.js';
import { projectSchema, sequenceSchema, type Snapshot } from '../src/core/model.js';
import { sampleAtFrame, audioClips } from '../src/media/audio.js';
import { PluginRegistry } from '../src/core/plugins.js';
import { hash } from '../src/service/project.js';
import { builtinCandidate } from '../src/plugins/candidate.js';
import { resolveAgentPlan } from '../src/service/agent-plans.js';
import { renderPlugin, queryRenderJobs } from '../src/plugins/render.js';
import type { RenderJob, RenderOptions } from '../src/media/export.js';

function module(id = 'vmotion.audio', name = 'probe', method = 'probe'): BuiltinPluginModule {
  return {
    id,
    name: id,
    version: '1.0.0',
    methods: new Set([method]),
    tools: () => [
      {
        name,
        method,
        description: name,
        schema: { n: z.number() },
        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ],
    dispatch: (_host, _method, p) => ({
      owner: id,
      value: z.object({ n: z.number() }).parse(p).n + 1,
    }),
  };
}
it('rejects duplicate builtin ownership, missing handlers and invalid dependencies before dispatch', () => {
  expect(() => new BuiltinPluginRegistry([module(), module()])).toThrow(
    /Duplicate builtin module ID/,
  );
  expect(() => new BuiltinPluginRegistry([module(), module('vmotion.media', 'other')])).toThrow(
    /Duplicate builtin method handler/,
  );
  expect(
    () => new BuiltinPluginRegistry([module(), module('vmotion.media', 'probe', 'other')]),
  ).toThrow(/Duplicate builtin tool name/);
  expect(() => new BuiltinPluginRegistry([{ ...module(), methods: new Set(['missing']) }])).toThrow(
    /handlers must match/,
  );
  expect(() => new BuiltinPluginRegistry([{ ...module(), version: '2.0.0' }])).toThrow(
    /version differs/,
  );
  expect(
    () => new BuiltinPluginRegistry([{ ...module(), dependencies: { 'vmotion.media': '^2.0.0' } }]),
  ).toThrow(/incompatible/);
  expect(
    () =>
      new BuiltinPluginRegistry([
        { ...module(), dependencies: { 'vmotion.media': '*' } },
        { ...module('vmotion.media', 'media', 'media'), dependencies: { 'vmotion.audio': '*' } },
      ]),
  ).toThrow(/dependency cycle/);
  const registry = new BuiltinPluginRegistry([module()]);
  expect(
    () =>
      new BuiltinPluginRegistry([
        {
          ...module(),
          tools: () => [
            { ...module().tools()[0], keywords: undefined } as unknown as ReturnType<
              BuiltinPluginModule['tools']
            >[number],
          ],
        },
      ]),
  ).toThrow(/metadata is incomplete/);
  expect(registry.dispatch({} as BuiltinPluginHost, 'probe', { n: 2 })).toEqual({
    owner: 'vmotion.audio',
    value: 3,
  });
  expect(() => registry.dispatch({} as BuiltinPluginHost, 'missing', {})).toThrow(
    /No builtin module/,
  );
});
it('gives every public builtin tool one matching module handler, preserving categories and ownership', () => {
  const definitions = toolDefinitions();
  expect(new Set(definitions.map((t) => t.name)).size).toBe(definitions.length);
  for (const tool of builtinPlugins.tools) {
    expect(builtinPlugins.hasMethod(tool.method), tool.name).toBe(true);
    expect(builtinPlugins.moduleForTool(tool.name)?.id, tool.name).toBe(tool.plugin?.id);
    expect(definitions.filter((t) => t.name === tool.name)).toHaveLength(1);
    expect(toolCategories(tool.name, tool).length, tool.name).toBeGreaterThan(0);
  }
  const names = (id: string) => definitions.filter((t) => t.plugin?.id === id).map((t) => t.name);
  expect(builtinPlugins.status('vmotion.audio', names('vmotion.audio'))).toMatchObject({
    runtime: 'module',
    moduleTools: 15,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.effects', names('vmotion.effects'))).toMatchObject({
    runtime: 'module',
    moduleTools: 14,
  });
  expect(builtinPlugins.status('vmotion.media', names('vmotion.media'))).toMatchObject({
    runtime: 'module',
    moduleTools: 12,
  });
  expect(builtinPlugins.status('vmotion.render', names('vmotion.render'))).toMatchObject({
    runtime: 'module',
    moduleTools: 8,
  });
  expect(builtinPlugins.status('vmotion.3d', names('vmotion.3d'))).toMatchObject({
    runtime: 'module',
    moduleTools: 5,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.vector', names('vmotion.vector'))).toMatchObject({
    runtime: 'module',
    moduleTools: 8,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.animation', names('vmotion.animation'))).toMatchObject({
    runtime: 'module',
    moduleTools: 14,
  });
  expect(builtinPlugins.status('vmotion.drawing', names('vmotion.drawing'))).toMatchObject({
    runtime: 'module',
    moduleTools: 8,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.composition', names('vmotion.composition'))).toMatchObject({
    runtime: 'module',
    moduleTools: 12,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.tracking', names('vmotion.tracking'))).toMatchObject({
    runtime: 'module',
    moduleTools: 4,
    hostTools: 0,
  });
  expect(builtinPlugins.status('vmotion.editing', names('vmotion.editing'))).toMatchObject({
    runtime: 'module',
    moduleTools: 7,
    hostTools: 0,
  });
  expect(definitions).toHaveLength(builtinPlugins.tools.length);
  expect(new Set(definitions.map((t) => t.plugin!.id)).size).toBe(18);
  for (const id of new Set(definitions.map((t) => t.plugin!.id))) {
    expect(builtinPlugins.status(id, names(id))).toMatchObject({
      runtime: 'module',
      moduleTools: names(id).length,
      hostTools: 0,
    });
  }
});
it('keeps stored and inline builtin candidates identical and rejects replacement of reviewed operations', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-builtin-candidate-'));
  try {
    const input = {
      revision: 'base',
      operations: [{ type: 'updateScene' as const, sceneId: 'intro', patch: { name: 'Reviewed' } }],
      samples: [{ sceneId: 'intro', frame: 12, path: ['card'], contextFrames: [6] }],
      width: 320,
      determinism: true,
      visual: true,
    };
    const inline = await builtinCandidate(root, input, 'next', 'inline', {
        coverage: { omitted: 0 },
      }),
      stored = await builtinCandidate(root, input, 'next', 'stored', { coverage: { omitted: 0 } });
    expect(await resolveAgentPlan(root, stored.candidate)).toEqual(inline.candidate);
    expect(stored.apply.expectedCandidateRevision).toBe(inline.apply.expectedCandidateRevision);
    expect(stored.coverage).toEqual(inline.coverage);
    await expect(
      resolveAgentPlan(root, { ...stored.candidate, operations: [] }),
    ).rejects.toMatchObject({ code: 'AGENT_PLAN_OVERRIDE' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it('blocks render startup on pending/error state while retaining the host task manager', async () => {
  const snapshot = timeline(),
    start = vi.fn((_snapshot: Snapshot, _options: RenderOptions) => ({ id: 'accepted' })),
    host = {
      root: 'project',
      snapshot,
      renders: { start },
      exportState: () => ({ pendingFiles: true, diagnostics: [] }),
    } as unknown as BuiltinPluginHost;
  await expect(renderPlugin.dispatch(host, 'render', {})).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  expect(start).not.toHaveBeenCalled();
  host.exportState = () => ({
    pendingFiles: false,
    diagnostics: [{ code: 'BROKEN', severity: 'error', message: 'broken code' }],
  });
  await expect(renderPlugin.dispatch(host, 'render', {})).rejects.toMatchObject({
    code: 'VALIDATION_FAILED',
  });
  host.exportState = () => ({ pendingFiles: false, diagnostics: [] });
  const params = { revision: snapshot.revision, output: 'export.mp4', end: 30, format: 'mp4' };
  expect(await renderPlugin.dispatch(host, 'render', params)).toEqual({ id: 'accepted' });
  expect(start.mock.calls[0][0]).toBe(snapshot);
  expect(start.mock.calls[0][1]).toMatchObject({
    revision: snapshot.revision,
    end: 30,
    format: 'mp4',
  });
});
it('pages filtered render task summaries and keeps full error/output evidence available explicitly', () => {
  const jobs = new Map<string, RenderJob>(
    Array.from({ length: 100 }, (_, i) => {
      const job: RenderJob = {
        id: 'job-' + i,
        status: i % 2 ? 'completed' : 'failed',
        revision: i % 3 ? 'current' : 'old',
        frame: 60,
        totalFrames: 60,
        progress: 1,
        stage: 'done',
        output: '/project/exports/' + i + '.mp4',
        startedAt: '2026-10-05T00:00:00Z',
        ...(i % 2 ? {} : { error: 'Reported failure ' + 'x'.repeat(600) }),
      };
      return [job.id, job];
    }),
  );
  const page = queryRenderJobs(jobs, {}),
    full = queryRenderJobs(jobs, { limit: 100, detail: true });
  expect(page.items).toHaveLength(20);
  expect(page.nextOffset).toBe(20);
  expect(page.items[0].id).toBe('job-99');
  expect(page.counts.failed).toBe(50);
  const detail = queryRenderJobs(jobs, { ids: ['job-2'], detail: true });
  expect(detail.items[0]).toMatchObject({
    output: '/project/exports/2.mp4',
    error: jobs.get('job-2')!.error,
  });
  const selected = queryRenderJobs(jobs, { statuses: ['failed'], revision: 'current', limit: 100 });
  expect(selected.items.every((job) => job.status === 'failed' && job.revision === 'current')).toBe(
    true,
  );
  expect(queryRenderJobs(jobs, { offset: 20 }).items.map((j) => j.id)).toEqual(
    full.items.slice(20, 40).map((j) => j.id),
  );
  expect(Buffer.byteLength(JSON.stringify(page))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) * 0.1,
  );
  expect(() => queryRenderJobs(jobs, { ids: ['unknown'] })).toThrow(/missing/);
});

function timeline(): Snapshot {
  const project = projectSchema.parse({
    formatVersion: 1,
    id: 'test',
    name: '分页取证',
    width: 320,
    height: 180,
    fps: { num: 30000, den: 1001 },
    activeSequence: 'main',
    scenes: [],
    sequences: ['main.json', 'nested.json'],
    assets: [{ id: 'tone', name: 'tone', path: 'tone.wav', type: 'audio' }],
  });
  const clip = (i: number) => ({
    id: 'clip-' + i,
    assetId: 'tone',
    start: i * 40,
    duration: 30,
    sourceIn: 3.25,
    speed: 0.75,
    volume: 0.5,
    fadeIn: 6,
    fadeOut: 8,
  });
  const nested = sequenceSchema.parse({
    id: 'nested',
    name: 'nested',
    duration: 4000,
    tracks: [
      {
        id: 'voice',
        name: 'voice',
        type: 'audio',
        clips: Array.from({ length: 100 }, (_, i) => clip(i)),
      },
    ],
  });
  const main = sequenceSchema.parse({
    id: 'main',
    name: 'main',
    duration: 4100,
    tracks: [
      {
        id: 'visual',
        name: 'visual',
        type: 'video',
        clips: [
          {
            id: 'nested',
            sequenceId: 'nested',
            start: 20,
            duration: 4000,
            sourceIn: 10,
            speed: 1.25,
            volume: 0.8,
            fadeIn: 15,
            fadeOut: 20,
          },
        ],
      },
      { id: 'muted', name: 'muted', type: 'audio', muted: true, clips: [clip(0)] },
    ],
  });
  return { project, scenes: [], sequences: [main, nested], files: {}, revision: 'test-revision' };
}
it('reuses exact plugin file probes without rehashing content and invalidates changed declared dependencies', () => {
  const snapshot = timeline(),
    file = 'components/plugins/test.json',
    entry = 'components/plugins/test.ts',
    dependency = 'components/plugins/data.json';
  snapshot.files[entry] = '// source';
  snapshot.files[dependency] = '{}';
  snapshot.files[file] = JSON.stringify({
    kind: 'vmotion-plugin',
    apiVersion: 1,
    id: 'example.cache',
    name: 'cache',
    version: '1.0.0',
    entry,
    files: [{ path: dependency, hash: hash('{}') }],
  });
  snapshot.project.plugins = [{ source: file, enabled: true }];
  const registry = new PluginRegistry(),
    uncached = new PluginRegistry(0);
  for (let i = 0; i < 20; i++)
    expect(registry.resolve(snapshot)[0].hash).toBe(uncached.resolve(snapshot)[0].hash);
  expect(registry.report()).toMatchObject({ parses: 1, contentDigests: 1 });
  expect(uncached.report()).toMatchObject({ parses: 20, contentDigests: 20, entries: 0 });
  expect(registry.report().accountedBytes).toBeLessThanOrEqual(registry.report().budgetBytes);
  snapshot.files[entry] += ' changed';
  expect(registry.resolve(snapshot)[0].hash).not.toBe(
    uncached.resolve({ ...snapshot, files: { ...snapshot.files, [entry]: '// source' } })[0].hash,
  );
  expect(registry.report().contentDigests).toBe(2);
  snapshot.files[dependency] = '{"changed":true}';
  expect(() => registry.resolve(snapshot)).toThrow(/file hash changed/);
});
it('pages audible nested clips without changing trim, envelope or rational sample positions', () => {
  const snapshot = timeline(),
    raw = audioClips(snapshot),
    full = inspectAudioTimeline(snapshot, { includeAll: true });
  expect(full.clips).toHaveLength(100);
  const first = inspectAudioTimeline(snapshot, {}),
    next = inspectAudioTimeline(snapshot, { offset: first.nextOffset });
  expect(first.clips).toHaveLength(24);
  expect(first.totalClips).toBe(100);
  expect(first.nextOffset).toBe(24);
  expect(first.clips).toEqual(full.clips.slice(0, 24));
  expect(next.clips).toEqual(full.clips.slice(24, 48));
  expect(full.clips[24].speed).toBe(raw[24].speed);
  expect(full.clips[24].sourceIn).toBe(raw[24].sourceIn);
  expect(full.clips[24].envelopes).toEqual(raw[24].envelopes);
  expect(full.clips[24].startSample).toBe(sampleAtFrame(raw[24].start, snapshot.project.fps));
  expect(full.clips[24].endSample).toBe(
    sampleAtFrame(raw[24].start + raw[24].duration, snapshot.project.fps),
  );
  expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(
    Buffer.byteLength(JSON.stringify(full)) * 0.3,
  );
  expect(inspectAudioTimeline(snapshot, { offset: 100 }).clips).toHaveLength(0);
  expect(() => inspectAudioTimeline(snapshot, { sequenceId: 'missing' })).toThrow(
    /Audio sequence not found/,
  );
});
