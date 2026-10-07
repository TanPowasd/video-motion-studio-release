import { expect, it } from 'vitest';
import { builtinRpcHandlers } from '../src/plugins/rpc-handlers.js';
import { toolDefinitions } from '../src/mcp/catalog.js';
import { defineRpcHandler } from '../src/plugins/rpc-handler.js';
import { z } from 'zod';
import type { BuiltinPluginHost } from '../src/plugins/types.js';
import type { RpcInput, RpcOutput } from '../src/service/rpc-contract.js';
it('gives all built-in RPC methods one runtime schema and typed handler', () => {
  const methods = toolDefinitions().map((tool) => tool.method);
  expect(Object.keys(builtinRpcHandlers).sort()).toEqual([...new Set(methods)].sort());
  for (const handler of Object.values(builtinRpcHandlers))
    expect(handler.schema).toBeInstanceOf(z.ZodType);
});
it('validates untyped requests before running a handler', async () => {
  let runs = 0;
  const handler = defineRpcHandler(z.object({ id: z.string() }).strict(), async (_host, p) => {
    runs++;
    return { id: p.id };
  });
  await expect(handler.run({} as BuiltinPluginHost, { id: 3 })).rejects.toThrow();
  expect(runs).toBe(0);
  expect(await handler.run({} as BuiltinPluginHost, { id: 'node' })).toEqual({ id: 'node' });
});
it('preserves strict input contracts at compile time', () => {
  const request: RpcInput<'job'> = { id: 'task' };
  expect(request.id).toBe('task');
  // @ts-expect-error Task IDs must remain strings.
  const invalid: RpcInput<'job'> = { id: 3 };
  expect(invalid.id).toBe(3);
  const flag: RpcOutput<'ping'>['aiIntegration'] = false;
  expect(flag).toBe(false);
});
