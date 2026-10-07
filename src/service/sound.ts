import { z } from 'zod';
import path from 'node:path';
import { readFile, stat } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import {
  soundDocumentSchema,
  soundTrackSchema,
  soundEventSchema,
  type AudioPluginConfig,
  type SoundEffect,
} from '../core/sound-schema.js';
import { compileSound, soundPresets, noteNumber, SOUND_RATE } from '../core/sound.js';
import { importSoundMidi, exportSoundMidi } from '../core/sound-midi.js';
import {
  VmotionError,
  assetSchema,
  clipSchema,
  trackSchema,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { applyOperations } from './operations.js';
import { hash, json, safePath, atomicWrite, validateSnapshot } from './project.js';
import { storeAgentPlan } from './agent-plans.js';
import { soundDependencies, soundResource, soundRange } from '../media/sound-source.js';
import { audioMetrics } from '../media/audio-preview.js';
import { pcmWave } from '../media/audio.js';
import { atomicCopy } from '../platform/project-files.js';
import { audioSourceFile } from '../media/sound-source.js';
import { pluginConfigs, pluginFingerprint } from '../media/audio-plugin-host.js';
const id = z.string().min(1).max(160),
  n = z.number().finite();
const actionSchema = z.discriminatedUnion('type', [
  z
    .object({
      type: z.literal('settings'),
      patch: soundDocumentSchema
        .omit({ kind: true, version: true, id: true, tracks: true })
        .partial(),
    })
    .strict(),
  z.object({ type: z.literal('upsertTrack'), track: soundTrackSchema }).strict(),
  z
    .object({
      type: z.literal('updateTrack'),
      trackId: id,
      patch: soundTrackSchema.omit({ id: true, events: true }).partial(),
    })
    .strict(),
  z.object({ type: z.literal('removeTrack'), trackId: id }).strict(),
  z
    .object({
      type: z.literal('upsertEvents'),
      trackId: id,
      events: z.array(soundEventSchema).min(1).max(20000),
    })
    .strict(),
  z
    .object({
      type: z.literal('removeEvents'),
      trackId: id,
      eventIds: z.array(id).min(1).max(20000),
    })
    .strict(),
  z
    .object({
      type: z.literal('transformEvents'),
      trackId: id,
      eventIds: z.array(id).max(20000).optional(),
      offset: n.default(0),
      timeScale: n.positive().max(100).default(1),
      transpose: n.min(-127).max(127).default(0),
      velocityScale: n.min(0).max(10).default(1),
      quantize: n.positive().optional(),
      duplicate: z.boolean().default(false),
    })
    .strict(),
]);
export const soundPlanSchema = z
  .object({
    revision: z.string().optional(),
    items: z
      .array(
        z
          .object({
            assetId: id,
            source: z.string().optional(),
            expectedHash: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
            document: soundDocumentSchema.optional(),
            actions: z.array(actionSchema).max(1000).default([]),
            placement: z
              .object({
                sequenceId: id.optional(),
                trackId: id,
                start: z.number().int().nonnegative().default(0),
                duration: z.number().int().positive().optional(),
                createTrack: z.string().optional(),
                fadeIn: z.number().int().nonnegative().default(0),
                fadeOut: z.number().int().nonnegative().default(0),
                volume: n.min(0).max(4).default(1),
              })
              .strict()
              .optional(),
          })
          .strict(),
      )
      .min(1)
      .max(16),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export const soundInspectSchema = z
  .object({
    assetId: id,
    includeDocument: z.boolean().default(false),
    trackIds: z.array(id).max(64).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(200).default(50),
  })
  .strict();
export const soundPreviewSchema = z
  .object({
    assetId: id,
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    startSample: z.number().int().nonnegative().default(0),
    sampleCount: z
      .number()
      .int()
      .min(1)
      .max(SOUND_RATE * 10)
      .default(SOUND_RATE * 4),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export const soundMidiSchema = z
  .object({
    action: z.enum(['import', 'export']),
    input: z.string().optional(),
    output: z.string().optional(),
    assetId: id,
    name: z.string().optional(),
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    delivery: z.enum(['stored', 'inline']).default('stored'),
  })
  .strict();
export const soundExportSchema = z
  .object({
    assetId: id,
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    output: z.string().optional(),
  })
  .strict();
export const soundLibrarySchema = z
  .object({ preset: z.string().optional(), schemas: z.boolean().default(false) })
  .strict();
export function soundLibrary(raw: unknown) {
  const request = soundLibrarySchema.parse(raw);
  if (request.preset && !Object.hasOwn(soundPresets, request.preset))
    throw new VmotionError('SOUND_PRESET', 'Unknown instrument preset', { preset: request.preset });
  return {
    sampleRate: SOUND_RATE,
    presets: request.preset ? { [request.preset]: soundPresets[request.preset] } : soundPresets,
    instruments: [
      'subtractive synth',
      'FM synth',
      'seeded noise',
      'kick/snare/hat/tom/clap',
      'audio/video sample',
    ],
    effects: [
      'gain',
      'filter (low/highpass, peaking, shelves)',
      'distortion',
      'delay',
      'chorus',
      'reverb',
      'compressor',
      'limiter',
    ],
    authoring: {
      unit: 'beats or seconds',
      tempo: 'piecewise BPM map in quarter-note beats',
      gate: 'event duration excludes instrument release; document tail is explicit',
      samples:
        'sourceIn/sourceDuration in seconds, up to 30 minutes per sample window; disk-paged PCM and band-limited pitch within four octaves of rootNote',
      routing: 'track/bus outputs and post-fader sends form an acyclic graph',
      automation: 'gainDb/pan linear keys in document time',
      review:
        'sound_plan → sound_preview planId → project_preflight → project_apply unchanged → audio_preview/render_start',
      schemas: request.schemas ? ['sound', 'soundInstrument', 'soundEffect'] : undefined,
    },
    limits: {
      durationSeconds: 1800,
      tracks: 64,
      buses: 16,
      events: 20000,
      voicesPerTrack: 256,
      decodedSampleDiskBytes: 2 * 1024 * 1024 * 1024,
      samplePageBytesPerTrack: 256 * 1024,
      effectStateBytes: 64 * 1024 * 1024,
    },
    limitations: [
      'MIDI preserves notes/tempo/sustain on import, not external plugin timbre or effects',
      'Local synth/sampler plus isolated VST3 64-bit (AU on macOS); no microphone recording or AI model calls',
      'External plugin realtime parameters/state/native editors share the local audio host. Offline plugin chains currently require zero declared latency; delay is diagnosed rather than silently shifting tracks. Plugin installation/license and OS are external dependencies.',
    ],
  };
}
export function inspectSound(snapshot: Snapshot, raw: unknown) {
  const request = soundInspectSchema.parse(raw),
    asset = snapshot.project.assets.find((a) => a.id === request.assetId);
  if (!asset) throw new VmotionError('NOT_FOUND', 'Sound asset not found');
  const sound = soundResource(snapshot, asset),
    selected = sound.tracks.filter(
      (t) => !request.trackIds || request.trackIds.includes(t.track.id),
    ),
    events = selected.flatMap((t) =>
      t.events.map((e) => ({
        trackId: t.track.id,
        eventId: e.id,
        at: e.at,
        duration: e.duration,
        note: e.note,
        velocity: e.velocity,
        startSample: e.start,
        endSample: e.end,
        gateSeconds: e.gate,
      })),
    ),
    page = events.slice(request.offset, request.offset + request.limit);
  if (request.trackIds?.some((id) => !sound.tracks.some((t) => t.track.id === id)))
    throw new VmotionError('SOUND_TRACK', 'Selected sound track is missing');
  return {
    revision: snapshot.revision,
    assetId: asset.id,
    source: sound.source,
    hash: sound.hash,
    name: sound.document.name,
    unit: sound.document.unit,
    tempo: sound.clock.segments,
    timeSignature: sound.document.timeSignature,
    duration: sound.duration,
    sampleCount: sound.sampleCount,
    estimatedWork: sound.estimatedWork,
    tracks: selected.map(({ track, enabled, maxVoices }) => ({
      ...track,
      instrument:
        track.instrument.type === 'plugin' ? pluginSummary(track.instrument) : track.instrument,
      effects: track.effects.map(effectSummary),
      events: undefined,
      eventCount: track.events.length,
      enabled,
      maxVoices,
    })),
    buses: sound.document.buses.map((bus) => ({ ...bus, effects: bus.effects.map(effectSummary) })),
    patterns: sound.document.patterns?.map((p) => ({
      id: p.id,
      name: p.name,
      length: p.length,
      channels: p.channels.length,
      eventCount: p.channels.reduce((n, c) => n + c.events.length, 0),
    })),
    arrangement: sound.document.arrangement,
    busOrder: sound.busOrder,
    master: { ...sound.document.master, effects: sound.document.master.effects.map(effectSummary) },
    events: {
      total: events.length,
      offset: request.offset,
      items: page,
      hasMore: request.offset + page.length < events.length,
    },
    ...(request.includeDocument ? { document: sound.document } : {}),
  };
}
function pluginSummary<T extends AudioPluginConfig>(config: T) {
  const { state, controllerState, parameters, ...rest } = config,
    entries = Object.entries(parameters);
  return {
    ...rest,
    parameters: Object.fromEntries(entries.slice(0, 16)),
    parameterCount: entries.length,
    parametersMore: entries.length > 16,
    stateBytes: state?.length ?? 0,
    controllerStateBytes: controllerState?.length ?? 0,
  };
}
function effectSummary(effect: SoundEffect) {
  return effect.type === 'plugin' ? pluginSummary(effect) : effect;
}
export async function planSound(root: string, snapshot: Snapshot, raw: unknown) {
  const request = soundPlanSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before sound planning');
  if (new Set(request.items.map((i) => i.assetId)).size !== request.items.length)
    throw new VmotionError('SOUND_ID', 'Use one ordered action list per sound asset');
  let candidate = structuredClone(snapshot);
  const operations: Operation[] = [],
    resources = [];
  for (const item of request.items) {
    const existing = candidate.project.assets.find((a) => a.id === item.assetId);
    if (existing && !existing.soundSource)
      throw new VmotionError('SOUND_SOURCE', 'Use a new asset ID; existing media is preserved');
    const source =
      item.source ??
      existing?.soundSource ??
      `components/sounds/${encodeURIComponent(item.assetId)}.json`;
    safePath(root, source);
    if (!/^components\/sounds\/.+\.json$/.test(source) || source !== source.replace(/\\/g, '/'))
      throw new VmotionError('SOUND_SOURCE', 'Sound resources belong in components/sounds/*.json');
    if (existing && source !== existing.soundSource)
      throw new VmotionError('SOUND_SOURCE', 'Keep the existing resource path when editing');
    const text = candidate.files[source];
    if (item.expectedHash && hash(text ?? '') !== item.expectedHash)
      throw new VmotionError('FILE_HASH_CONFLICT', 'Sound source changed');
    if (!existing && text !== undefined)
      throw new VmotionError(
        'SOUND_SOURCE',
        'Sound source path already belongs to another resource',
      );
    let document = item.document
      ? structuredClone(item.document)
      : existing
        ? soundResource(candidate, existing).document
        : undefined;
    if (!document)
      throw new VmotionError('SOUND_DOCUMENT', 'Provide a document when creating a sound asset');
    if (document.id !== item.assetId)
      throw new VmotionError('SOUND_ID', 'Sound document ID must equal assetId');
    for (const action of item.actions) {
      if (action.type === 'settings') {
        document = { ...document, ...action.patch };
        continue;
      }
      if (action.type === 'upsertTrack') {
        const index = document.tracks.findIndex((t) => t.id === action.track.id);
        if (index < 0) document.tracks.push(action.track);
        else document.tracks[index] = action.track;
        continue;
      }
      const track = document.tracks.find((t) => t.id === action.trackId);
      if (!track)
        throw new VmotionError('SOUND_TRACK', 'Sound track not found', { trackId: action.trackId });
      switch (action.type) {
        case 'updateTrack':
          Object.assign(track, action.patch);
          break;
        case 'removeTrack':
          document.tracks = document.tracks.filter((t) => t.id !== action.trackId);
          break;
        case 'upsertEvents':
          for (const event of action.events) {
            const i = track.events.findIndex((e) => e.id === event.id);
            if (i < 0) track.events.push(event);
            else track.events[i] = event;
          }
          break;
        case 'removeEvents':
          if (action.eventIds.some((id) => !track.events.some((e) => e.id === id)))
            throw new VmotionError('SOUND_EVENT', 'Requested event is missing');
          track.events = track.events.filter((e) => !action.eventIds.includes(e.id));
          break;
        case 'transformEvents': {
          if (action.eventIds?.some((id) => !track.events.some((e) => e.id === id)))
            throw new VmotionError('SOUND_EVENT', 'Requested event is missing');
          const next = track.events
            .filter((e) => !action.eventIds || action.eventIds.includes(e.id))
            .map((e) => ({
              ...e,
              id: action.duplicate ? randomUUID() : e.id,
              at: action.quantize
                ? Math.round((e.at * action.timeScale + action.offset) / action.quantize) *
                  action.quantize
                : e.at * action.timeScale + action.offset,
              duration: e.duration * action.timeScale,
              note: noteNumber(e.note) + action.transpose,
              ...(e.endNote === undefined
                ? {}
                : { endNote: noteNumber(e.endNote) + action.transpose }),
              velocity: Math.min(1, e.velocity * action.velocityScale),
            }));
          track.events = action.duplicate
            ? [...track.events, ...next]
            : track.events.map((e) => next.find((n) => n.id === e.id) ?? e);
          break;
        }
      }
    }
    document = compileSound(document).document;
    for (const config of pluginConfigs(document))
      config.fingerprint = await pluginFingerprint(config);
    const asset = assetSchema.parse({
        id: item.assetId,
        name: document.name,
        type: 'audio',
        path: source,
        soundSource: source,
        managed: true,
        metadata: {
          duration: compileSound(document).duration,
          sampleRate: SOUND_RATE,
          channels: 2,
          hasAudio: true,
        },
      }),
      step: Operation[] = [
        {
          type: 'editFiles',
          edits: [
            {
              type: 'replace',
              path: source,
              content: json(document),
              expectedHash: text === undefined ? null : hash(text),
            },
          ],
        },
      ];
    if (existing)
      step.push({
        type: 'updateProject',
        patch: { assets: candidate.project.assets.map((a) => (a.id === asset.id ? asset : a)) },
      });
    else step.push({ type: 'addAsset', asset });
    if (item.placement) {
      const p = item.placement,
        sequenceId = p.sequenceId ?? candidate.project.activeSequence,
        seq = candidate.sequences.find((s) => s.id === sequenceId);
      if (!seq) throw new VmotionError('MISSING_SEQUENCE', 'Placement sequence not found');
      let track = seq.tracks.find((t) => t.id === p.trackId);
      if (track?.locked) throw new VmotionError('TRACK_LOCKED', 'Sound placement track is locked');
      if (!track) {
        if (!p.createTrack)
          throw new VmotionError(
            'SOUND_TRACK',
            'Choose an existing audio track or explicitly createTrack',
          );
        track = trackSchema.parse({ id: p.trackId, name: p.createTrack, type: 'audio', clips: [] });
        step.push({ type: 'addTrack', sequenceId, track });
      }
      if (track.type !== 'audio')
        throw new VmotionError('TRACK_TYPE', 'Sound placement requires an audio track');
      const duration =
          p.duration ??
          Math.ceil(
            (Number(asset.metadata.duration) * candidate.project.fps.num) /
              candidate.project.fps.den,
          ),
        end = p.start + duration;
      if (end > seq.duration)
        throw new VmotionError(
          'SOUND_RANGE',
          'Sound placement extends beyond the sequence; extend it explicitly before planning',
          { end, sequenceDuration: seq.duration },
        );
      step.push({
        type: 'addClip',
        sequenceId,
        trackId: p.trackId,
        clip: clipSchema.parse({
          id: randomUUID(),
          name: document.name,
          assetId: asset.id,
          start: p.start,
          duration,
          volume: p.volume,
          fadeIn: p.fadeIn,
          fadeOut: p.fadeOut,
        }),
      });
    }
    operations.push(...step);
    candidate = applyOperations(root, candidate, step);
    resources.push({
      assetId: asset.id,
      source,
      hash: hash(json(document)),
      duration: Number(asset.metadata.duration),
      tracks: document.tracks.length,
      events: compileSound(document).eventCount,
    });
  }
  const diagnostics = await validateSnapshot(root, candidate);
  if (diagnostics.some((d) => d.severity === 'error'))
    throw new VmotionError('VALIDATION_FAILED', 'Sound candidate is invalid', diagnostics);
  const checks = (
      await Promise.all(
        resources.map((r) =>
          soundDependencies(
            root,
            candidate,
            candidate.project.assets.find((a) => a.id === r.assetId)!,
          ),
        ),
      )
    ).flatMap((d) => d.checks),
    assetChecks = [...new Map(checks.map((c) => [c.assetId, c])).values()],
    input = {
      revision: snapshot.revision,
      operations,
      assetChecks,
      samples: [],
      determinism: true,
    },
    stored = request.delivery === 'stored' ? await storeAgentPlan(root, input) : undefined;
  return {
    baseRevision: snapshot.revision,
    candidateRevision: candidate.revision,
    resources,
    assetChecks,
    ...(stored ? { plan: stored } : {}),
    candidate: stored ? { planId: stored.planId } : input,
    apply: {
      ...(stored ? { planId: stored.planId } : input),
      expectedCandidateRevision: candidate.revision,
    },
    review:
      'Use sound_preview with this planId to audition the exact candidate before project_apply. project_preflight validates structure/code; audio review is separate.',
  };
}
export async function previewSound(root: string, snapshot: Snapshot, raw: unknown) {
  const request = soundPreviewSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before sound audition');
  const asset = snapshot.project.assets.find((a) => a.id === request.assetId);
  if (!asset?.soundSource) throw new VmotionError('SOUND_SOURCE', 'Choose an editable sound asset');
  const result = await soundRange(root, snapshot, asset, request.startSample, request.sampleCount),
    output = path.resolve(
      request.output ??
        safePath(
          root,
          `.vmotion/sound-preview/${snapshot.revision}-${asset.id.replace(/[^\w-]/g, '_')}-${request.startSample}.wav`,
        ),
    ),
    wave = pcmWave(result.buffer);
  await atomicWrite(output, wave);
  return {
    revision: snapshot.revision,
    assetId: asset.id,
    output,
    startSample: request.startSample,
    sampleCount: result.sampleCount,
    sampleRate: result.sampleRate,
    channels: 2,
    duration: result.duration,
    metrics: audioMetrics(result.buffer),
    fullMix: result.report,
    warnings:
      result.report.peak > 1
        ? [
            'The sound master exceeds digital full scale; reduce gain or add a limiter before export',
          ]
        : [],
    mimeType: 'audio/wav',
    ...(request.inline ? { data: wave.toString('base64') } : {}),
  };
}
export async function soundMidi(root: string, snapshot: Snapshot, raw: unknown) {
  const request = soundMidiSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before MIDI operation');
  if (request.action === 'import') {
    if (!request.input) throw new VmotionError('MIDI_INPUT', 'Choose an input MIDI file');
    const midi = importSoundMidi(await readFile(path.resolve(request.input)), {
        id: request.assetId,
        name: request.name ?? path.basename(request.input),
      }),
      plan = await planSound(root, snapshot, {
        revision: snapshot.revision,
        delivery: request.delivery,
        items: [{ assetId: request.assetId, document: midi.document }],
      });
    return {
      ...plan,
      midi: { format: midi.format, ppq: midi.ppq, notes: midi.notes, warnings: midi.warnings },
    };
  }
  if (!request.output) throw new VmotionError('MIDI_OUTPUT', 'Choose an output MIDI file');
  const asset = snapshot.project.assets.find((a) => a.id === request.assetId);
  if (!asset) throw new VmotionError('NOT_FOUND', 'Sound asset not found');
  const midi = exportSoundMidi(soundResource(snapshot, asset).document),
    output = path.resolve(request.output);
  await atomicWrite(output, Buffer.from(midi.data));
  return {
    revision: snapshot.revision,
    assetId: asset.id,
    output,
    format: 1,
    ppq: midi.ppq,
    bytes: midi.data.length,
    warnings: midi.warnings,
  };
}

/** Full-score export shares the audition cache and retains DSP history and tails. */
export async function exportSound(root: string, snapshot: Snapshot, raw: unknown) {
  const request = soundExportSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project changed before sound export');
  const asset = snapshot.project.assets.find((a) => a.id === request.assetId);
  if (!asset?.soundSource) throw new VmotionError('SOUND_SOURCE', 'Choose an editable sound asset');
  const output = path.resolve(
    request.output ?? safePath(root, `exports/${encodeURIComponent(asset.id)}.wav`),
  );
  if (path.extname(output).toLowerCase() !== '.wav')
    throw new VmotionError('SOUND_OUTPUT', 'Sound export requires a .wav filename');
  const normalized = (file: string) => path.resolve(file).toLowerCase();
  if (
    [...Object.keys(snapshot.files), ...snapshot.project.assets.map((a) => a.path)].some(
      (file) => normalized(path.resolve(root, file)) === normalized(output),
    )
  )
    throw new VmotionError(
      'SOUND_OUTPUT',
      'Export cannot overwrite project source or registered media',
    );
  const source = await audioSourceFile(root, snapshot, asset);
  await atomicCopy(source, output);
  const report: unknown = JSON.parse(await readFile(source + '.json', 'utf8'));
  const metrics = z
    .object({ peak: n, rms: n, sampleCount: n, clippedSampleRatio: n })
    .parse(report);
  return {
    revision: snapshot.revision,
    assetId: asset.id,
    output,
    bytes: (await stat(output)).size,
    sampleRate: SOUND_RATE,
    channels: 2,
    duration: metrics.sampleCount / SOUND_RATE,
    metrics,
    mimeType: 'audio/wav',
    playbackUrl: `/api/sound-audio?key=${path.basename(source, '.wav')}`,
    warnings:
      metrics.peak > 1 ? ['Master exceeds digital full scale; reduce gain or add a limiter.'] : [],
  };
}
