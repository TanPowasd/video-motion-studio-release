import path from 'node:path';
import { z } from 'zod';
import { audioPluginSchema } from '../core/sound-schema.js';
import { VmotionError, type Snapshot } from '../core/model.js';
import type { ToolDefinition } from '../mcp/catalog.js';
import { analyzeAudio } from '../media/analysis.js';
import { audioMetrics, audioRangeSchema } from '../media/audio-preview.js';
import { AUDIO_SAMPLE_RATE, audioClips, pcmWave, sampleAtFrame } from '../media/audio.js';
import { waveform } from '../media/ffmpeg.js';
import { audioSourceFile } from '../media/sound-source.js';
import {
  audioAuditSchema,
  audioMixInspectSchema,
  audioMixPlanSchema,
  auditAudio,
  inspectAudioMix,
  planAudioMix,
} from '../service/audio-mixing.js';
import { atomicWrite, safePath } from '../service/project.js';
import {
  inspectSound,
  planSound,
  previewSound,
  soundInspectSchema,
  soundLibrary,
  soundLibrarySchema,
  soundMidi,
  soundMidiSchema,
  soundPlanSchema,
  soundPreviewSchema,
  exportSound,
  soundExportSchema,
} from '../service/sound.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import { audioLiveSchema, audioPluginsSchema } from '../service/audio-live.js';
import type { BuiltinPluginHost, BuiltinPluginModule } from './types.js';

export const audioTimelineSchema = z
  .object({
    sequenceId: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(24),
    includeAll: z.boolean().default(false),
  })
  .strict();

export function inspectAudioTimeline(snapshot: Snapshot, raw: unknown) {
  const request = audioTimelineSchema.parse(raw),
    sequenceId = request.sequenceId ?? snapshot.project.activeSequence,
    clips = audioClips(snapshot, sequenceId),
    sequence = snapshot.sequences.find((s) => s.id === sequenceId)!;
  const offset = request.includeAll ? 0 : request.offset,
    page = request.includeAll ? clips : clips.slice(offset, offset + request.limit);
  return {
    revision: snapshot.revision,
    sequenceId,
    sampleRate: AUDIO_SAMPLE_RATE,
    durationSamples: sampleAtFrame(sequence.duration, snapshot.project.fps),
    clips: page.map((clip) => ({
      ...clip,
      asset: {
        id: clip.asset.id,
        name: clip.asset.name,
        type: clip.asset.type,
        path: clip.asset.path,
      },
      startSample: sampleAtFrame(clip.start, snapshot.project.fps),
      endSample: sampleAtFrame(clip.start + clip.duration, snapshot.project.fps),
    })),
    totalClips: clips.length,
    offset,
    returned: page.length,
    nextOffset: offset + page.length < clips.length ? offset + page.length : undefined,
    full: request.includeAll,
  };
}

async function sourceFile(host: BuiltinPluginHost, id: string) {
  const asset = host.snapshot.project.assets.find((asset) => asset.id === id);
  if (!asset) throw new VmotionError('NOT_FOUND', 'Asset not found');
  return audioSourceFile(host.root, host.snapshot, asset);
}

