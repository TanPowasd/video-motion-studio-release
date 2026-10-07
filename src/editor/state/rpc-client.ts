import { z } from 'zod';
import type { RpcMethod, RpcInput, RpcOutput } from '../../service/rpc-contract.js';
import {agentOnlyMethods} from '../../service/surfaces.js';
export interface RpcClient {
  <M extends RpcMethod>(method: M, params?: unknown): Promise<RpcOutput<M>>;
  (method: string, params?: unknown): Promise<unknown>;
}
const envelope = z.object({
  result: z.unknown().optional(),
  error: z
    .object({ message: z.string(), code: z.string().optional(), details: z.unknown().optional() })
    .optional(),
});
export const rpc: RpcClient = async (method: string, params: unknown = {}) => {
  const response = await fetch(agentOnlyMethods.has(method)?'/api/agent/rpc':'/api/studio/rpc', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params }),
  });
  const value = envelope.parse(await response.json());
  if (value.error) {
    const details = Array.isArray(value.error.details)
      ? value.error.details.flatMap((item: unknown) => {
          const parsed = z.object({ severity: z.string(), message: z.string() }).safeParse(item);
          return parsed.success && parsed.data.severity === 'error' ? [parsed.data.message] : [];
        })
      : [];
    throw new Error(details.length ? details.join('\n') : value.error.message);
  }
  return value.result;
};
export async function rpcTyped<M extends RpcMethod>(
  method: M,
  params: RpcInput<M>,
): Promise<RpcOutput<M>> {
  return await rpc(method, params);
}
