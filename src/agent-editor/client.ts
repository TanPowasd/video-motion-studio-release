import { z } from 'zod';
import type { RpcMethod, RpcInput, RpcOutput } from '../service/rpc-contract.js';
const envelope = z.object({
  result: z.unknown().optional(),
  error: z
    .object({ code: z.string().optional(), message: z.string(), details: z.unknown().optional() })
    .optional(),
});
export async function agentRequest<T = unknown>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    }),
    value = envelope.parse(await r.json());
  if (value.error) throw new Error(`${value.error.code ?? 'ERROR'}: ${value.error.message}`);
  return value.result as T;
}
export function agentRpc<M extends RpcMethod>(method: M, params: RpcInput<M>) {
  return agentRequest<RpcOutput<M>>('/api/agent/rpc', { method, params });
}
export const discovery = (kind: 'search' | 'schema', request: unknown) =>
  agentRequest('/api/agent/discovery', { kind, request });
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}
export const textValue = (value: unknown) => (typeof value === 'string' ? value : '');