export const audioPlugin: BuiltinPluginModule = {
  id: 'vmotion.audio',
  name: '声音与音乐',
  version: '1.0.0',
  dependencies: { 'vmotion.media': '^1.0.0' },
  methods: new Set([
    'soundLibrary',
    'soundInspect',
    'soundPlan',
    'soundPreview',
    'soundMidi',
    'soundExport',
    'audioPlugins',
    'audioLive',
    'audioMixInspect',
    'audioMixPlan',
    'audioAudit',
    'audioTimeline',
    'audioPreview',
    'waveform',
    'audioAnalyze',
  ]),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'audio_plugins',
        method: 'audioPlugins',
        schema: {
          action: z.enum(['scan', 'inspect']),
          paths: z.array(z.string()).max(16).optional(),
          format: z.enum(['vst3', 'au']).optional(),
          config: audioPluginSchema.optional(),
        },
        description:
          'Discover installed 64-bit VST3 plugins (AU on macOS) in isolated bounded scan processes, or inspect one plugin class and normalized parameters. Binary plugins remain external installations; saved state/parameters belong to the sound document. Explicit paths avoid full-machine scans.',
        categories: ['audio'],
        keywords: 'VST3 AU 插件 乐器 合成器 扫描 参数',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_live',
        method: 'audioLive',
        schema: {
          action: z.enum(['open', 'query', 'state', 'editor', 'parameters', 'panic', 'close']),
          sessionId: z.string().optional(),
          config: audioPluginSchema.optional(),
          blockSize: z.number().int().optional(),
          sampleRate: z.number().int().optional(),
          show: z.boolean().optional(),
          values: z.record(z.number()).optional(),
        },
        description:
          'Manage transient isolated live VST3/AU instrument sessions: open, query, normalized parameters, native editor, saved processor/controller state, all-notes-off and close. No project mutation until returned state is included in sound_plan. Native binary PCM endpoint is for the local music monitor; session idle timeout is 30 seconds. Keep state opt-in.',
        categories: ['audio'],
        keywords: 'MIDI 实时 演奏 插件 界面 状态 panic',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_export',
        method: 'soundExport',
        schema: soundExportSchema.shape,
        description:
          'Export a complete editable score or exact stored candidate as stereo float32 48 kHz WAV, including DSP history and explicit tails. Bounded disk-paged rendering, sample fingerprints and revision checks match audition. Returns path/metrics, never inline Base64. Source assets are protected; does not apply the candidate.',
        categories: ['audio'],
        keywords: '音乐 编曲 音效 完整 导出 WAV 母带 候选',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_mix_inspect',
        method: 'audioMixInspect',
        schema: audioMixInspectSchema.shape,
        description:
          'Inspect timeline track/bus/master routing, effects, gain/pan, sidechain dependencies and normalization settings with selected node IDs and optional full configuration. Declared graph rejects feedback cycles. Ordinary audio preview/export uses the same full-history mix cache.',

        categories: ['audio'],
        keywords: '声音 混音 总线 路由 检查 参数 侧链',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_mix_plan',
        method: 'audioMixPlan',
        schema: audioMixPlanSchema.shape,
        description:
          'Plan multi-sequence track/bus/master mixing, sidechain ducking, gain/pan automation and measured loudness normalization as an exact atomic candidate. Stable track/bus actions, locked-track checks, explicit scratch budgets and source fingerprints preserve safety/undo. Audition audio_preview planId and measure audio_audit before applying unchanged.',

        categories: ['audio'],
        keywords: '声音 音频 混音 侧链 配音 压低 背景 总线 响度 标准化 候选',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_audit',
        method: 'audioAudit',
        schema: audioAuditSchema.shape,
        description:
          'Measure actual sequence or audio/video/sound asset PCM through FFmpeg EBU R128/BS.1770: integrated LUFS, LRA and true peak with profile findings, whole/range coverage and bounded cached evidence. Supports exact stored candidates. Silence/short ranges report uncertainty; encoded lossy deliveries should be audited separately.',

        categories: ['audio'],
        keywords: '声音 质量 检查 LUFS 峰值 true peak 响度 证据',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_library',
        method: 'soundLibrary',
        schema: soundLibrarySchema.shape,
        description:
          'Discover local synth/FM/noise/drum/sample instruments and gain/EQ/distortion/delay/chorus/reverb/compressor/limiter effects, units, budgets and the agent music workflow. No AI calls or external instrument plugins. Full interfaces use project_schema sound/soundInstrument/soundEffect.',

        categories: ['audio'],
        keywords: '音乐 音效 乐器 合成器 采样 鼓组 FM 混响 EQ 压缩',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_inspect',
        method: 'soundInspect',
        schema: soundInspectSchema.shape,
        description:
          'Inspect an editable JSON sound asset: tempo map, duration/sample positions, note events by stable IDs with paging, instruments, automation and acyclic bus/send order. Optional full document for code authoring. Audio rendering and sample evidence use sound_preview.',

        categories: ['audio'],
        keywords: '音乐 音符 编曲 节拍 音效 参数 检查 总线',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_plan',
        method: 'soundPlan',
        schema: soundPlanSchema.shape,
        description:
          'Create or edit multi-track music and sound effects as an exact atomic candidate. Full documents include optional reusable patterns and arrangement clips; stable-ID track/note actions, transpose/quantize/duplicate, synth/FM/noise/drums/audio samples, beat/second clocks, automation, effects and buses remain supported. Optional locked-track-aware timeline placement. Review sound_preview/sound_export planId then preflight/apply unchanged for one undo; sample fingerprints are pinned.',

        categories: ['audio'],
        keywords: '音乐 制作 作曲 编曲 音效 合成 采样 混音 母带 批量 转调 量化',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_preview',
        method: 'soundPreview',
        schema: soundPreviewSchema.shape,
        description:
          'Audition 1–10 seconds of an editable sound asset or a stored candidate without applying it. Renders deterministic stereo 48 kHz from origin, retaining delay/reverb/compressor history when seeking; returns playable WAV, RMS/peak/waveform and full-mix clipping evidence. Project source is preserved, outputs are cache/export files.',

        categories: ['audio'],
        keywords: '音乐 音效 制作 试听 候选 波形 电平 削波',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'sound_midi',
        method: 'soundMidi',
        schema: soundMidiSchema.shape,
        description:
          'Import standard MIDI format 0/1 PPQ as an editable sound candidate, or export notes/tempo to format 1 MIDI. Import supports tempo maps, velocity and sustain; maps GM to local presets and reports unsupported controls/plugins. Export explicitly reports processing/sampling/sweeps omitted from MIDI. Source MIDI is preserved.',

        categories: ['audio'],
        keywords: '音乐 MIDI 导入 导出 音符 速度 力度 延音',
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: false,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_timeline',
        description:
          'Inspect paged audible sequence clips (24 by default), exact sample positions, source trims, nested speeds/volumes and fade envelopes. Muted tracks are excluded. Read totalClips/nextOffset for coverage; includeAll opts into the full timeline.',
        method: 'audioTimeline',
        schema: audioTimelineSchema.shape,

        categories: ['audio'],
        keywords: '',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_preview',
        description:
          'Render up to 10 seconds of the actual sequence audio mix at exact 48 kHz sample positions. Returns playable WAV audio plus waveform levels, RMS, peak and limiter sample ratio; uses the same mixer as export and checks project revision.',
        method: 'audioPreview',
        schema: { ...audioRangeSchema.shape, output: z.string().optional() },

        categories: ['audio'],
        keywords: '声音 音频 试听 混音 电平',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_waveform',
        description: 'Read bounded audio peak samples.',
        method: 'waveform',
        schema: { assetId: z.string() },

        categories: ['audio'],
        keywords: '音频 声音 波形',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'audio_analyze',
        description:
          'Analyze a bounded local audio range (default 60s, maximum 600s) for RMS/peak, low/mid/high frequency bands and estimated onsets/BPM. Beat estimates are heuristic; components receive features through audioAssetId and ctx.audio in cached 30s windows.',
        method: 'audioAnalyze',
        schema: {
          assetId: z.string(),
          rate: z.number().int().min(5).max(60).default(30),
          start: z.number().nonnegative().default(0),
          duration: z.number().positive().max(600).default(60),
        },

        categories: ['audio'],
        keywords: '',
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
    return invokeRpcHandler(audioRpcHandlers, host, method, params);
  },
};

