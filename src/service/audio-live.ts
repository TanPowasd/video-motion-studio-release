import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { audioPluginSchema, type AudioPluginConfig } from '../core/sound-schema.js';
import { VmotionError } from '../core/model.js';
import { AudioPluginHost, scanAudioPlugins } from '../media/audio-plugin-host.js';

export const audioPluginsSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('scan'),
      paths: z.array(z.string()).max(16).optional(),
      format: z.enum(['vst3', 'au']).default('vst3'),
    })
    .strict(),
  z.object({ action: z.literal('inspect'), config: audioPluginSchema }).strict(),
]);
const session = z.string().uuid();
export const audioLiveSchema = z.discriminatedUnion('action', [
  z
    .object({
      action: z.literal('open'),
      config: audioPluginSchema,
      blockSize: z.number().int().min(64).max(2048).default(1024),
      sampleRate: z.number().int().min(8000).max(192000).default(48000),
    })
    .strict(),
  z.object({ action: z.literal('state'), sessionId: session }).strict(),
  z
    .object({ action: z.literal('editor'), sessionId: session, show: z.boolean().default(true) })
    .strict(),
  z
    .object({
      action: z.literal('parameters'),
      sessionId: session,
      values: z.record(z.string().regex(/^\d+$/), z.number().min(0).max(1)),
    })
    .strict(),
  z.object({ action: z.literal('panic'), sessionId: session }).strict(),
  z.object({ action: z.literal('close'), sessionId: session }).strict(),
  z.object({ action: z.literal('query') }).strict(),
]);
export const liveBlockSchema = z
  .object({
    frames: z.number().int().min(64).max(2048),
    midi: z
      .array(
        z
          .object({
            status: z.number().int().min(128).max(239),
            a: z.number().int().min(0).max(127),
            b: z.number().int().min(0).max(127),
            offset: z.number().int().min(0).max(2047).default(0),
          })
          .strict(),
      )
      .max(1024)
      .default([]),
    bpm: z.number().min(20).max(400).default(120),
    beat: z.number().finite().default(0),
  })
  .strict();
type LiveSession = {
  host: AudioPluginHost;
  config: AudioPluginConfig;
  description: Awaited<ReturnType<AudioPluginHost['open']>>;
  blockSize: number;
  rate: number;
  position: number;
  touched: number;
  busy: boolean;
  parameters: Record<string, number>;
  panic: boolean;
  blocks: number;
};
export class AudioLiveService {
  private sessions = new Map<string, LiveSession>();
  private opening = new Set<AudioPluginHost>();
  private closed = false;
  private timer = setInterval(() => {
    for (const [id, s] of this.sessions)
      if (!s.busy && Date.now() - s.touched > 30000) void this.closeSession(id);
  }, 5000);
  constructor() {
    this.timer.unref();
  }
  async plugins(raw: unknown) {
    const r = audioPluginsSchema.parse(raw);
    if (r.action === 'scan')
      return scanAudioPlugins(
        r.paths ??
          (process.platform === 'win32'
            ? [(process.env.CommonProgramFiles ?? 'C:/Program Files/Common Files') + '/VST3']
            : process.platform === 'darwin'
              ? ['/Library/Audio/Plug-Ins/VST3']
              : ['/usr/lib/vst3']),
        r.format,
      );
    const host = new AudioPluginHost();
    try {
      return {
        description: await host.open(r.config),
        availableFormats: process.platform === 'darwin' ? ['vst3', 'au'] : ['vst3'],
      };
    } finally {
      await host.close();
    }
  }
  private get(id: string) {
    const session = this.sessions.get(id);
    if (!session)
      throw new VmotionError('AUDIO_LIVE_SESSION', 'Live session has closed or expired');
    session.touched = Date.now();
    return session;
  }
  async command(raw: unknown) {
    if (this.closed) throw new VmotionError('AUDIO_LIVE_CLOSED', 'Live audio service is closed');
    const r = audioLiveSchema.parse(raw);
    if (r.action === 'query')
      return {
        sessions: [...this.sessions].map(([sessionId, s]) => ({
          sessionId,
          name: s.description.name,
          position: s.position,
          blocks: s.blocks,
          blockSize: s.blockSize,
          sampleRate: s.rate,
        })),
      };
    if (r.action === 'open') {
      if (this.sessions.size + this.opening.size >= 8)
        throw new VmotionError(
          'AUDIO_LIVE_BUDGET',
          'Close a live session before opening another (maximum 8)',
        );
      const host = new AudioPluginHost();
      this.opening.add(host);
      try {
        const description = await host.open(r.config, true, r.blockSize, r.sampleRate),
          sessionId = randomUUID();
        if (this.closed)
          throw new VmotionError(
            'AUDIO_LIVE_CLOSED',
            'Live audio service closed while opening a plugin',
          );
        this.sessions.set(sessionId, {
          host,
          config: r.config,
          description,
          blockSize: r.blockSize,
          rate: r.sampleRate,
          position: 0,
          touched: Date.now(),
          busy: false,
          parameters: {},
          panic: false,
          blocks: 0,
        });
        return {
          sessionId,
          description,
          blockSize: r.blockSize,
          sampleRate: r.sampleRate,
          endpoint: `/api/music-live/${sessionId}`,
        };
      } catch (e) {
        await host.close();
        throw e;
      } finally {
        this.opening.delete(host);
      }
    }
    const s = this.get(r.sessionId);
    if (r.action === 'close') {
      await this.closeSession(r.sessionId);
      return { closed: true };
    }
    if (r.action === 'state')
      return {
        sessionId: r.sessionId,
        ...(await s.host.state()),
        description: await s.host.describe(),
      };
    if (r.action === 'parameters') {
      Object.assign(s.parameters, r.values);
      return { queued: true };
    }
    if (r.action === 'panic') {
      s.panic = true;
      return { queued: true };
    }
    await s.host.request('editor', { show: r.show });
    return { visible: r.show };
  }
  async block(sessionId: string, raw: unknown) {
    const r = liveBlockSchema.parse(raw),
      s = this.get(sessionId);
    if (s.busy) throw new VmotionError('AUDIO_LIVE_BUSY', 'One in-flight audio block per session');
    if (r.frames > s.blockSize || r.midi.some((e) => e.offset >= r.frames))
      throw new VmotionError('AUDIO_LIVE_RANGE', 'Block exceeds session negotiation');
    s.busy = true;
    try {
      const midi = [...r.midi];
      if (s.panic) {
        for (let channel = 0; channel < 16; channel++)
          midi.push({ status: 176 + channel, a: 123, b: 0, offset: 0 });
        s.panic = false;
      }
      const parameters = s.parameters;
      s.parameters = {};
      const pcm = await s.host.process(
        r.frames,
        s.position,
        midi,
        undefined,
        { bpm: r.bpm, beat: r.beat },
        parameters,
      );
      s.position += r.frames;
      s.blocks++;
      return pcm;
    } catch (e) {
      await this.closeSession(sessionId);
      throw e;
    } finally {
      s.busy = false;
    }
  }
  private async closeSession(id: string) {
    const s = this.sessions.get(id);
    this.sessions.delete(id);
    await s?.host.close();
  }
  async close() {
    this.closed = true;
    clearInterval(this.timer);
    await Promise.all(
      [...this.sessions.keys()]
        .map((id) => this.closeSession(id))
        .concat([...this.opening].map((host) => host.close())),
    );
  }
}
