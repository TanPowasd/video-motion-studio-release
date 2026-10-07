import { z } from 'zod';
import { VmotionError } from '../core/model.js';
/** Transport boundaries; both surfaces continue to use the same project service. */
export const agentDiscoverySchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('search'), request: z.unknown().default({}) }).strict(),
  z.object({ kind: z.literal('schema'), request: z.unknown() }).strict(),
]);
export const agentOnlyMethods = new Set([
  'agentGuide',
  'projectContext',
  'projectFileRead',
  'projectDiagnostics',
  'agentDefinitions',
  'agentToolInvoke',
  'pluginCatalog',
]);
export function assertSurfaceMethod(surface: 'studio' | 'agent' | 'legacy', method: unknown) {
  if (typeof method !== 'string')
    throw new VmotionError('METHOD_NOT_FOUND', 'RPC method must be a string');
  if (surface === 'studio' && agentOnlyMethods.has(method))
    throw new VmotionError('SURFACE_METHOD', 'This automation method belongs to /api/agent/rpc');
}
export const surfaceManifest = {
  studio: {
    path: '/',
    rpc: '/api/studio/rpc',
    workspaces: ['animation', 'editing', 'music', 'drawing', 'code'],
  },
  agent: {
    interfacesOnly: true,
    path: '/agent/',
    rpc: '/api/agent/rpc',
    discovery: '/api/agent/discovery',
    interfaces: ['files', 'cli', 'mcp'],
  },
  shared: ['project-service', 'renderer', 'transactions', 'undo'],
  aiIntegration: false,
};