export const audioRpcHandlers = {
  audioPlugins: defineRpcHandler(audioPluginsSchema, (host, params) =>
    host.audioLive.plugins(params),
  ),
  audioLive: defineRpcHandler(audioLiveSchema, (host, params) => host.audioLive.command(params)),
  soundExport: defineRpcHandler(soundExportSchema, async (host, params) => {
    const candidate = await host.candidateSnapshot(params);
    return host.withMediaTask(() =>
      exportSound(host.root, candidate, { ...params, revision: candidate.revision }),
    );
  }),
  audioMixInspect: defineRpcHandler(
    z.object(audioMixInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'audioMixInspect';
      const snapshot = host.snapshot;
      return inspectAudioMix(snapshot, params);
    },
  ),
  audioMixPlan: defineRpcHandler(
    z.object(audioMixPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'audioMixPlan';
      const snapshot = host.snapshot;
      return planAudioMix(host.root, structuredClone(snapshot), params);
    },
  ),
  audioAudit: defineRpcHandler(
    z.object(audioAuditSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'audioAudit';
      const snapshot = host.snapshot;
      const candidate = await host.candidateSnapshot(params);
      return host.withMediaTask(() =>
        auditAudio(host.root, candidate, { ...params, revision: candidate.revision }),
      );
    },
  ),
  soundLibrary: defineRpcHandler(
    z.object(soundLibrarySchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'soundLibrary';
      const snapshot = host.snapshot;
      return soundLibrary(params);
    },
  ),
  soundInspect: defineRpcHandler(
    z.object(soundInspectSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'soundInspect';
      const snapshot = host.snapshot;
      return inspectSound(snapshot, params);
    },
  ),
  soundPlan: defineRpcHandler(
    z.object(soundPlanSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'soundPlan';
      const snapshot = host.snapshot;
      return planSound(host.root, structuredClone(snapshot), params);
    },
  ),
  soundPreview: defineRpcHandler(
    z.object(soundPreviewSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'soundPreview';
      const snapshot = host.snapshot;
      const request = soundPreviewSchema.parse(params),
        candidate = await host.candidateSnapshot(request);
      return host.withMediaTask(() =>
        previewSound(host.root, candidate, { ...request, revision: candidate.revision }),
      );
    },
  ),
  soundMidi: defineRpcHandler(
    z.object(soundMidiSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'soundMidi';
      const snapshot = host.snapshot;
      if (params.action === 'import' && params.planId)
        throw new VmotionError(
          'MIDI_INPUT',
          'Candidate audition applies to MIDI export, not import',
        );
      const candidate =
        params.action === 'export' ? await host.candidateSnapshot(params) : snapshot;
      return soundMidi(host.root, structuredClone(candidate), {
        ...params,
        revision: candidate.revision,
      });
    },
  ),
  audioTimeline: defineRpcHandler(
    z.object(audioTimelineSchema.shape).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'audioTimeline';
      const snapshot = host.snapshot;
      return inspectAudioTimeline(snapshot, params);
    },
  ),
  audioPreview: defineRpcHandler(
    z
      .object({ ...audioRangeSchema.shape, output: z.string().optional() })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'audioPreview';
      const snapshot = host.snapshot;
      const candidate = await host.candidateSnapshot(params),
        { output, inline, planId, ...request } = params;
      return host.withMediaTask(async () => {
        const result = await host.audioPreview.range(candidate, {
            ...request,
            revision: candidate.revision,
          }),
          file = path.resolve(
            output ??
              safePath(
                host.root,
                `.vmotion/audio-preview/${result.revision}-${result.sequenceId}-${result.startSample}.wav`,
              ),
          ),
          buffer = pcmWave(result.buffer),
          metrics = audioMetrics(result.buffer);
        await atomicWrite(file, buffer);
        return {
          output: file,
          revision: result.revision,
          sequenceId: result.sequenceId,
          startSample: result.startSample,
          sampleCount: result.sampleCount,
          sampleRate: result.sampleRate,
          channels: result.channels,
          duration: result.duration,
          clipCount: result.clipCount,
          metrics,
          mimeType: 'audio/wav',
          ...(inline ? { data: buffer.toString('base64') } : {}),
        };
      });
    },
  ),
  waveform: defineRpcHandler(
    z.object({ assetId: z.string() }).extend({ inline: z.boolean().optional() }).passthrough(),
    async (host, params) => {
      const method = 'waveform';
      const snapshot = host.snapshot;
      return host.withMediaTask(async () => waveform(await sourceFile(host, params.assetId)));
    },
  ),
  audioAnalyze: defineRpcHandler(
    z
      .object({
        assetId: z.string(),
        rate: z.number().int().min(5).max(60).default(30),
        start: z.number().nonnegative().default(0),
        duration: z.number().positive().max(600).default(60),
      })
      .extend({ inline: z.boolean().optional() })
      .passthrough(),
    async (host, params) => {
      const method = 'audioAnalyze';
      const snapshot = host.snapshot;
      if (params.duration !== undefined && (params.duration <= 0 || params.duration > 600))
        throw new VmotionError(
          'ANALYSIS_RANGE',
          'Request at most 600 seconds of audio per analysis call',
        );
      return host.withMediaTask(async () => {
        const analysis = await analyzeAudio(await sourceFile(host, params.assetId), {
          rate: params.rate,
          start: params.start,
          duration: params.duration ?? 60,
        });
        return { assetId: params.assetId, ...analysis };
      });
    },
  ),
};
