import { it, expect } from 'vitest';
import { invokeTool, projectToolResult, toolError } from '../src/mcp/invoke.js';
import { normalizeToolDefinition } from '../src/mcp/tool-definition.js';
const definition = (method = 'probe') =>
  normalizeToolDefinition({ name: 'fixture', method, description: 'fixture', schema: {} });
it('retains sibling and overlapping selections without changing arrays or source objects', () => {
  const value = {
    revision: 'r',
    summary: { mean: 3, max: 9 },
    samples: [{ hash: 'a', frame: 2 }],
    nullable: null,
    undefined: undefined,
  };
  const projected = projectToolResult(value, [
    'summary.mean',
    'summary.max',
    'samples.0.hash',
    'samples.0.frame',
    'nullable',
    'undefined',
    'absent',
  ]);
  expect(projected).toMatchObject({
    summary: { mean: 3, max: 9 },
    samples: { 0: { hash: 'a', frame: 2 } },
    resultProjection: { missing: ['absent'] },
  });
  expect(Object.hasOwn(projected, 'undefined')).toBe(true);
  for (const fields of [
    ['summary', 'summary.mean'],
    ['summary.mean', 'summary'],
    ['samples', 'samples.0.hash'],
  ])
    expect(projectToolResult(value, fields)).toMatchObject({ resultProjection: { missing: [] } });
  expect(value.samples).toEqual([{ hash: 'a', frame: 2 }]);
  expect(value.summary).toEqual({ mean: 3, max: 9 });
  for (const path of ['__proto__.x', 'constructor.x', 'prototype.x'])
    expect(() => projectToolResult(value, [path])).toThrow();
});
it('rejects malformed backend evidence with structured errors and preserves scalar results', async () => {
  for (const value of [undefined, () => {}, Symbol('result'), 1n]) {
    const error = await invokeTool(definition(), {}, async () => value).catch((error) => error);
    expect(toolError(error)).toMatchObject({
      isError: true,
      structuredContent: { error: { code: 'TOOL_RESULT' } },
    });
  }
  await expect(
    invokeTool(definition('scene3dRender'), {}, async () => ({ images: [null] })),
  ).rejects.toMatchObject({ code: 'TOOL_RESULT' });
  await expect(
    invokeTool(definition('frame'), {}, async () => ({ data: 42 })),
  ).rejects.toMatchObject({ code: 'TOOL_RESULT' });
  expect((await invokeTool(definition(), {}, async () => 42)).result.structuredContent).toEqual({
    result: 42,
  });
  expect(toolError('unexpected')).toMatchObject({
    structuredContent: { error: { message: 'unexpected' } },
  });
});
it('sends media once and preserves explicit media-free JSON', async () => {
  const result = await invokeTool(definition('scene3dRender'), {}, async () => ({
    revision: 'r',
    images: [
      { kind: 'color', data: 'a' },
      { kind: 'depth', data: 'b' },
    ],
  }));
  expect(result.result.content.filter((content) => content.type === 'image')).toHaveLength(2);
  expect(JSON.stringify(result.result.structuredContent)).not.toContain('"data"');
  const hidden = await invokeTool(
    definition('frame'),
    {},
    async () => ({ revision: 'r', data: 'a' }),
    { media: false },
  );
  expect(hidden.result.content.every((content) => content.type === 'text')).toBe(true);
  expect(JSON.stringify(hidden.result.structuredContent)).not.toContain('"data"');
});
