import { z } from 'zod';
import { ProjectReferences } from '../core/project-references.js';
import { projectReferencesSchema, queryProjectReferences } from '../service/project-references.js';
import { planReferences, referencePlanSchema } from '../service/reference-plan.js';
import { referenceSampleSchema, sampleReferences } from '../service/reference-sample.js';
import { querySequence, sequenceQuerySchema } from '../service/sequence-query.js';
import { builtinCandidate } from './candidate.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';
const indexes = new WeakMap<object, ProjectReferences>();
function indexFor(service: object) {
  let index = indexes.get(service);
  if (!index) {
    index = new ProjectReferences();
    indexes.set(service, index);
  }
  return index;
}
export const organizationPlugin: BuiltinPluginModule = {
  id: 'vmotion.organization',
  name: '工程引用、素材与镜头组织',
  version: '1.0.0',
  dependencies: {
    'vmotion.core': '^1.0.0',
    'vmotion.media': '^1.0.0',
    'vmotion.composition': '^1.0.0',
  },
  methods: new Set(['projectReferences', 'referencePlan', 'referenceSample', 'sequenceQuery']),
  tools: () => [
    {
      name: 'project_references',
      method: 'projectReferences',
      schema: projectReferencesSchema.shape,
      description:
        'Page 24 project entities, declared uses, incoming/outgoing links, transitive reachability or uncertain sources. Covers known JSON scenes/timelines/resources, static TS imports and opt-in exact literal hints. Text-checked bounded index cache; stable reference IDs and explicit incomplete runtime coverage. No media probe/compile/delete.',
      categories: ['core', 'composition', 'media', 'editing'],
      keywords: '工程 引用 用途 素材 镜头 依赖 查找 关系 reference usage dependency',

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'reference_plan',
      method: 'referencePlan',
      schema: referencePlanSchema.shape,
      description:
        'Plan selective same-kind source replacements by inspected stable reference IDs/files/use counts in one exact candidate. Declared editable JSON fields only; hash-check files and verify target media/ranges/locks. Keep object IDs, keyframes, source windows and author TS; pinned/template/tracking/code-hint sources require dedicated tools. Preflight sampled native frames, apply unchanged and undo once.',
      categories: ['core', 'composition', 'media', 'editing'],
      keywords: '替换 素材 来源 场景 组件 批量 候选 replace reference source',

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'reference_sample',
      method: 'referenceSample',
      schema: referenceSampleSchema.shape,
      description:
        'Sample actual generated/retimed node reference uses at 1–12 explicit scene/group/component frames. Page compact IDs/source fields; detail returns editable path/localFrame/contextFrames locators. Static query cannot prove runtime completeness; sampled evidence is bounded and does not change project/history.',
      categories: ['core', 'composition', 'media'],
      keywords: '运行时 引用 图层 定位 代码 采样 reference runtime generated',

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    {
      name: 'sequence_query',
      method: 'sequenceQuery',
      schema: sequenceQuerySchema.innerType().shape,
      description:
        'Page 24 stored timeline clips with stable track/clip IDs, source windows, locks/mute state and source/range filters. Detail opts into complete selected clips; counts/nextOffset explicit. No recursive flatten or full project dump; edit via shared sequence/reference candidates.',
      categories: ['editing', 'core'],
      keywords: '镜头 片段 时间线 来源 查询 分页 锁定 clip sequence shot timeline',

      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
  ],
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(organizationRpcHandlers, host, method, params);
  },
};

export const organizationRpcHandlers = {
  projectReferences: defineRpcHandler(
    z
      .object(projectReferencesSchema.shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'projectReferences';
      const index = indexFor(host.coreService);
      return queryProjectReferences(index, host.snapshot, params);
    },
  ),
  referencePlan: defineRpcHandler(
    z.object(referencePlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'referencePlan';
      const index = indexFor(host.coreService);
      const snapshot = structuredClone(host.snapshot),
        planned = await planReferences(host.root, index, snapshot, params);
      return builtinCandidate(
        host.root,
        {
          revision: snapshot.revision,
          operations: planned.operations,
          assetChecks: planned.assetChecks,
          samples: planned.samples,
          width: 320,
          determinism: true,
          visual: true,
        },
        planned.candidate.revision,
        planned.request.delivery,
        {
          changes: planned.changes,
          files: planned.files,
          coverage: planned.coverage,
          limitations: planned.limitations,
        },
      );
    },
  ),
  referenceSample: defineRpcHandler(
    z.object(referenceSampleSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'referenceSample';
      const index = indexFor(host.coreService);
      return host.withMediaTask(() =>
        sampleReferences(host.renderer, structuredClone(host.snapshot), params),
      );
    },
  ),
  sequenceQuery: defineRpcHandler(
    z
      .object(sequenceQuerySchema.innerType().shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'sequenceQuery';
      const index = indexFor(host.coreService);
      return querySequence(host.snapshot, params);
    },
  ),
};
