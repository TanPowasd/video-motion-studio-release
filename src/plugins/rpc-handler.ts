import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { BuiltinPluginHost } from './types.js';
export interface RpcHandler<S extends z.ZodTypeAny, R> {
  schema: S;
  run: (host: BuiltinPluginHost, raw: unknown) => Promise<R>;
}
export function defineRpcHandler<S extends z.ZodTypeAny, R>(
  schema: S,
  run: (host: BuiltinPluginHost, params: z.output<S>) => Promise<R>,
): RpcHandler<S, R> {
  return {
    schema,
    async run(host, raw) {
      return await run(host, schema.parse(raw));
    },
  };
}
export function invokeRpcHandler(
  handlers: Record<string, { run: (host: BuiltinPluginHost, raw: unknown) => Promise<unknown> }>,
  host: BuiltinPluginHost,
  method: string,
  raw: unknown,
) {
  const handler = Object.hasOwn(handlers, method) ? handlers[method] : undefined;
  if (!handler) throw new VmotionError('METHOD_NOT_FOUND', `No RPC handler for ${method}`);
  return handler.run(host, raw);
}
