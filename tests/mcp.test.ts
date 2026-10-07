import { it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { initProject } from '../src/service/template.js';
it('an external MCP client inspects, edits and captures a native frame', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'vmotion-mcp-'));
  await initProject(root);
  const client = new Client({ name: 'vmotion-integration-test', version: '1.0.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['--import', 'tsx', 'src/cli/index.ts', 'mcp', '--project', root, '--tools', 'all'],
    cwd: path.resolve('.'),
    stderr: 'pipe',
  });
  try {
    await client.connect(transport);
    const tools = await client.listTools();
    expect(tools.tools.some((t) => t.name === 'frame_capture')).toBe(true);
    expect(tools.tools.some((t) => t.name === 'frame_sample')).toBe(true);
    expect(tools.tools.find((t) => t.name === 'animation_guide')?.inputSchema.type).toBe('object');
    const invalidEmpty = await client.callTool({
      name: 'animation_guide',
      arguments: { unexpected: true },
    });
    expect(invalidEmpty.isError).toBe(true);
    expect(JSON.parse((invalidEmpty.content as Array<{ text: string }>)[0].text).code).toBe(
      'TOOL_ARGUMENTS',
    );
    expect(
      [
        'agent_guide',
        'media_inspect',
        'media_sample',
        'sequence_plan',
        'linear_algebra',
        'matrix3d',
        'scene3d_render',
      ].every((name) => tools.tools.some((t) => t.name === name)),
    ).toBe(true);
    const routing = await client.callTool({ name: 'agent_guide', arguments: { topic: 'math' } });
    expect(routing.isError).not.toBe(true);
    expect(
      JSON.parse((routing.content as Array<{ text: string }>)[0].text).workflow.tools,
    ).toContain('linear_algebra');
    const solve = await client.callTool({
      name: 'linear_algebra',
      arguments: {
        request: {
          operation: 'solve',
          a: [
            [2, 1],
            [1, 3],
          ],
          b: [5, 5],
        },
      },
    });
    expect(solve.isError, JSON.stringify(solve.content)).not.toBe(true);
    expect(JSON.parse((solve.content as Array<{ text: string }>)[0].text).result.solution).toEqual([
      2, 1,
    ]);
    const vectorGeometry = await client.callTool({
      name: 'path_geometry',
      arguments: {
        operation: 'difference',
        paths: [{ path: 'M0 0H100V100H0Z' }, { path: 'M25 25H75V75H25Z' }],
      },
    });
    expect(vectorGeometry.isError).not.toBe(true);
    expect(
      JSON.parse((vectorGeometry.content as Array<{ text: string }>)[0].text).bounds.width,
    ).toBe(100);
    expect(tools.tools.some((t) => t.name === 'vector_bake')).toBe(true);
    const pattern = await client.callTool({
      name: 'repeat_describe',
      arguments: {
        parameters: { count: 3, position: { x: 40, y: 10 } },
        sourceBounds: { x: 5, y: 5, width: 20, height: 10 },
      },
    });
    expect(pattern.isError).not.toBe(true);
    expect(JSON.parse((pattern.content as Array<{ text: string }>)[0].text).bounds.width).toBe(100);
    const guide = await client.callTool({ name: 'animation_guide', arguments: {} });
    expect(
      JSON.parse((guide.content as Array<{ text: string }>)[0].text).helpers.some(
        (h: { name: string }) => h.name === 'group',
      ),
    ).toBe(true);
    const inspect = await client.callTool({ name: 'project_inspect', arguments: {} });
    const state = JSON.parse((inspect.content as Array<{ text: string }>)[0].text);
    expect(state.capabilities.aiIntegration).toBe(false);
    const edited = await client.callTool({
      name: 'project_transact',
      arguments: {
        revision: state.snapshot.revision,
        operations: [
          {
            type: 'updateNode',
            sceneId: 'intro',
            nodeId: 'subtitle',
            patch: { text: 'External agent edited this' },
          },
        ],
      },
    });
    expect(edited.isError, JSON.stringify(edited.content)).not.toBe(true);
    const repeated = await client.callTool({
      name: 'repeat_create',
      arguments: {
        sceneId: 'intro',
        nodeIds: ['subtitle'],
        id: 'text-pattern',
        parameters: { count: 2, position: { x: 100, y: 0 } },
      },
    });
    expect(repeated.isError, JSON.stringify(repeated.content)).not.toBe(true);
    expect(
      JSON.parse((repeated.content as Array<{ text: string }>)[0].text).repeater.sourceFile,
    ).toContain('repeater-text-pattern');
    const shared = await client.callTool({
      name: 'scene_precompose',
      arguments: {
        sceneId: 'intro',
        nodeIds: ['text-pattern'],
        sourceId: 'mcp-shared',
        id: 'mcp-ref',
      },
    });
    expect(shared.isError, JSON.stringify(shared.content)).not.toBe(true);
    const references = await client.callTool({
      name: 'scene_references',
      arguments: { sourceId: 'mcp-shared' },
    });
    expect(references.isError).not.toBe(true);
    expect(
      JSON.parse((references.content as Array<{ text: string }>)[0].text).incoming,
    ).toHaveLength(1);
    const sharedScope = await client.callTool({
      name: 'composition_inspect',
      arguments: { sceneId: 'intro', path: ['mcp-ref'], frame: 90 },
    });
    expect(sharedScope.isError, JSON.stringify(sharedScope.content)).not.toBe(true);
    expect(
      JSON.parse((sharedScope.content as Array<{ text: string }>)[0].text).scene.nodes[0].id,
    ).toBe('mcp-ref/text-pattern');
    const frozen = await client.callTool({
      name: 'time_edit',
      arguments: { sceneId: 'intro', nodeId: 'mcp-ref', frame: 90, preset: 'freeze' },
    });
    expect(frozen.isError, JSON.stringify(frozen.content)).not.toBe(true);
    const clocks = await client.callTool({
      name: 'time_inspect',
      arguments: { sceneId: 'intro', nodeId: 'mcp-ref', frames: [0, 30, 90] },
    });
    expect(clocks.isError).not.toBe(true);
    expect(
      JSON.parse((clocks.content as Array<{ text: string }>)[0].text).samples.map(
        (s: { sourceFrame: number }) => s.sourceFrame,
      ),
    ).toEqual([90, 90, 90]);
    const localCapture = await client.callTool({
      name: 'frame_capture',
      arguments: {
        sceneId: 'intro',
        path: ['mcp-ref'],
        contextFrames: [30],
        frame: 90,
        width: 320,
        height: 180,
      },
    });
    expect(localCapture.isError, JSON.stringify(localCapture.content)).not.toBe(true);
    expect((localCapture.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(
      true,
    );
    const timelineEdit = await client.callTool({
      name: 'sequence_edit',
      arguments: {
        sequenceId: 'main',
        actions: [
          { type: 'workflow', mode: 'film' },
          { type: 'rangeIn', frame: 30 },
          { type: 'rangeOut', frame: 89 },
        ],
      },
    });
    expect(timelineEdit.isError, JSON.stringify(timelineEdit.content)).not.toBe(true);
    expect(
      JSON.parse((timelineEdit.content as Array<{ text: string }>)[0].text).snapshot.sequences[0]
        .workArea,
    ).toEqual({ start: 30, end: 90 });
    const captions = await client.callTool({
      name: 'captions_import',
      arguments: {
        sequenceId: 'main',
        content: '1\n00:00:01,000 --> 00:00:02,000\nEditable caption',
      },
    });
    expect(captions.isError, JSON.stringify(captions.content)).not.toBe(true);
    const captionFile = JSON.parse((captions.content as Array<{ text: string }>)[0].text).captions
      .dataFile;
    const captionList = await client.callTool({
      name: 'captions_inspect',
      arguments: { dataFile: captionFile },
    });
    expect(JSON.parse((captionList.content as Array<{ text: string }>)[0].text).cues[0].text).toBe(
      'Editable caption',
    );
    const capture = await client.callTool({
      name: 'frame_capture',
      arguments: { frame: 90, width: 320, height: 180 },
    });
    expect(capture.isError).not.toBe(true);
    expect((capture.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(true);
    const sample = await client.callTool({
      name: 'frame_sample',
      arguments: { frames: [0, 30, 90], width: 240 },
    });
    expect(sample.isError).not.toBe(true);
    const info = JSON.parse(
      (sample.content as Array<{ type: string; text?: string }>).find((c) => c.type === 'text')!
        .text!,
    );
    expect(info.samples.map((s: { frame: number }) => s.frame)).toEqual([0, 30, 90]);
    expect(info.revision).toBeTruthy();
    expect((sample.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(true);
    const visualAudit = await client.callTool({
      name: 'visual_audit',
      arguments: { sceneId: 'intro', frames: [0, 90], width: 240 },
    });
    expect(visualAudit.isError).not.toBe(true);
    expect((visualAudit.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(
      true,
    );
    const visualReport = JSON.parse((visualAudit.content as Array<{ text: string }>)[0].text);
    expect(visualReport.frames).toHaveLength(2);
    expect(visualReport.limitations.length).toBeGreaterThan(0);
    expect(tools.tools.some((t) => t.name === 'drawing_edit')).toBe(true);
    expect(tools.tools.some((t) => t.name === 'composition_structure')).toBe(true);
    const created = await client.callTool({
        name: 'drawing_create',
        arguments: { name: 'Agent drawing', width: 160, height: 90 },
      }),
      drawing = JSON.parse((created.content as Array<{ text: string }>)[0].text).document;
    const painted = await client.callTool({
      name: 'drawing_edit',
      arguments: {
        id: drawing.id,
        operations: [
          {
            type: 'stroke',
            layerId: drawing.layers[0].id,
            stroke: {
              id: 'agent-stroke',
              color: '#79b6ff',
              width: 12,
              points: [
                { x: 20, y: 20, pressure: 1 },
                { x: 120, y: 70, pressure: 0.5 },
              ],
            },
          },
        ],
      },
    });
    expect(painted.isError).not.toBe(true);
    const drawingCapture = await client.callTool({
      name: 'drawing_frame',
      arguments: { id: drawing.id, width: 160, height: 90 },
    });
    expect(drawingCapture.isError).not.toBe(true);
    expect(
      (drawingCapture.content as Array<{ type: string }>).some((c) => c.type === 'image'),
    ).toBe(true);
    const published = await client.callTool({
        name: 'drawing_publish',
        arguments: { id: drawing.id },
      }),
      asset = JSON.parse((published.content as Array<{ text: string }>)[0].text).asset;
    const placed = await client.callTool({
      name: 'asset_place',
      arguments: { assetId: asset.id, sequenceId: 'main', frame: 0, duration: 30 },
    });
    expect(placed.isError).not.toBe(true);
    const thumbnail = await client.callTool({
      name: 'asset_thumbnail',
      arguments: { assetId: asset.id },
    });
    expect(thumbnail.isError).not.toBe(true);
    expect((thumbnail.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(
      true,
    );
    const geometry = await client.callTool({
      name: 'composition_interactions',
      arguments: { sceneId: 'intro', frame: 90, nodeIds: ['title'] },
    });
    expect(geometry.isError).not.toBe(true);
    expect(
      JSON.parse((geometry.content as Array<{ text: string }>)[0].text).layers.map(
        (l: any) => l.node.id,
      ),
    ).toEqual(['title']);
    const contextResult = await client.callTool({
        name: 'project_context',
        arguments: { sceneId: 'intro', limit: 2 },
      }),
      context = JSON.parse((contextResult.content as Array<{ text: string }>)[0].text);
    expect(context.snapshot).toBeUndefined();
    const parametersResult = await client.callTool({
      name: 'component_parameters',
      arguments: { sceneId: 'intro', nodeId: 'wave' },
    });
    expect(parametersResult.isError).not.toBe(true);
    const parameters = JSON.parse((parametersResult.content as Array<{ text: string }>)[0].text);
    expect(parameters.channels.some((channel: any) => channel.path === 'amplitude')).toBe(true);
    const animationBefore = await client.callTool({
      name: 'animation_inspect',
      arguments: { sceneId: 'intro', nodeId: 'title', frames: [0, 30, 60] },
    });
    expect(animationBefore.isError).not.toBe(true);
    expect(
      JSON.parse((animationBefore.content as Array<{ text: string }>)[0].text).samples,
    ).toHaveLength(3);
    const audioTimeline = await client.callTool({
      name: 'audio_timeline',
      arguments: { sequenceId: 'main' },
    });
    expect(audioTimeline.isError).not.toBe(true);
    expect(JSON.parse((audioTimeline.content as Array<{ text: string }>)[0].text).sampleRate).toBe(
      48000,
    );
    const audioPreview = await client.callTool({
      name: 'audio_preview',
      arguments: { sequenceId: 'main', startSample: 0, sampleCount: 24000 },
    });
    expect(audioPreview.isError).not.toBe(true);
    expect((audioPreview.content as Array<{ type: string }>).some((c) => c.type === 'audio')).toBe(
      true,
    );
    const animated = await client.callTool({
      name: 'animation_edit',
      arguments: {
        sceneId: 'intro',
        edits: [
          { nodeId: 'title', actions: [{ type: 'transform', timeOffset: 10, timeScale: 1.5 }] },
        ],
      },
    });
    expect(animated.isError).not.toBe(true);
    expect(
      JSON.parse((animated.content as Array<{ text: string }>)[0].text).snapshot,
    ).toBeUndefined();
    await client.callTool({ name: 'project_undo', arguments: {} });
    const parameterEdit = await client.callTool({
      name: 'component_parameters_edit',
      arguments: {
        sceneId: 'intro',
        nodeId: 'wave',
        keys: [
          { path: 'amplitude', frame: 0, value: 90 },
          { path: 'amplitude', frame: 60, value: 120 },
        ],
      },
    });
    expect(parameterEdit.isError).not.toBe(true);
    expect(
      JSON.parse((parameterEdit.content as Array<{ text: string }>)[0].text).snapshot,
    ).toBeUndefined();
    await client.callTool({ name: 'project_undo', arguments: {} });
    expect(context.files.items.length).toBeLessThanOrEqual(2);
    const schemaResult = await client.callTool({
      name: 'project_schema',
      arguments: { name: 'operation', operationType: 'writeSource' },
    });
    expect(schemaResult.isError).not.toBe(true);
    expect(
      JSON.parse((schemaResult.content as Array<{ text: string }>)[0].text).operationType,
    ).toBe('writeSource');
    const fileResult = await client.callTool({
        name: 'project_file_read',
        arguments: { path: 'components/wave.ts', lineCount: 100 },
      }),
      file = JSON.parse((fileResult.content as Array<{ text: string }>)[0].text),
      candidate = {
        revision: context.revision,
        files: [
          {
            type: 'text',
            path: file.path,
            expectedHash: file.hash,
            replacements: [{ before: 'strokeWidth: 5', after: 'strokeWidth: 7' }],
          },
        ],
        samples: [{ sceneId: 'intro', frame: 90 }],
        width: 240,
        determinism: true,
      };
    const previewResult = await client.callTool({
        name: 'project_preflight',
        arguments: candidate,
      }),
      preview = JSON.parse((previewResult.content as Array<{ text: string }>)[0].text);
    expect(preview.valid).toBe(true);
    expect((previewResult.content as Array<{ type: string }>).some((c) => c.type === 'image')).toBe(
      true,
    );
    const commit = await client.callTool({
        name: 'project_apply',
        arguments: { ...candidate, expectedCandidateRevision: preview.candidateRevision },
      }),
      appliedInfo = JSON.parse((commit.content as Array<{ text: string }>)[0].text);
    expect(commit.isError).not.toBe(true);
    expect(appliedInfo.revision).toBe(preview.candidateRevision);
    expect(appliedInfo.snapshot).toBeUndefined();
    expect(appliedInfo.applied).toBe(true);
    await client.callTool({ name: 'project_undo', arguments: {} });
    const restored = await client.callTool({
      name: 'project_file_read',
      arguments: { path: file.path },
    });
    expect(JSON.parse((restored.content as Array<{ text: string }>)[0].text).hash).toBe(file.hash);
  } finally {
    await client.close();
    await transport.close();
    await rm(root, { recursive: true, force: true });
  }
}, 30000);
