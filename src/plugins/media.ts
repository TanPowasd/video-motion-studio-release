import { loadImage } from '@napi-rs/canvas';
import path from 'node:path';
import { z } from 'zod';
import { contextFramesSchema } from '../core/content-time.js';
import { VmotionError } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { importArtwork } from '../media/artwork.js';
import { probe } from '../media/ffmpeg.js';
import { audioSourceFile } from '../media/sound-source.js';
import { placeAsset } from '../service/assets.js';
import { assetQuerySchema, queryAssets } from '../service/library-query.js';
import {
  inspectMedia,
  mediaInspectSchema,
  mediaSampleSchema,
  sampleMedia,
} from '../service/media-evidence.js';
import {
  mediaProxySchema,
  mediaRelinkSchema,
  mediaStatus,
  mediaStatusSchema,
  planMediaRelink,
  proxyOperation,
} from '../service/media-management.js';
import { atomicWrite, collectAssets, safePath } from '../service/project.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginModule } from './types.js';

export const mediaPlugin: BuiltinPluginModule = {
  id: 'vmotion.media',
  name: '素材管理与媒体取证',
  version: '1.0.0',
  methods: new Set([
    'mediaStatus',
    'mediaInspect',
    'mediaSample',
    'mediaRelinkPlan',
    'mediaProxy',
    'assetThumbnail',
    'assetPlace',
    'import',
    'probe',
    'proxy',
    'pack',
    'assetQuery',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'assets_query',
        method: 'assetQuery',
        schema: assetQuerySchema.shape,
        description:
          'Read compact paged registered assets by IDs/type/name/managed status, with dimensions/duration and editable hints. Defaults to 24 items without source paths/full metadata. detail=true reads selected full records; media_status checks actual availability. Does not repeat image/audio data or edit files.',
        categories: ['media'],
        keywords: '素材 资源 目录 分页 查找 库 asset search library',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'media_relink_plan',
        method: 'mediaRelinkPlan',
        schema: mediaRelinkSchema.shape,
        description:
          'Relink image/video/audio assets to explicit existing files by reference while preserving stable IDs, scene/clip references and one atomic undo. Compatible policy checks registered dimensions/streams/duration; replace is explicit and rejects shorter existing timeline uses. Returns stored exact preflight/apply candidate with freshly probed metadata and new-file fingerprints; no files are moved or overwritten.',

        categories: ['media', 'recovery'],
        keywords: '素材 媒体 重新链接 修复 丢失 文件 路径 替换 批量',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'media_proxy',
        method: 'mediaProxy',
        schema: mediaProxySchema.shape,
        description:
          'Start/query/cancel bounded background proxy tasks or inspect cached readiness. Proxies are lossless FFV1, intra frames, project rational FPS, no audio, and source-fingerprint checked before atomic publication. Preview auto mode uses matching proxies and screen-sized decode; exports/native evidence use originals. Eight pending tasks and source/version limits are explicit.',

        categories: ['media'],
        keywords: '素材 代理 视频 性能 预览 生成 取消 进度',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'asset_thumbnail',
        description:
          'Get a visual thumbnail of an image, video or drawing asset, including legacy drawings. Returns an image for direct agent inspection.',
        method: 'assetThumbnail',
        schema: {
          assetId: z.string(),
          width: z.number().int().min(16).max(512).default(160),
          height: z.number().int().min(16).max(512).default(100),
          output: z.string().optional(),
        },

        categories: ['media'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'asset_place',
        description:
          'Place a visual asset in a scene/group/component, or place visual/audio assets on sequence tracks. Shares the editor command and atomic undo history.',
        method: 'assetPlace',
        schema: {
          assetId: z.string(),
          sceneId: z.string().optional(),
          path: z.array(z.string()).max(32).optional(),
          contextFrames: contextFramesSchema.optional(),
          sequenceId: z.string().optional(),
          trackId: z.string().optional(),
          frame: z.number().nonnegative().optional(),
          duration: z.number().int().positive().optional(),
          x: z.number().finite().optional(),
          y: z.number().finite().optional(),
          width: z.number().positive().optional(),
          height: z.number().positive().optional(),
          anchor: z.enum(['top-left', 'center']).optional(),
          revision: z.string().optional(),
        },

        categories: ['drawing', 'media', 'editing'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'asset_import',
        description: 'Import a local asset by reference or copy.',
        method: 'import',
        schema: {
          path: z.string(),
          type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
          copy: z.boolean().default(false),
        },

        categories: ['media', 'audio'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'asset_probe',
        description: 'Inspect media streams and duration.',
        method: 'probe',
        schema: { assetId: z.string() },

        categories: ['media'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'asset_proxy',
        description:
          'Legacy synchronous 960px lossless FFV1 proxy generation/reuse with registered source/FPS checks. For background progress/cancellation, use media_proxy. Proxy preview is explicit; native evidence and export keep originals.',
        method: 'proxy',
        schema: { assetId: z.string() },

        categories: ['media'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'project_pack',
        description: 'Collect project source, assets and fonts into another directory.',
        method: 'pack',
        schema: { output: z.string() },

        categories: ['media', 'render'],
        keywords: '',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'media_status',
        method: 'mediaStatus',
        schema: mediaStatusSchema.shape,
        description:
          'Inspect paged asset availability, registered metadata and ready/stale proxies without dumping project source. Missing files remain identified by stable IDs for relink candidates.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media'],
        keywords: '素材 媒体 缺失 代理 状态 文件',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'media_inspect',
        method: 'mediaInspect',
        schema: mediaInspectSchema.shape,
        description:
          'Probe actual source metadata, dimensions, audio streams, project-frame range and fingerprint. Return asset evidence for checked planning and commits.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media', 'editing'],
        keywords: '素材 视频 音频 图片 元数据 时长 指纹',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'media_sample',
        method: 'mediaSample',
        schema: mediaSampleSchema.omit({ inline: true }).shape,
        description:
          'Inspect video/image/drawing source frames before editing. Returns bounded native contact images, source-frame units, pixel hashes and asset evidence without changing the project.',
        plugin: { id: 'vmotion.media', version: '1.0.0', origin: 'builtin' as const },
        categories: ['media', 'editing'],
        keywords: '素材 取证 帧 采样 接触表 图片 视频',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host, method, params: unknown) {
    return invokeRpcHandler(mediaRpcHandlers, host, method, params);
  },
};

export const mediaRpcHandlers = {
  assetQuery: defineRpcHandler(
    z.object(assetQuerySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'assetQuery';
      const { root, snapshot } = host;
      return queryAssets(snapshot, params);
    },
  ),
  mediaRelinkPlan: defineRpcHandler(
    z.object(mediaRelinkSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'mediaRelinkPlan';
      const { root, snapshot } = host;
      return planMediaRelink(root, structuredClone(snapshot), params);
    },
  ),
  mediaProxy: defineRpcHandler(
    z.object(mediaProxySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'mediaProxy';
      const { root, snapshot } = host;
      const p = mediaProxySchema.parse(params);
      if (p.revision && p.revision !== snapshot.revision)
        throw new VmotionError('REVISION_CONFLICT', 'Project changed before proxy operation');
      if (p.action === 'release') return host.releaseMedia();
      return proxyOperation(root, snapshot, host.proxies, p);
    },
  ),
  assetThumbnail: defineRpcHandler(
    z
      .object({
        assetId: z.string(),
        width: z.number().int().min(16).max(512).default(160),
        height: z.number().int().min(16).max(512).default(100),
        output: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'assetThumbnail';
      const { root, snapshot } = host;
      const buffer = await host.thumbnail(params.assetId, params.width, params.height),
        output = path.resolve(
          params.output ?? safePath(root, `.vmotion/frames/asset-${params.assetId}.png`),
        );
      await atomicWrite(output, buffer);
      return {
        output,
        assetId: params.assetId,
        revision: snapshot.revision,
        mimeType: 'image/png',
        ...(params.inline ? { data: buffer.toString('base64') } : {}),
      };
    },
  ),
  assetPlace: defineRpcHandler(
    z
      .object({
        assetId: z.string(),
        sceneId: z.string().optional(),
        path: z.array(z.string()).max(32).optional(),
        contextFrames: contextFramesSchema.optional(),
        sequenceId: z.string().optional(),
        trackId: z.string().optional(),
        frame: z.number().nonnegative().optional(),
        duration: z.number().int().positive().optional(),
        x: z.number().finite().optional(),
        y: z.number().finite().optional(),
        width: z.number().positive().optional(),
        height: z.number().positive().optional(),
        anchor: z.enum(['top-left', 'center']).optional(),
        revision: z.string().optional(),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'assetPlace';
      const { root, snapshot } = host;
      const placement = await placeAsset(host.renderer, snapshot, params),
        state = await host.transact(placement.operations, params.revision ?? snapshot.revision);
      return { ...state, ...placement, operations: undefined };
    },
  ),
  import: defineRpcHandler(
    z
      .object({
        path: z.string(),
        type: z.enum(['image', 'video', 'audio', 'font', 'drawing']),
        copy: z.boolean().default(false),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'import';
      const { root, snapshot } = host;
      if (/\.(psd|ora)$/i.test(params.path)) {
        const artwork = await importArtwork(
            root,
            params.path,
            typeof params.sceneId === 'string' ? params.sceneId : snapshot.scenes[0].id,
          ),
          state = await host.transact(artwork.operations);
        host.reportDiagnostics(
          artwork.warnings.map((message) => ({
            severity: 'warning',
            code: 'ARTWORK_COMPATIBILITY',
            message,
            file: params.path,
          })),
        );
        return {
          ...state,
          warnings: artwork.warnings,
          importedArtwork: {
            assetIds: artwork.operations.flatMap((op) =>
              op.type === 'addAsset' ? [op.asset.id] : [],
            ),
          },
        };
      }
      let metadata: Record<string, unknown> = {};
      if (params.type === 'audio' || params.type === 'video') {
        const info = await probe(path.resolve(params.path)),
          audio = info.streams.find((s) => s.codec_type === 'audio'),
          video = info.streams.find((s) => s.codec_type === 'video'),
          duration = Number(info.format.duration ?? audio?.duration ?? video?.duration);
        if (params.type === 'audio' && !audio)
          throw new VmotionError('NO_AUDIO', 'Selected media has no audio stream');
        if (params.type === 'video' && !video)
          throw new VmotionError('NO_VIDEO', 'Selected media has no video stream');
        metadata = {
          ...(Number.isFinite(duration) && duration > 0 ? { duration } : {}),
          hasAudio: !!audio,
          ...(audio
            ? {
                ...(Number.isFinite(Number(audio.sample_rate))
                  ? { sampleRate: Number(audio.sample_rate) }
                  : {}),
                channels: audio.channels,
              }
            : {}),
          ...(video ? { width: video.width, height: video.height } : {}),
        };
      } else if (params.type === 'image') {
        const image = await loadImage(path.resolve(params.path));
        metadata = { width: image.width, height: image.height };
      }
      return host.importAsset(params.path, params.type, params.copy, metadata);
    },
  ),
  probe: defineRpcHandler(
    z.object({ assetId: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'probe';
      const { root, snapshot } = host;
      const asset = snapshot.project.assets.find((a) => a.id === params.assetId);
      if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
      return probe(await audioSourceFile(root, snapshot, asset));
    },
  ),
  proxy: defineRpcHandler(
    z.object({ assetId: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'proxy';
      const { root, snapshot } = host;
      const job = host.proxies.start(snapshot, params.assetId, 960),
        result = await host.proxies.wait(job.id);
      if (result.status !== 'completed')
        throw new VmotionError('PROXY_PROCESS', result.error ?? 'Proxy generation failed');
      return { output: result.output, jobId: job.id };
    },
  ),
  pack: defineRpcHandler(
    z.object({ output: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'pack';
      const { root, snapshot } = host;
      return collectAssets(root, params.output, snapshot);
    },
  ),
  mediaStatus: defineRpcHandler(
    z.object(mediaStatusSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'mediaStatus';
      const { root, snapshot } = host;
      return mediaStatus(root, snapshot, params);
    },
  ),
  mediaInspect: defineRpcHandler(
    z.object(mediaInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'mediaInspect';
      const { root, snapshot } = host;
      return inspectMedia(root, structuredClone(snapshot), params);
    },
  ),
  mediaSample: defineRpcHandler(
    z
      .object(mediaSampleSchema.omit({ inline: true }).shape)
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'mediaSample';
      const { root, snapshot } = host;
      return sampleMedia(root, structuredClone(snapshot), params);
    },
  ),
};
