import React, { useState } from 'react';
import { audioPluginSchema, type AudioPluginConfig } from '../../core/sound-schema.js';
import type { AudioPluginDescription } from '../../media/audio-plugin-host.js';
import { rpcTyped } from '../state/rpc-client.js';
import { LiveAudio } from './live-audio.js';
export function PluginPicker({
  config,
  kind,
  onChange,
}: {
  config?: AudioPluginConfig;
  kind: 'instrument' | 'effect';
  onChange: (config: AudioPluginConfig) => void;
}) {
  const [plugins, setPlugins] = useState<AudioPluginDescription[]>([]),
    [path, setPath] = useState(''),
    [format, setFormat] = useState<'vst3' | 'au'>('vst3'),
    [description, setDescription] = useState<AudioPluginDescription>(),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const editor = React.useRef<LiveAudio | undefined>(undefined);
  React.useEffect(
    () => () => {
      void editor.current?.close();
    },
    [],
  );
  const task = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const scan = () =>
    task(async () => {
      const result = await rpcTyped('audioPlugins', {
        action: 'scan',
        paths: path ? [path] : undefined,
        format,
      });
      if (!('plugins' in result)) return;
      setPlugins(result.plugins);
      if (result.diagnostics.length) setError(result.diagnostics.map((d) => d.message).join('；'));
    });
  const inspect = () =>
    task(async () => {
      if (!config) return;
      const result = await rpcTyped('audioPlugins', {
        action: 'inspect',
        config: audioPluginSchema.strip().parse(config),
      });
      if ('description' in result) setDescription(result.description);
    });
  return (
    <div className="music-plugin-picker">
      <h4>{kind === 'instrument' ? 'VST3 / AU 乐器' : 'VST3 / AU 效果'}</h4>
      <select
        aria-label="外部插件格式"
        value={format}
        onChange={(e) => setFormat(e.target.value as 'vst3' | 'au')}
      >
        <option value="vst3">VST3 · 64-bit</option>
        <option value="au">AU · macOS</option>
      </select>
      <input
        aria-label="音频插件扫描路径"
        placeholder="插件文件或目录；留空扫描默认位置"
        value={path}
        onChange={(e) => setPath(e.target.value)}
      />
      <button disabled={busy} onClick={scan}>
        {busy ? '处理中…' : '扫描插件'}
      </button>
      {plugins.length > 0 && (
        <select
          aria-label="选择音频插件"
          value=""
          onChange={(e) => {
            const p = plugins[Number(e.target.value)];
            if (p) {
              onChange(
                audioPluginSchema.parse({
                  format: p.format,
                  path: p.path,
                  classId: p.classId,
                  name: p.name,
                  fingerprint: p.fingerprint,
                  parameters: {},
                }),
              );
              setDescription(undefined);
            }
          }}
        >
          <option value="">选择插件…</option>
          {plugins.map((p, i) => (
            <option key={p.classId} value={i}>
              {p.name} · {p.vendor}
            </option>
          ))}
        </select>
      )}
      {config && (
        <>
          <p className="music-muted">
            {config.name ?? config.classId}
            <br />
            {config.format.toUpperCase()} · 状态{config.state ? '已捕获' : '使用初始音色'}
          </p>
          <button disabled={busy} onClick={inspect}>
            读取参数
          </button>
          <button
            disabled={busy}
            onClick={() =>
              task(async () => {
                await editor.current?.close();
                const host = new LiveAudio();
                editor.current = host;
                await host.start({ ...config, type: 'plugin', release: 0 });
                await host.editor();
              })
            }
          >
            打开插件界面
          </button>
          <button
            disabled={busy || !editor.current?.sessionId}
            onClick={() =>
              task(async () => {
                const state = await editor.current!.state();
                onChange(
                  audioPluginSchema.strip().parse({
                    ...config,
                    state: state.state,
                    controllerState: state.controllerState,
                    parameters: state.parameters,
                  }),
                );
                await editor.current!.close();
                editor.current = undefined;
              })
            }
          >
            捕获音色状态
          </button>
          {description?.parameters.map((p) => (
            <label key={p.id} className="music-plugin-parameter">
              <span>{p.name}</span>
              <input
                aria-label={`插件参数 ${p.name}`}
                type="range"
                min={0}
                max={1}
                step={p.steps ? 1 / p.steps : 0.001}
                value={config.parameters[p.id] ?? p.value}
                onChange={(e) => {
                  const value = Number(e.target.value);
                  onChange({ ...config, parameters: { ...config.parameters, [p.id]: value } });
                  void editor.current?.parameters({ [p.id]: value });
                }}
              />
              <output>{(config.parameters[p.id] ?? p.value).toFixed(3)}</output>
            </label>
          ))}
        </>
      )}
      {error && (
        <p role="alert" className="music-error">
          {error}
        </p>
      )}
    </div>
  );
}
