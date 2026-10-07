import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { soundDocumentSchema, type SoundDocument } from '../../core/sound-schema.js';
import type { ApplicationState, RpcInput } from '../../service/rpc-contract.js';
import { rpcTyped } from '../state/rpc-client.js';
import { emptyMusicDraft, musicReducer, newMusic, musicUrl } from './music-model.js';

export function useMusic() {
  const [application, setApplication] = useState<ApplicationState>(),
    [draft, dispatch] = useReducer(musicReducer, emptyMusicDraft);
  const [busy, setBusy] = useState(''),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [url, setUrl] = useState(location.hash),
    [baseSource, setBaseSource] = useState<string>();
  const [audio, setAudio] = useState<{
    src: string;
    startSeconds: number;
    peak: number;
    rms: number;
    duration: number;
  }>();
  const [start, setStart] = useState(0),
    [playing, setPlaying] = useState(false);
  const appRef = useRef(application),
    draftRef = useRef(draft),
    audioRef = useRef<HTMLAudioElement>(null);
  appRef.current = application;
  draftRef.current = draft;
  const doc = draft.document,
    dirty = !!doc && JSON.stringify(doc) !== JSON.stringify(draft.saved);
  const routeId = decodeURIComponent(url.split('/music/')[1] ?? '');
  const asset = application?.snapshot.project.assets.find((a) => a.id === doc?.id);
  const conflicted =
    !!asset?.soundSource &&
    baseSource !== undefined &&
    application?.snapshot.files[asset.soundSource] !== baseSource;
  const refresh = useCallback(async () => {
    const next = await rpcTyped('state', {});
    setApplication(next);
    appRef.current = next;
    return next;
  }, []);
  useEffect(() => {
    let live = true;
    const poll = async () => {
      try {
        const next = await rpcTyped('state', {});
        if (live) {
          setApplication(next);
          appRef.current = next;
        }
      } catch (e) {
        if (live) setError((e as Error).message);
      }
    };
    void poll();
    const timer = setInterval(poll, 3000);
    const changed = () => setUrl(location.hash);
    window.addEventListener('hashchange', changed);
    return () => {
      live = false;
      clearInterval(timer);
      window.removeEventListener('hashchange', changed);
    };
  }, []);
  const loaded = useRef('');
  useEffect(() => {
    if (!application) return;
    const key = application.root + ':' + routeId;
    if (loaded.current === key) return;
    loaded.current = key;
    setError('');
    setNotice('');
    setAudio(undefined);
    setPlaying(false);
    setStart(0);
    const existing = application.snapshot.project.assets.find(
      (a) => a.id === routeId && a.soundSource,
    );
    const text = existing?.soundSource
      ? application.snapshot.files[existing.soundSource]
      : undefined;
    try {
      const saved = text ? soundDocumentSchema.parse(JSON.parse(text)) : undefined;
      const cacheKey = 'vmotion-music:' + key;
      let document = saved ?? newMusic(crypto.randomUUID());
      try {
        const cached = sessionStorage.getItem(cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          document = soundDocumentSchema.parse(parsed.document);
          setBaseSource(parsed.baseSource);
        } else setBaseSource(text);
      } catch {
        setBaseSource(text);
      }
      dispatch({ type: 'load', document, saved });
    } catch (e) {
      setError((e as Error).message);
    }
  }, [application, routeId]);
  useEffect(() => {
    if (!application || !doc) return;
    const timer = setTimeout(() => {
      try {
        sessionStorage.setItem(
          'vmotion-music:' + application.root + ':' + routeId,
          JSON.stringify({ document: doc, baseSource }),
        );
      } catch {
        /* Quota limits must not interrupt editing. The current in-memory draft is retained. */
      }
    }, 150);
    return () => clearTimeout(timer);
  }, [doc, baseSource, application?.root, routeId]);
  useEffect(() => {
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    window.addEventListener('beforeunload', unload);
    return () => window.removeEventListener('beforeunload', unload);
  }, [dirty]);
  const edit = useCallback(
    (document: SoundDocument) => {
      if (busy) return;
      audioRef.current?.pause();
      setPlaying(false);
      setAudio(undefined);
      setError('');
      setNotice('');
      dispatch({ type: 'edit', document });
    },
    [busy],
  );
  const task = async (name: string, fn: () => Promise<void>) => {
    if (busy) return;
    setBusy(name);
    setError('');
    setNotice('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy('');
    }
  };
  const plan = async (placement?: RpcInput<'soundPlan'>['items'][number]['placement']) => {
    const current = draftRef.current.document!,
      next = await refresh(),
      existing = next.snapshot.project.assets.find((a) => a.id === current.id);
    if (existing?.soundSource && next.snapshot.files[existing.soundSource] !== baseSource)
      throw new Error('音乐源文件已被其他编辑修改。草稿已保留，请复制 JSON 或重新载入后合并。');
    return rpcTyped('soundPlan', {
      revision: next.snapshot.revision,
      items: [{ assetId: current.id, document: current, placement }],
    });
  };
  const apply = async (candidate: Awaited<ReturnType<typeof plan>>) => {
    const checked = await rpcTyped('projectPreflight', candidate.candidate);
    if (!checked.valid)
      throw new Error(checked.diagnostics.map((d) => d.message).join('\n') || '预检失败');
    const applied = await rpcTyped('projectApply', candidate.apply);
    if (!applied.applied) throw new Error('保存未完成');
    const next = await refresh(),
      current = draftRef.current.document!;
    const source = next.snapshot.project.assets.find((a) => a.id === current.id)?.soundSource;
    setBaseSource(source ? next.snapshot.files[source] : undefined);
    dispatch({ type: 'saved', document: current });
    try {
      sessionStorage.removeItem('vmotion-music:' + next.root + ':' + routeId);
    } catch {}
    if (routeId !== current.id) location.hash = musicUrl(current.id);
  };
  const save = () =>
    task('保存乐曲', async () => {
      await apply(await plan());
      setNotice('乐曲已保存到素材库');
    });
  const audition = (full = false) =>
    task(full ? '渲染整曲' : '生成试听', async () => {
      const candidate = await plan();
      if (!candidate.plan) throw new Error('试听候选未生成');
      if (full) {
        const result = await rpcTyped('soundExport', {
          assetId: doc!.id,
          planId: candidate.plan.planId,
          output:
            application!.root + '/.vmotion/music-player/' + encodeURIComponent(doc!.id) + '.wav',
        });
        setAudio({
          src: result.playbackUrl,
          startSeconds: 0,
          peak: result.metrics.peak,
          rms: result.metrics.rms,
          duration: result.duration,
        });
      } else {
        const result = await rpcTyped('soundPreview', {
          assetId: doc!.id,
          planId: candidate.plan.planId,
          startSample: Math.round(start * 48000),
          sampleCount: 480000,
          inline: true,
        });
        if (!result.data) throw new Error('试听音频缺失');
        setAudio({
          src: `data:audio/wav;base64,${result.data}`,
          startSeconds: start,
          peak: result.metrics.peak,
          rms: result.metrics.rms,
          duration: result.duration,
        });
      }
    });
  const exportWav = () =>
    task('导出 WAV', async () => {
      const candidate = await plan();
      const result = await rpcTyped('soundExport', {
        assetId: doc!.id,
        planId: candidate.plan!.planId,
      });
      setNotice(
        `已导出 ${result.output}（${result.duration.toFixed(2)} 秒）${result.warnings.length ? ' · 存在削波，请调整母带' : ''}`,
      );
      setAudio({
        src: result.playbackUrl,
        startSeconds: 0,
        peak: result.metrics.peak,
        rms: result.metrics.rms,
        duration: result.duration,
      });
    });
  const exportMidi = () =>
    task('导出 MIDI', async () => {
      // MIDI export remains an export of the exact candidate, without an implicit save.
      const candidate = await plan();
      const result = await rpcTyped('soundMidi', {
        action: 'export',
        assetId: doc!.id,
        planId: candidate.plan!.planId,
        output: application!.root + '/exports/' + encodeURIComponent(doc!.id) + '.mid',
      });
      if ('output' in result)
        setNotice(
          `已导出 ${result.output}${result.warnings?.length ? ' · ' + result.warnings.join('；') : ''}`,
        );
    });
  const importMidi = (input: string) =>
    task('导入 MIDI', async () => {
      const result = await rpcTyped('soundMidi', {
        action: 'import',
        input,
        assetId: crypto.randomUUID(),
        revision: appRef.current!.snapshot.revision,
      });
      if (!('candidate' in result)) throw new Error('MIDI 导入未生成候选');
      const checked = await rpcTyped('projectPreflight', result.candidate);
      if (!checked.valid) throw new Error('MIDI 工程预检失败');
      await rpcTyped('projectApply', result.apply);
      await refresh();
      location.hash = musicUrl(result.resources[0].assetId);
    });
  const insert = (trackId: string, startFrame: number) =>
    task('加入视频轨道', async () => {
      const seq = appRef.current!.snapshot.sequences.find(
        (s) => s.id === appRef.current!.snapshot.project.activeSequence,
      )!;
      const candidate = await plan({
        sequenceId: seq.id,
        trackId: trackId || crypto.randomUUID(),
        start: startFrame,
        ...(!trackId ? { createTrack: '音乐' } : {}),
      });
      await apply(candidate);
      setNotice('乐曲与时间轴片段已原子保存，可以在剪辑工作区继续编辑');
    });
  const history = (redo = false) =>
    task(redo ? '重做' : '撤销', async () => {
      if (redo ? draft.future.length : draft.past.length) {
        dispatch({ type: redo ? 'redo' : 'undo' });
        setAudio(undefined);
        audioRef.current?.pause();
        setPlaying(false);
        return;
      }
      if (dirty) return;
      await rpcTyped(redo ? 'redo' : 'undo', {});
      try {
        sessionStorage.removeItem('vmotion-music:' + application!.root + ':' + routeId);
      } catch {}
      loaded.current = '';
      await refresh();
    });
  const reload = () => {
    try {
      sessionStorage.removeItem('vmotion-music:' + application!.root + ':' + routeId);
    } catch {}
    loaded.current = '';
    void refresh();
  };
  const seek = (seconds: number) => {
    setStart(seconds);
    const element = audioRef.current;
    if (!element || !audio) return;
    const local = seconds - audio.startSeconds;
    if (local >= 0 && local <= audio.duration) element.currentTime = local;
    else {
      element.pause();
      setPlaying(false);
      setAudio(undefined);
    }
  };
  return {
    application,
    doc,
    draft,
    dispatch,
    edit,
    busy,
    error,
    notice,
    dirty,
    conflicted,
    audio,
    audioRef,
    start,
    setStart,
    seek,
    playing,
    setPlaying,
    save,
    audition,
    exportWav,
    exportMidi,
    importMidi,
    insert,
    history,
    reload,
    task,
    refresh,
  };
}
