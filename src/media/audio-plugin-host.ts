import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import {
  audioPluginSchema,
  type AudioPluginConfig,
  type SoundDocument,
} from '../core/sound-schema.js';
import { compileSound } from '../core/sound.js';
import type { PluginAudioRequest } from '../core/sound-plugin-pipeline.js';
import { fingerprint } from './ffmpeg.js';
export type MidiPacket = { status: number; a: number; b: number; offset: number };
const parameterSchema = z.object({
  id: z.string(),
  name: z.string(),
  unit: z.string(),
  value: z.number(),
  default: z.number(),
  steps: z.number(),
  flags: z.number(),
});
export const pluginDescriptionSchema = z.object({
  format: z.enum(['vst3', 'au']),
  path: z.string(),
  classId: z.string(),
  name: z.string(),
  vendor: z.string(),
  version: z.string(),
  parameters: z.array(parameterSchema).default([]),
  latencySamples: z.number().nonnegative().default(0),
  tailSamples: z.number().nonnegative().default(0),
  restartFlags: z.number().default(0),
  categories: z.array(z.string()).optional(),
  fingerprint: z.string().optional(),
});
export type AudioPluginDescription = z.output<typeof pluginDescriptionSchema>;
export function audioHostBinary() {
  if (process.env.VMOTION_AUDIO_HOST) return path.resolve(process.env.VMOTION_AUDIO_HOST);
  const dir = path.dirname(
    typeof import.meta.url === 'string' && import.meta.url.startsWith('file:')
      ? fileURLToPath(import.meta.url)
      : String(import.meta.url),
  );
  for (const base of [path.resolve(dir, '../native'), path.resolve(dir, '../../dist/native')]) {
    try {
      const manifest: unknown = JSON.parse(readFileSync(path.join(base, 'manifest.json'), 'utf8'));
      const parsed = z.object({ audioExecutable: z.string() }).parse(manifest);
      if (path.basename(parsed.audioExecutable) === parsed.audioExecutable) {
        const binary = path.join(base, parsed.audioExecutable);
        if (existsSync(binary)) return binary;
      }
    } catch {}
  }
  return undefined;
}
const replySchema = z.object({
  id: z.number().int(),
  result: z.unknown().optional(),
  error: z.object({ code: z.string(), message: z.string() }).optional(),
});
export class AudioPluginHost {
  private child?: ChildProcessWithoutNullStreams;
  private pending?: {
    id: number;
    resolve: (value: { result: unknown; pcm: Buffer }) => void;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  };
  private chunks: Buffer[] = [];
  private bytes = 0;
  private sequence = 0;
  private stderr = '';
  private closed = false;
  private queue: Promise<unknown> = Promise.resolve();
  private closing?: Promise<void>;
  constructor(readonly timeoutMs = 15000) {}
  request(op: string, params: Record<string, unknown> = {}, pcm: Buffer = Buffer.alloc(0)) {
    const task = this.queue.then(() => this.send(op, params, pcm));
    this.queue = task.catch(() => {});
    return task;
  }
  private async send(op: string, params: Record<string, unknown>, pcm: Buffer) {
    if (this.closed) throw new VmotionError('AUDIO_PLUGIN_CLOSED', 'Plugin host is closed');
    if (!this.child) this.start();
    const id = ++this.sequence,
      payload = Buffer.from(JSON.stringify({ ...params, op, id }));
    if (payload.length > 8 * 1024 * 1024 || pcm.length > 16384 * 8)
      throw new VmotionError(
        'AUDIO_PLUGIN_BUDGET',
        'Plugin command exceeds binary transport budget',
      );
    const header = Buffer.alloc(8);
    header.writeUInt32LE(payload.length);
    header.writeUInt32LE(pcm.length, 4);
    return new Promise<{ result: unknown; pcm: Buffer }>((resolve, reject) => {
      const timer = setTimeout(() => {
        const error = new VmotionError('AUDIO_PLUGIN_TIMEOUT', 'Plugin stopped responding', {
          op,
          stderr: this.stderr,
        });
        this.fail(error);
        void this.close();
      }, this.timeoutMs);
      this.pending = { id, resolve, reject, timer };
      this.child!.stdin.write(Buffer.concat([header, payload, pcm]), (error) => {
        if (error) this.fail(error);
      });
    });
  }
  private start() {
    const binary = audioHostBinary();
    if (!binary)
      throw new VmotionError(
        'AUDIO_PLUGIN_UNAVAILABLE',
        'Build or install the native audio plugin host',
      );
    this.child = spawn(binary, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.child.on('error', (error) => this.fail(error));
    this.child.stdin.on('error', (error) => this.fail(error));
    this.child.on('close', (code) => {
      this.closed = true;
      this.fail(
        new VmotionError('AUDIO_PLUGIN_EXIT', 'Plugin host exited', { code, stderr: this.stderr }),
      );
    });
    this.child.stderr.on('data', (bytes: Buffer) => {
      this.stderr = (this.stderr + bytes.toString()).slice(-8192);
    });
    this.child.stdout.on('data', (chunk: Buffer) => {
      try {
        this.chunks.push(chunk);
        this.bytes += chunk.length;
        if (this.bytes > 16 * 1024 * 1024) throw new Error('Plugin response exceeds budget');
        if (this.bytes < 8) return;
        const buffer =
          this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks, this.bytes);
        const jsonLength = buffer.readUInt32LE(0),
          pcmLength = buffer.readUInt32LE(4);
        if (jsonLength > 8 * 1024 * 1024 || pcmLength > 16384 * 8)
          throw new Error('Plugin response header exceeds budget');
        const total = 8 + jsonLength + pcmLength;
        if (buffer.length < total) {
          this.chunks = [buffer];
          return;
        }
        if (buffer.length !== total) throw new Error('Unexpected coalesced plugin response');
        const reply = replySchema.parse(JSON.parse(buffer.subarray(8, 8 + jsonLength).toString()));
        const pending = this.pending;
        if (!pending || pending.id !== reply.id) throw new Error('Unexpected plugin response ID');
        clearTimeout(pending.timer);
        this.pending = undefined;
        this.chunks = [];
        this.bytes = 0;
        if (reply.error) pending.reject(new VmotionError(reply.error.code, reply.error.message));
        else
          pending.resolve({
            result: reply.result,
            pcm: Buffer.from(buffer.subarray(8 + jsonLength)),
          });
      } catch (error) {
        this.fail(error as Error);
        void this.close();
      }
    });
  }
  private fail(error: Error) {
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.reject(error);
      this.pending = undefined;
    }
  }
  async open(config: AudioPluginConfig, realtime = false, blockSize = 4096, sampleRate = 48000) {
    if (config.format === 'au' && process.platform !== 'darwin')
      throw new VmotionError('AUDIO_PLUGIN_PLATFORM', 'AU requires macOS');
    await pluginFingerprint(config);
    const { result } = await this.request('open', { ...config, realtime, blockSize, sampleRate });
    return pluginDescriptionSchema.parse(result);
  }
  async process(
    frames: number,
    startSample: number,
    midi: MidiPacket[],
    pcm?: Buffer,
    clock: Record<string, number> = {},
    parameters?: Record<string, number>,
  ) {
    const response = await this.request(
      'process',
      { frames, startSample, midi, parameters, ...clock },
      pcm,
    );
    if (response.pcm.length !== frames * 8)
      throw new VmotionError('AUDIO_PLUGIN_PCM', 'Plugin returned the wrong stereo sample count');
    return response.pcm;
  }
  async state() {
    const { result } = await this.request('state');
    return z
      .object({
        state: z.string(),
        controllerState: z.string().optional(),
        parameters: z.record(z.number()),
      })
      .parse(result);
  }
  async describe() {
    return pluginDescriptionSchema.parse((await this.request('describe')).result);
  }
  async close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.fail(new VmotionError('AUDIO_PLUGIN_CLOSED', 'Plugin host closed'));
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    this.closing = new Promise<void>((resolve) => {
      child.once('close', () => resolve());
      if (process.platform === 'win32' && child.pid) {
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        });
        killer.on('error', () => child.kill());
      } else child.kill('SIGKILL');
    });
    return this.closing;
  }
}
export async function pluginFingerprint(config: AudioPluginConfig) {
  if (config.format === 'au') {
    if (process.platform !== 'darwin')
      throw new VmotionError('AUDIO_PLUGIN_PLATFORM', 'AU requires macOS');
    return `au:${config.classId}:local-os:${process.versions.node}`;
  }
  let binary = path.resolve(config.path),
    info = await stat(binary);
  if (info.isDirectory()) {
    const candidates =
      process.platform === 'win32'
        ? ['Contents/x86_64-win']
        : process.platform === 'darwin'
          ? ['Contents/MacOS']
          : ['Contents/x86_64-linux'];
    let found = false;
    for (const folder of candidates) {
      const entries = await readdir(path.join(binary, folder));
      const name = entries.find(
        (n) => process.platform !== 'win32' || n.toLowerCase().endsWith('.vst3'),
      );
      if (name) {
        binary = path.join(binary, folder, name);
        found = true;
        break;
      }
    }
    if (!found)
      throw new VmotionError('AUDIO_PLUGIN_FILE', 'No matching 64-bit plugin binary in bundle');
  }
  const actual = await fingerprint(binary);
  if (config.fingerprint && config.fingerprint !== actual)
    throw new VmotionError(
      'AUDIO_PLUGIN_CHANGED',
      'Installed plugin differs from the saved fingerprint',
      { path: config.path },
    );
  return actual;
}
export async function scanAudioPlugins(paths: string[], format: 'vst3' | 'au' = 'vst3') {
  if (format === 'au' && process.platform !== 'darwin')
    throw new VmotionError('AUDIO_PLUGIN_PLATFORM', 'AU requires macOS');
  const files = new Set<string>(),
    diagnostics: Array<{ path: string; message: string }> = [];
  if (format === 'vst3') {
    const walk = async (file: string, depth: number) => {
      if (files.size >= 256)
        throw new VmotionError('AUDIO_PLUGIN_SCAN_BUDGET', 'Scan at most 256 plugins per call');
      if (file.toLowerCase().endsWith('.vst3')) {
        files.add(file);
        return;
      }
      if (depth > 5) return;
      for (const entry of await readdir(file, { withFileTypes: true }))
        if (
          !entry.isSymbolicLink() &&
          (entry.isDirectory() || entry.name.toLowerCase().endsWith('.vst3'))
        )
          await walk(path.join(file, entry.name), depth + 1);
    };
    for (const dir of paths)
      try {
        await walk(path.resolve(dir), 0);
      } catch (error) {
        diagnostics.push({ path: dir, message: (error as Error).message });
      }
  } else files.add('au:system');
  const plugins: AudioPluginDescription[] = [];
  for (const file of files) {
    const host = new AudioPluginHost(10000);
    try {
      const response = await host.request('scan', { format, path: file });
      const items = z.array(pluginDescriptionSchema).parse(response.result);
      for (const item of items)
        plugins.push({
          ...item,
          fingerprint: await pluginFingerprint({
            format: item.format,
            path: item.path,
            classId: item.classId,
            parameters: {},
          }),
        });
    } catch (error) {
      diagnostics.push({ path: file, message: (error as Error).message });
    } finally {
      await host.close();
    }
  }
  return {
    platform: process.platform,
    availableFormats: process.platform === 'darwin' ? ['vst3', 'au'] : ['vst3'],
    plugins,
    diagnostics,
    scanned: files.size,
  };
}
export function pluginConfigs(doc: SoundDocument) {
  return [
    ...doc.tracks.flatMap((t) => [
      ...(t.instrument.type === 'plugin' ? [t.instrument] : []),
      ...t.effects.filter((e) => e.type === 'plugin'),
    ]),
    ...doc.buses.flatMap((b) => b.effects.filter((e) => e.type === 'plugin')),
    ...doc.master.effects.filter((e) => e.type === 'plugin'),
  ];
}
export class SoundPluginSession {
  private instances = new Map<string, AudioPluginHost>();
  private schedules = new Map<
    string,
    { events: Array<MidiPacket & { sample: number }>; cursor: number }
  >();
  private compiled: ReturnType<typeof compileSound>;
  constructor(doc: SoundDocument) {
    this.compiled = compileSound(doc);
  }
  readonly process = async (request: PluginAudioRequest) => {
    let host = this.instances.get(request.key);
    if (!host) {
      if (this.instances.size >= 32)
        throw new VmotionError(
          'AUDIO_PLUGIN_BUDGET',
          'At most 32 external plugin instances per score',
        );
      host = new AudioPluginHost();
      this.instances.set(request.key, host);
      const description = await host.open(request.config);
      if (description.latencySamples)
        throw new VmotionError(
          'AUDIO_PLUGIN_LATENCY',
          'Offline plugin latency compensation is not available; use a zero-latency mode or freeze outside the score',
          { key: request.key, latencySamples: description.latencySamples },
        );
    }
    const frames = request.block.left.length,
      end = request.startSample + frames,
      midi: MidiPacket[] = [];
    if (request.kind === 'instrument') {
      const id = request.key.slice('track:'.length, -':instrument'.length),
        track = this.compiled.tracks.find((t) => t.track.id === id)!;
      let schedule = this.schedules.get(request.key);
      if (!schedule) {
        const events: Array<MidiPacket & { sample: number }> = [];
        for (const event of track.events) {
          if (event.velocity === 0) continue;
          const off = event.start + Math.round(event.gate * 48000);
          events.push({
            sample: event.start,
            status: 144,
            a: Math.round(event.note),
            b: Math.round(event.velocity * 127),
            offset: 0,
          });
          events.push({ sample: off, status: 128, a: Math.round(event.note), b: 0, offset: 0 });
        }
        events.sort((a, b) => a.sample - b.sample || a.status - b.status);
        schedule = { events, cursor: 0 };
        this.schedules.set(request.key, schedule);
      }
      while (
        schedule.cursor < schedule.events.length &&
        schedule.events[schedule.cursor].sample < end
      ) {
        const e = schedule.events[schedule.cursor++];
        if (e.sample >= request.startSample)
          midi.push({ status: e.status, a: e.a, b: e.b, offset: e.sample - request.startSample });
      }
    }
    const input = Buffer.allocUnsafe(frames * 8);
    for (let i = 0; i < frames; i++) {
      input.writeFloatLE(request.block.left[i], i * 8);
      input.writeFloatLE(request.block.right[i], i * 8 + 4);
    }
    const beat = this.compiled.clock.secondsBeat(request.startSample / 48000),
      segment = [...this.compiled.clock.segments].reverse().find((s) => s.beat <= beat)!;
    const pcm = await host.process(frames, request.startSample, midi, input, {
      beat,
      bpm: segment.bpm,
      numerator: this.compiled.document.timeSignature[0],
      denominator: this.compiled.document.timeSignature[1],
    });
    const left = new Float64Array(frames),
      right = new Float64Array(frames);
    for (let i = 0; i < frames; i++) {
      left[i] = pcm.readFloatLE(i * 8);
      right[i] = pcm.readFloatLE(i * 8 + 4);
    }
    return { left, right };
  };
  async close() {
    await Promise.all([...this.instances.values()].map((h) => h.close()));
    this.instances.clear();
    this.schedules.clear();
  }
}
