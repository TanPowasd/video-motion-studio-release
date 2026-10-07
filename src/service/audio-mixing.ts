import { z } from 'zod';
import path from 'node:path';
import { stat, readFile } from 'node:fs/promises';
import {
  audioMixSchema,
  audioTrackMixSchema,
  audioMixBusSchema,
} from '../core/audio-mix-schema.js';
import { compileAudioMix } from '../core/audio-mix.js';
import { VmotionError, type Snapshot, type Operation } from '../core/model.js';
import { applyOperations } from './operations.js';
import { storeAgentPlan } from './agent-plans.js';
import { safePath, hash, json, atomicWrite, validateSnapshot } from './project.js';
import { audioEvidence, prepareSequenceMix, hasAudioMix } from '../media/audio-mix-cache.js';
import { audioSourceFile } from '../media/sound-source.js';
import { measureLoudness } from '../media/audio-loudness.js';
import { fingerprint, probe } from '../media/ffmpeg.js';
const id = z.string().min(1).max(200),
  n = z.number().finite();
export const audioMixInspectSchema = z
  .object({
    sequenceId: id.optional(),
    nodeIds: z.array(id).max(100).optional(),
    includeConfig: z.boolean().default(false),
  })
  .strict();
const actionSchema = z.discriminatedUnion('type', [
  z
    .object({ type: z.literal('track'), trackId: id, patch: audioTrackMixSchema.partial() })
    .strict(),
  z.object({ type: z.literal('bus'), bus: audioMixBusSchema }).strict(),
  z.object({ type: z.literal('removeBus'), busId: id }).strict(),
  z
    .object({
      type: z.literal('master'),
      patch: audioMixSchema.shape.master.removeDefault().partial(),
    })
    .strict(),
  z
    .object({
      type: z.literal('budget'),
      scratchBudgetMb: audioMixSchema.shape.scratchBudgetMb.removeDefault(),
    })
    .strict(),
]);
export const audioMixPlanSchema = z
  .object({
    revision: z.string().optional(),
    items: z
      .array(
        z
          .object({
            sequenceId: id,
            mix: audioMixSchema.nullable().optional(),
            actions: z.array(actionSchema).max(500).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(32),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export const audioAuditSchema = z
  .object({
    source: z
      .object({ type: z.enum(['sequence', 'asset']), id })
      .strict()
      .optional(),
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startSample: z.number().int().nonnegative().default(0),
    sampleCount: z
      .number()
      .int()
      .positive()
      .max(48000 * 7200)
      .optional(),
    profile: z
      .object({
        targetLufs: n.min(-36).max(-5).default(-16),
        toleranceLu: n.min(0.1).max(10).default(1),
        truePeakDb: n.min(-9).max(0).default(-1),
      })
      .strict()
      .default({}),
  })
  .strict();
export function inspectAudioMix(snapshot: Snapshot, raw: unknown) {
  const request = audioMixInspectSchema.parse(raw),
    sequenceId = request.sequenceId ?? snapshot.project.activeSequence,
    sequence = snapshot.sequences.find((s) => s.id === sequenceId);
  if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Mix sequence not found');
  const compiled = compileAudioMix(sequence, snapshot.project.fps),
    nodes = [...compiled.nodes.values()].filter(
      (node) => !request.nodeIds || request.nodeIds.includes(node.key),
    );
  if (request.nodeIds?.some((id) => !compiled.nodes.has(id)))
    throw new VmotionError('AUDIO_MIX_NODE', 'Selected mix node is missing');
  return {
    revision: snapshot.revision,
    sequenceId,
    routed: hasAudioMix(snapshot, sequenceId),
    configured: !!sequence.mix,
    duration: compiled.duration,
    clocks: { sampleRate: 48000, automation: 'seconds' },
    graphOrder: compiled.order,
    nodes: nodes.map((node) => ({
      key: node.key,
      id: node.id,
      type: node.type,
      muted: node.muted,
      gainDb: node.config.gainDb,
      pan: node.config.pan,
      effects: node.config.effects.map((e) => e.type),
      ducking: node.config.ducking,
      dependencies: [...new Set(node.dependencies)],
      routes: node.routes,
    })),
    master: compiled.mix.master,
    stateBytes: compiled.stateBytes,
    scratchBudgetMb: compiled.mix.scratchBudgetMb,
    ...(request.includeConfig ? { mix: compiled.mix } : {}),
  };
}
export async function planAudioMix(root: string, snapshot: Snapshot, raw: unknown) {
  const request = audioMixPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before mixing plan');
  if (new Set(request.items.map((item) => item.sequenceId)).size !== request.items.length)
    throw new VmotionError('AUDIO_MIX_SEQUENCE', 'Use one ordered action list per sequence');
  const operations: Operation[] = [],
    summaries = [];
  let candidate = structuredClone(snapshot);
  for (const item of request.items) {
    const sequence = candidate.sequences.find((s) => s.id === item.sequenceId);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Mix sequence not found');
    if (item.mix === null && item.actions.length)
      throw new VmotionError('AUDIO_MIX_REQUEST', 'Disable a mix or edit it, not both in one item');
    const before = compileAudioMix(sequence, candidate.project.fps),
      config = audioMixSchema.parse(item.mix ?? sequence.mix ?? {});
    for (const action of item.actions)
      switch (action.type) {
        case 'track': {
          if (!sequence.tracks.some((t) => t.id === action.trackId))
            throw new VmotionError('AUDIO_MIX_TRACK', 'Timeline track not found');
          const previous = Object.hasOwn(config.tracks, action.trackId)
            ? config.tracks[action.trackId]
            : audioTrackMixSchema.parse({});
          config.tracks[action.trackId] = audioTrackMixSchema.parse({
            ...previous,
            ...action.patch,
          });
          break;
        }
        case 'bus': {
          const index = config.buses.findIndex((b) => b.id === action.bus.id);
          if (index < 0) config.buses.push(action.bus);
          else config.buses[index] = action.bus;
          break;
        }
        case 'removeBus':
          if (!config.buses.some((b) => b.id === action.busId))
            throw new VmotionError('AUDIO_MIX_BUS', 'Bus not found');
          config.buses = config.buses.filter((b) => b.id !== action.busId);
          break;
        case 'master':
          config.master = { ...config.master, ...action.patch };
          break;
        case 'budget':
          config.scratchBudgetMb = action.scratchBudgetMb;
          break;
      }
    const next = { ...sequence, mix: item.mix === null ? null : config },
      after = compileAudioMix(next, candidate.project.fps);
    for (const track of sequence.tracks.filter((t) => t.locked))
      if (
        json(before.nodes.get(`track:${track.id}`)!.config) !==
        json(after.nodes.get(`track:${track.id}`)!.config)
      )
        throw new VmotionError('TRACK_LOCKED', 'Mix plan changes a locked track', {
          trackId: track.id,
        });
    const operation: Operation = {
      type: 'updateSequence',
      sequenceId: sequence.id,
      patch: { mix: next.mix },
    };
    operations.push(operation);
    candidate = applyOperations(root, candidate, [operation]);
    summaries.push({
      sequenceId: sequence.id,
      enabled: next.mix !== null,
      nodes: after.nodes.size,
      graphOrder: after.order,
      master: after.mix.master,
    });
  }
  const diagnostics = await validateSnapshot(root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Mix candidate is invalid', diagnostics);
  const evidences = await Promise.all(
      request.items.map((i) => audioEvidence(root, candidate, i.sequenceId)),
    ),
    files = new Map(
      evidences.flatMap((e) => e.files.map((f) => [f.path, f.fingerprint] as [string, string])),
    ),
    assetChecks = candidate.project.assets
      .filter((a) => !a.soundSource && files.has(path.resolve(root, a.path)))
      .map((a) => ({ assetId: a.id, fingerprint: files.get(path.resolve(root, a.path))! }));
  if (assetChecks.length > 1000)
    throw new VmotionError(
      'AUDIO_MIX_BUDGET',
      'Candidate source checks exceed 1000 assets; organize sub-sequences into smaller batches',
    );
  const input = { revision: snapshot.revision, operations, assetChecks, samples: [] },
    stored = request.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    sequences: summaries,
    assetChecks,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
    review:
      'Audition audio_preview with planId and run audio_audit on the same candidate; structural preflight is not a loudness or listening check.',
  };
}
export async function auditAudio(root: string, snapshot: Snapshot, raw: unknown) {
  const request = audioAuditSchema.parse(raw),
    source = request.source ?? { type: 'sequence' as const, id: snapshot.project.activeSequence };
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before audio quality audit');
  let file: string, duration: number;
  if (source.type === 'sequence') {
    const sequence = snapshot.sequences.find((s) => s.id === source.id);
    if (!sequence) throw new VmotionError('MISSING_SEQUENCE', 'Audit sequence not found');
    file = await prepareSequenceMix(root, snapshot, source.id);
    duration = (sequence.duration * snapshot.project.fps.den) / snapshot.project.fps.num;
  } else {
    const asset = snapshot.project.assets.find((a) => a.id === source.id);
    if (!asset || !['audio', 'video'].includes(asset.type))
      throw new VmotionError('AUDIO_AUDIT_SOURCE', 'Choose an audio/video/sound asset');
    file = await audioSourceFile(root, snapshot, asset);
    const info = await probe(file);
    if (!info.streams.some((s) => s.codec_type === 'audio'))
      throw new VmotionError('NO_AUDIO', 'Audit asset has no audible stream');
    duration = Number(info.format.duration);
  }
  if (!Number.isFinite(duration) || duration <= 0)
    throw new VmotionError('AUDIO_AUDIT_RANGE', 'Source has no finite audible duration');
  const total = Math.round(duration * 48000),
    count = Math.min(
      request.sampleCount ?? total - request.startSample,
      total - request.startSample,
    );
  if (count < 1)
    throw new VmotionError('AUDIO_AUDIT_RANGE', 'Audit begins beyond the audio source');
  if (count > 48000 * 7200)
    throw new VmotionError('AUDIO_AUDIT_BUDGET', 'Inspect at most two hours per audio audit');
  const before = await fingerprint(file),
    key = hash(
      json({
        engine: 'loudness-audit-1',
        file,
        fingerprint: before,
        start: request.startSample,
        count,
      }),
    ),
    cache = safePath(root, `.vmotion/audio-audit/${key}.json`);
  let measured: Awaited<ReturnType<typeof measureLoudness>>;
  try {
    measured = JSON.parse(await readFile(cache, 'utf8'));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    measured = await measureLoudness(file, {
      startSample: request.startSample,
      sampleCount: count,
    });
    if ((await fingerprint(file)) !== before)
      throw new VmotionError('ASSET_CHANGED', 'Audio changed during loudness audit');
    await atomicWrite(cache, json(measured));
  }
  const m = measured.measurement,
    findings = [];
  if (measured.silentOrTooShort)
    findings.push({
      severity: 'warning',
      code: 'AUDIO_SILENT_OR_SHORT',
      message:
        'Integrated loudness cannot be established for silence or a range shorter than gating windows.',
    });
  else if (Math.abs(m.integratedLufs! - request.profile.targetLufs) > request.profile.toleranceLu)
    findings.push({
      severity: 'warning',
      code: 'AUDIO_LOUDNESS_TARGET',
      measured: m.integratedLufs,
      target: request.profile.targetLufs,
      tolerance: request.profile.toleranceLu,
    });
  if (m.truePeakDb !== null && m.truePeakDb > request.profile.truePeakDb + 0.1)
    findings.push({
      severity: 'warning',
      code: 'AUDIO_TRUE_PEAK',
      measured: m.truePeakDb,
      ceiling: request.profile.truePeakDb,
    });
  return {
    revision: snapshot.revision,
    source,
    startSample: request.startSample,
    sampleCount: count,
    duration: count / 48000,
    sampleRate: 48000,
    measurement: m,
    profile: request.profile,
    engine: measured.engine,
    findings,
    passed: findings.length === 0,
    coverage: { wholeSource: request.startSample === 0 && count === total, totalSamples: total },
    fingerprint: before,
    cacheHash: key,
    limitations: [
      'Measurement is performed on PCM through FFmpeg EBU R128/BS.1770; lossy encoded deliveries should be measured separately.',
      'A clean metric report is not evidence of musical or speech quality.',
    ],
  };
}
