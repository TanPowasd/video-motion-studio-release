import { z } from 'zod';
import { VmotionError, type Operation } from '../core/model.js';
import { builtinPluginNames } from '../core/plugins.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { agentGuide, agentGuideSchema } from '../service/agent-guide.js';
import { resolveAgentPlan } from '../service/agent-plans.js';
import {
  agentContext,
  contextOptionsSchema,
  fileReadSchema,
  readProjectFile,
} from '../service/agent.js';
import { checkAssets } from '../service/media-evidence.js';
import {
  inspectPlugins,
  installPlugins,
  packagePlugin,
  planPlugins,
  pluginInspectSchema,
  pluginPackageSchema,
  pluginPlanSchema,
  type BuiltinPluginGroups,
} from '../service/plugins.js';
import { packPlugins, pluginInstallSchema, pluginPackSchema } from '../service/plugin-bundles.js';
import { preflight, preflightSchema } from '../service/preflight.js';
import {
  projectDiagnosticsSchema,
  queryProjectDiagnostics,
} from '../service/project-diagnostics.js';
import { projectSchemaInfo, projectSchemaNames } from '../service/schemas.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const candidateInput = {
  ...Object.fromEntries(
    Object.entries(preflightSchema.omit({ inline: true }).shape).map(([name, schema]) => [
      name,
      schema instanceof z.ZodDefault ? schema.removeDefault().optional() : schema,
    ]),
  ),
  operations: z.array(z.record(z.unknown())).max(1000).optional(),
};

