import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from '../core/model.js';
const rate = 48000,
  chunkSamples = rate * 4;
type Status = {
  phase: 'idle' | 'buffering' | 'playing' | 'silent' | 'error';
  message?: string;
  peak: number;
  rms: number;
  bufferedSeconds: number;
};
export function usePlayback(options: {
  snapshot?: Snapshot;
  sequenceId?: string;
  audio: boolean;
  scope: string;
  playing: boolean;
  frame: number;
  duration: number;
  fps: number;
  onFrame: (frame: number) => void;
  onStop: () => void;
}) {
  const [status, setStatus] = useState<Status>({
      phase: 'idle',
      peak: 0,
      rms: 0,
      bufferedSeconds: 0,
    }),
    [clockId, setClockId] = useState(0),
    [muted, setMuted] = useState(false),
    [volume, setVolume] = useState(0.8),
    context = useRef<AudioContext | undefined>(undefined),
    gain = useRef<GainNode | undefined>(undefined),
    optionsRef = useRef(options),
    settings = useRef({ muted, volume }),
    reported = useRef(options.frame),
    restart = useRef<((frame: number) => void) | undefined>(undefined),
    generation = useRef(0),
    cleanup = useRef<(() => void) | undefined>(undefined),
    mounted = useRef(true);
  optionsRef.current = options;
  settings.current = { muted, volume };
  useEffect(() => {
    if (gain.current) gain.current.gain.value = muted ? 0 : volume;
  }, [muted, volume]);
  useEffect(
    () => () => {
      mounted.current = false;
      generation.current++;
      cleanup.current?.();
      void context.current?.close();
    },
    [],
  );
  useEffect(() => {
    if (!options.playing) {
      generation.current++;
      cleanup.current?.();
      cleanup.current = undefined;
      restart.current = undefined;
      reported.current = options.frame;
      setStatus((current) =>
        current.phase === 'error'
          ? current
          : { phase: 'idle', peak: 0, rms: 0, bufferedSeconds: 0 },
      );
      return;
    }
    const start = (frame: number) => {
      const limit = optionsRef.current.duration,
        clamped = Math.max(0, Math.min(limit - 1, Math.floor(frame)));
      if (clamped !== frame) {
        frame = clamped;
        optionsRef.current.onFrame(frame);
      }
      generation.current++;
      cleanup.current?.();
      const token = generation.current,
        active = () => mounted.current && token === generation.current,
        controllers = new Set<AbortController>(),
        sources = new Set<AudioBufferSourceNode>();
      setClockId(token);
      let raf = 0;
      cleanup.current = () => {
        cancelAnimationFrame(raf);
        for (const controller of controllers) controller.abort();
        for (const source of sources) {
          try {
            source.stop();
          } catch {}
          source.disconnect();
        }
        sources.clear();
      };
      reported.current = frame;
      const { snapshot, sequenceId, fps, duration, audio } = optionsRef.current;
      const finish = () => {
        if (!active()) return;
        reported.current = duration - 1;
        optionsRef.current.onFrame(duration - 1);
        optionsRef.current.onStop();
      };
      if (!audio || !snapshot || !sequenceId) {
        const anchor = performance.now();
        setStatus({ phase: 'silent', peak: 0, rms: 0, bufferedSeconds: 0 });
        const tick = () => {
          if (!active()) return;
          const next = frame + Math.floor(((performance.now() - anchor) / 1000) * fps);
          if (next >= duration) {
            finish();
            return;
          }
          if (next !== reported.current) {
            reported.current = next;
            optionsRef.current.onFrame(next);
          }
          raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
        return;
      }
      setStatus({ phase: 'buffering', peak: 0, rms: 0, bufferedSeconds: 0 });
      let audioContext: AudioContext;
      try {
        audioContext = context.current ?? new AudioContext({ sampleRate: rate });
        context.current = audioContext;
      } catch (e) {
        setStatus({
          phase: 'error',
          message: (e as Error).message,
          peak: 0,
          rms: 0,
          bufferedSeconds: 0,
        });
        optionsRef.current.onStop();
        return;
      }
      const monitor = gain.current ?? audioContext.createGain();
      gain.current = monitor;
      monitor.gain.value = settings.current.muted ? 0 : settings.current.volume;
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 1024;
      analyser.connect(monitor);
      monitor.disconnect();
      monitor.connect(audioContext.destination);
      const meter = new Float32Array(analyser.fftSize);
      const sampleAt = (frame: number) =>
          Number(
            (BigInt(Math.trunc(frame)) * BigInt(snapshot.project.fps.den) * BigInt(rate)) /
              BigInt(snapshot.project.fps.num),
          ),
        first = sampleAt(frame),
        total = sampleAt(duration);
      let nextSample = first,
        anchorTime = 0,
        scheduledEnd = 0,
        started = false,
        fetching = false,
        lastStatus = 0,
        error = false;
      const fail = (e: unknown) => {
        if (!active() || (e as Error).name === 'AbortError') return;
        error = true;
        cleanup.current?.();
        setStatus({
          phase: 'error',
          message: (e as Error).message,
          peak: 0,
          rms: 0,
          bufferedSeconds: 0,
        });
        optionsRef.current.onStop();
      };
      const fetchNext = async () => {
        if (!active() || fetching || nextSample >= total) return;
        fetching = true;
        const controller = new AbortController();
        controllers.add(controller);
        try {
          const startSample = nextSample,
            count = Math.min(chunkSamples, total - startSample),
            response = await fetch(
              `/api/audio-chunk?sequence=${encodeURIComponent(sequenceId)}&revision=${snapshot.revision}&start=${startSample}&samples=${count}`,
              { signal: controller.signal },
            );
          if (!response.ok) {
            const result = await response.json();
            throw new Error(result.error?.message ?? '声音预览失败');
          }
          if (
            response.headers.get('X-Vmotion-Revision') !== snapshot.revision ||
            Number(response.headers.get('X-Vmotion-Start-Sample')) !== startSample
          )
            throw new Error('声音预览版本或时间位置不一致');
          const actual = Number(response.headers.get('X-Vmotion-Sample-Count')),
            data = await response.arrayBuffer();
          if (!active()) return;
          if (actual !== count || data.byteLength !== count * 8)
            throw new Error('声音片段长度不一致');
          const buffer = audioContext.createBuffer(2, count, rate),
            view = new DataView(data),
            left = buffer.getChannelData(0),
            right = buffer.getChannelData(1);
          for (let i = 0; i < count; i++) {
            left[i] = view.getFloat32(i * 8, true);
            right[i] = view.getFloat32(i * 8 + 4, true);
          }
          let when = started ? scheduledEnd : audioContext.currentTime + 0.08;
          if (started && when < audioContext.currentTime + 0.02) {
            const delayed = audioContext.currentTime + 0.04 - when;
            anchorTime += delayed;
            when += delayed;
          }
          if (!started) {
            anchorTime = when;
            started = true;
          }
          const source = audioContext.createBufferSource();
          source.buffer = buffer;
          source.connect(analyser);
          sources.add(source);
          source.onended = () => {
            source.disconnect();
            sources.delete(source);
          };
          source.start(when);
          scheduledEnd = when + count / rate;
          nextSample += count;
        } finally {
          fetching = false;
          controllers.delete(controller);
        }
      };
      const tick = () => {
        if (!active() || error) return;
        const time = audioContext.currentTime,
          available = started ? Math.max(0, Math.min(time, scheduledEnd) - anchorTime) : 0,
          next = Math.max(
            reported.current,
            Math.min(duration - 1, frame + Math.floor(available * fps)),
          );
        if (started && next !== reported.current) {
          reported.current = next;
          optionsRef.current.onFrame(next);
        }
        if (started && nextSample >= total && time >= scheduledEnd) {
          finish();
          return;
        }
        if (time - lastStatus > 0.08) {
          lastStatus = time;
          analyser.getFloatTimeDomainData(meter);
          let sum = 0,
            peak = 0;
          for (const sample of meter) {
            sum += sample * sample;
            peak = Math.max(peak, Math.abs(sample));
          }
          setStatus({
            phase: started && time >= anchorTime && time < scheduledEnd ? 'playing' : 'buffering',
            peak,
            rms: Math.sqrt(sum / meter.length),
            bufferedSeconds: Math.max(0, scheduledEnd - time),
          });
        }
        if (!fetching && nextSample < total && (!started || scheduledEnd - time < 4.8))
          void fetchNext().catch(fail);
        raf = requestAnimationFrame(tick);
      };
      const previousCleanup = cleanup.current;
      cleanup.current = () => {
        previousCleanup?.();
        analyser.disconnect();
      };
      void audioContext
        .resume()
        .then(async () => {
          if (!active()) return;
          if (audioContext.state !== 'running') throw new Error('点击播放按钮启用声音');
          await fetchNext();
          if (active()) raf = requestAnimationFrame(tick);
        })
        .catch(fail);
    };
    restart.current = start;
    start(options.frame);
    return () => {
      generation.current++;
      cleanup.current?.();
      cleanup.current = undefined;
    };
  }, [
    options.playing,
    options.snapshot?.revision,
    options.sequenceId,
    options.audio,
    options.scope,
    options.duration,
    options.fps,
  ]);
  useEffect(() => {
    if (options.playing && options.frame !== reported.current) restart.current?.(options.frame);
  }, [options.frame]);
  return { status, muted, volume, setMuted, setVolume, clockId };
}