export const corePlugin: BuiltinPluginModule = {
  id: 'vmotion.core',
  name: '工程、候选与Agent控制',
  version: '1.0.0',
  methods: new Set([
    'pluginsInspect',
    'pluginsPlan',
    'pluginsPackage',
    'pluginsPack',
    'pluginsInstall',
    'agentGuide',
    'projectSchema',
    'projectContext',
    'projectDiagnostics',
    'projectFileRead',
    'projectPreflight',
    'projectApply',
    'state',
    'validate',
    'transact',
    'save',
    'selection',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'plugins_inspect',
        description:
          'Inspect paged builtin/project plugins, versions, dependencies, contribution sources and namespaced tools. Full manifests are opt-in. Existing ordinary resource references survive library disable/removal.',
        method: 'pluginsInspect',
        schema: pluginInspectSchema.shape,
        categories: ['core', 'composition'],
        keywords: '插件 注册 依赖 版本 plugin module',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'plugins_plan',
        description:
          'Plan project-local plugin registration, enabling/disabling/removal, hash-checked source files and component placements in one exact candidate. Dependencies/API/duplicate IDs are checked; preflight loads typed tool exports and sampled native frames. No source is deleted on removal unless explicitly requested.',
        method: 'pluginsPlan',
        schema: pluginPlanSchema.shape,
        categories: ['core', 'composition', 'recovery'],
        keywords: '插件 安装 注册 创建 更新 禁用 移除 候选 plugin register dependency',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'plugins_package',
        description:
          'Read a paginated plugin package index with manifest/content hashes, dependencies and bounded file sizes. Source text is never duplicated by default; use project_file_read only for selected ranges.',
        method: 'pluginsPackage',
        schema: pluginPackageSchema.shape,
        categories: ['core'],
        keywords: '插件 包 指纹 hash 依赖 文件 package integrity bundle',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'plugins_pack',
        description:
          'Pack a registered project plugin (default with its project-plugin dependencies) into a deterministic portable .vmplugin ZIP: vmplugin.json lists per-file sha256, content hashes and a bundle digest. Writes only the bundle file (default exports/plugins/<id>-<version>.vmplugin); the project is unchanged. Source is not echoed; base64 is opt-in.',
        method: 'pluginsPack',
        schema: pluginPackSchema.shape,
        categories: ['core'],
        keywords: '插件 打包 导出 分发 bundle pack vmplugin zip share',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'plugins_install',
        description:
          'Install or upgrade a plugin from a local folder, .vmplugin/.zip bundle (path or base64) or an explicit Git URL/ref, as one exact plugins candidate: files are copied under components/, hashes verified, semver dependencies resolved (bundled deps installed, missing/conflicting versions reported), optional pin. Reserved vmotion.* IDs, future apiVersion, path traversal, oversized archives, downgrades and foreign-file overwrites are rejected unless explicitly allowed. summary.install shows the version diff. Commit with project_preflight/project_apply; uninstall is plugins_plan remove.',
        method: 'pluginsInstall',
        schema: pluginInstallSchema.shape,
        categories: ['core', 'composition'],
        keywords:
          '插件 安装 升级 更新 导入 依赖 git 文件夹 install upgrade bundle vmplugin dependency',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: true,
        },
      },
      {
        name: 'agent_guide',
        description:
          'Concise workflow routing for external agents: overview, animation, editing, 3d, math or recovery. Tool names, units, evidence/commit steps and retry guidance; no source or large schemas dumped. Start here, then project_context.',
        method: 'agentGuide',
        schema: agentGuideSchema.shape,

        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_schema',
        description:
          'Read one authoritative JSON schema only when needed. Query operationType to get the schema of a specific semantic operation rather than the full operation catalog.',
        method: 'projectSchema',
        schema: {
          name: z.enum(projectSchemaNames),
          operationType: z.string().optional(),
        },

        categories: ['core'],
        keywords: '格式 定义 schema',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_context',
        description:
          'Start here for concise project metadata, revision, stable IDs, source-file hashes, diagnostics and selection. Paginate files/assets/layers; request a scene or sequence without reading all source code.',
        method: 'projectContext',
        schema: contextOptionsSchema.shape,

        categories: ['core', 'recovery'],
        keywords: '工程 摘要 文件 hash 版本 选区',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_diagnostics',
        description:
          'Read 20 compact diagnostics, conflict locators or changed pending-file paths. Filter by files/codes/severity with explicit totals and pagination; detail=true returns full messages/conflict versions or selected file hashes. Read-only, no reload/history changes. Use project_file_read version=pending for source repairs.',
        method: 'projectDiagnostics',
        schema: projectDiagnosticsSchema.innerType().shape,
        categories: ['core', 'recovery'],
        keywords: '诊断 错误 冲突 待修复 文件 error warning conflict pending repair',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_file_read',
        description:
          'Read a bounded line range of a tracked project source file with its exact content hash and revision. Use version=pending to inspect invalid external edits; active returns the last usable source.',
        method: 'projectFileRead',
        schema: fileReadSchema.shape,

        categories: ['core', 'recovery'],
        keywords: '源码 文件 阅读 hash',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_preflight',
        description:
          'Check a candidate batch of semantic operations and hash-checked file edits without replacing active project files or undo history. Includes JSON/type/component checks and optional native sample frames; determinism repeats sampled frames. Returns diagnostics and a contact-sheet image for requested frames.',
        method: 'projectPreflight',
        schema: candidateInput,

        categories: ['core', 'recovery'],
        keywords: '预检 代码 类型 画面 候选',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_apply',
        description:
          'Validate and atomically commit candidate operations and hash-checked file edits with one undo step. Use revision plus expectedCandidateRevision from project_preflight to commit exactly the inspected candidate. File edits support replace/create, unique exact-text substitutions and delete. New JSON scene/sequence/drawing files must be referenced in the manifest.',
        method: 'projectApply',
        schema: { ...candidateInput, expectedCandidateRevision: z.string().optional() },

        categories: ['core', 'recovery'],
        keywords: '提交 原子 保存 修改',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_inspect',
        description:
          'Read project files, scene nodes, sequence tracks, selection, diagnostics, conflicts and current revision.',
        method: 'state',
        schema: {},

        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_validate',
        description: 'Validate references, format and TypeScript component compilation.',
        method: 'validate',
        schema: {},

        categories: ['core', 'recovery'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'project_transact',
        description:
          'Apply an atomic undoable batch. Supports native node/scene/track/clip operations, writeSource, editFiles, writeDrawing and removeDrawing. Use current revision for optimistic concurrency; project_apply also offers runtime preflight and compact results.',
        method: 'transact',
        schema: {
          operations: z.array(z.record(z.unknown())).min(1).max(1000),
          revision: z.string().optional(),
          save: z.boolean().optional(),
        },

        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_save',
        description: 'Save valid staged edits atomically.',
        method: 'save',
        schema: {},

        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_select',
        description: 'Set selected node IDs in the shared edit session.',
        method: 'selection',
        schema: { ids: z.array(z.string()) },

        categories: ['core'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(coreRpcHandlers, host, method, params);
  },
};

export const coreRpcHandlers = {
  pluginsInspect: defineRpcHandler(
    z.object(pluginInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'pluginsInspect';
      const service = host.coreService;
      const groups: BuiltinPluginGroups = {};
      for (const tool of host.registry.tools) {
        const id = tool.plugin!.id;
        const group = (groups[id] ??= {
          name: builtinPluginNames[id] ?? id,
          tools: [],
          categories: [],
          details: [],
        });
        group.tools.push(tool.name);
        for (const category of tool.categories ?? [])
          if (!group.categories!.includes(category)) group.categories!.push(category);
        if (params.includeParameters && params.id === id)
          group.details!.push({
            name: tool.name,
            description:
              tool.description.length > 160
                ? tool.description.slice(0, 159) + '…'
                : tool.description,
            parameters: Object.keys(tool.schema ?? {}),
            readOnly: !!tool.annotations?.readOnlyHint,
          });
      }
      for (const [id, group] of Object.entries(groups))
        group.migration = host.registry.status(id, group.tools);
      return inspectPlugins(host.plugins, service.snapshot, params, groups);
    },
  ),
  pluginsPlan: defineRpcHandler(
    z.object(pluginPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'pluginsPlan';
      const service = host.coreService;
      return planPlugins(host.root, host.plugins, structuredClone(service.snapshot), params);
    },
  ),
  pluginsPack: defineRpcHandler(
    z.object(pluginPackSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, { inline, ...params }) =>
      packPlugins(host.root, host.plugins, host.coreService.snapshot, params),
  ),
  pluginsInstall: defineRpcHandler(
    z.object(pluginInstallSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, { inline, ...params }) =>
      installPlugins(host.root, host.plugins, structuredClone(host.coreService.snapshot), params),
  ),
  pluginsPackage: defineRpcHandler(
    z.object(pluginPackageSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'pluginsPackage';
      const service = host.coreService;
      return packagePlugin(host.plugins, service.snapshot, params);
    },
  ),
  agentGuide: defineRpcHandler(
    z.object(agentGuideSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'agentGuide';
      const service = host.coreService;
      const guide = agentGuide(params);
      guide.discovery.availableCapabilities = host.definitions().length;
      return guide;
    },
  ),
  projectSchema: defineRpcHandler(
    z
      .object({
        name: z.enum(projectSchemaNames),
        operationType: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'projectSchema';
      const service = host.coreService;
      return projectSchemaInfo(params.name, params.operationType);
    },
  ),
  projectContext: defineRpcHandler(
    z.object(contextOptionsSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'projectContext';
      const service = host.coreService;
      return agentContext(service as Parameters<typeof agentContext>[0], params);
    },
  ),
  projectDiagnostics: defineRpcHandler(
    z
      .object(projectDiagnosticsSchema.innerType().shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'projectDiagnostics';
      const service = host.coreService;
      return queryProjectDiagnostics(service, params);
    },
  ),
  projectFileRead: defineRpcHandler(
    z.object(fileReadSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'projectFileRead';
      const service = host.coreService;
      return readProjectFile(service as Parameters<typeof readProjectFile>[0], params);
    },
  ),
  projectPreflight: defineRpcHandler(
    preflightSchema.partial().extend({ expectedCandidateRevision: z.string().optional() }),
    async (host, params) => {
      const method = 'projectPreflight';
      const service = host.coreService;
      const request = await resolveAgentPlan(host.root, params);
      return (
        await preflight(
          host.root,
          structuredClone({
            ...service.snapshot,
            files:
              request.version === 'pending'
                ? (service.pendingFiles ?? service.snapshot.files)
                : service.snapshot.files,
          }),
          request,
        )
      ).result;
    },
  ),
  projectApply: defineRpcHandler(
    preflightSchema.partial().extend({ expectedCandidateRevision: z.string().optional() }),
    async (host, params) => {
      const method = 'projectApply';
      const service = host.coreService;
      const request = await resolveAgentPlan(host.root, params);
      if (service.pendingFiles && request.version !== 'pending')
        throw new VmotionError(
          'INVALID_ON_DISK',
          'Pending external files exist; read version=pending and preflight that version before applying repairs',
          service.diagnostics,
        );
      const { expectedCandidateRevision, ...input } = request,
        checked = await preflight(
          host.root,
          structuredClone({
            ...service.snapshot,
            files:
              request.version === 'pending'
                ? (service.pendingFiles ?? service.snapshot.files)
                : service.snapshot.files,
          }),
          input,
        );
      if (!checked.result.valid)
        throw new VmotionError(
          'VALIDATION_FAILED',
          'Preflight failed; no project changes saved',
          checked.result.diagnostics,
        );
      if (
        expectedCandidateRevision &&
        expectedCandidateRevision !== checked.result.candidateRevision
      )
        throw new VmotionError(
          'CANDIDATE_REVISION',
          'This candidate differs from the inspected preflight',
          { expected: expectedCandidateRevision, actual: checked.result.candidateRevision },
        );
      if (!checked.operations.length)
        return { ...checked.result, applied: false, revision: service.snapshot.revision };
      const state = await service.transact(
        checked.operations,
        checked.result.baseRevision,
        true,
        (candidate) => checkAssets(host.root, candidate, checked.result.assetChecks),
      );
      return {
        ...checked.result,
        applied: true,
        revision: state.snapshot.revision,
        canUndo: state.canUndo,
        canRedo: state.canRedo,
      };
    },
  ),
  state: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'state';
      const service = host.coreService;
      return host.applicationState();
    },
  ),
  validate: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'validate';
      const service = host.coreService;
      await service.exclusive(() => service.reload());
      const diagnostics = service.pendingFiles
        ? service.diagnostics
        : await service.validate(service.snapshot);
      try {
        await host.renderer.components.validate(service.snapshot);
      } catch (e) {
        diagnostics.push({
          severity: 'error',
          code: e instanceof VmotionError ? e.code : 'COMPONENT_ERROR',
          message: (e as Error).message,
          ...(e instanceof VmotionError ? (e.details as object) : {}),
        });
      }
      service.diagnostics = diagnostics;
      host.notifyState();
      return {
        valid: !diagnostics.some((d) => d.severity === 'error'),
        revision: service.snapshot.revision,
        diagnostics,
      };
    },
  ),
  transact: defineRpcHandler(
    z
      .object({
        operations: z.array(z.record(z.unknown())).min(1).max(1000),
        revision: z.string().optional(),
        save: z.boolean().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'transact';
      const service = host.coreService;
      if (!Array.isArray(params.operations) || params.operations.length > 1000)
        throw new VmotionError('OPERATIONS', 'Expected 1–1000 operations');
      return service.transact(
        params.operations as Operation[],
        params.revision,
        params.save !== false,
      );
    },
  ),
  save: defineRpcHandler(
    z.object({}).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'save';
      const service = host.coreService;
      return service.save();
    },
  ),
  selection: defineRpcHandler(
    z
      .object({ ids: z.array(z.string()) })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'selection';
      const service = host.coreService;
      const ids = Array.isArray(params.ids) ? params.ids : [];
      host.select(ids);
      return ids;
    },
  ),
};
