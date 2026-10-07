import React, { useState } from 'react';
import { getNumericPath } from '../../core/time.js';
import type { StudioContext } from './types.js';
import { material3dSchema } from '../../core/material3d-schema.js';
import {
  CandidateActions,
  ColorControl,
  NumberControl,
  PanelIntro,
  SelectControl,
  Toggle,
  VectorControl,
} from './Controls.js';
export default function SpacePanel({ context }: { context: StudioContext }) {
  const [kind, setKind] = useState('box'),
    [size, setSize] = useState(2),
    [color, setColor] = useState('#74b8df'),
    [obj, setObj] = useState(''),
    [mode, setMode] = useState(context.node?.scene3d ? 'edit' : 'create'),
    [draft, setDraft] = useState(
      context.node?.scene3d ? structuredClone(context.node.scene3d) : undefined,
    ),
    [selected, setSelected] = useState(context.node?.scene3d?.instances[0]?.id ?? ''),
    [base] = useState(context.snapshot.revision);
  const instance = draft?.instances.find((i) => i.id === selected),
    material = instance
      ? material3dSchema.parse(instance.material ?? { color: instance.color ?? '#74b8df' })
      : undefined;
  const patch = (value: any) => setDraft((d) => (d ? { ...d, ...value } : d)),
    editInstance = (value: any) =>
      patch({
        instances: draft!.instances.map((i) => (i.id === selected ? { ...i, ...value } : i)),
      });
  return (
    <>
      <PanelIntro title="三维场景">
        创建模型或导入 OBJ，编辑相机、物体变换、材质和灯光。模型与来源文件保持可编辑。
      </PanelIntro>
      <div className="studio-tools">
        <button onClick={() => setMode('create')} className={mode === 'create' ? 'pressed' : ''}>
          创建模型
        </button>
        <button
          disabled={!draft}
          onClick={() => setMode('edit')}
          className={mode === 'edit' ? 'pressed' : ''}
        >
          编辑当前 3D 图层
        </button>
      </div>
      {mode === 'create' ? (
        <>
          <div className="primitive-presets">
            {[
              ['box', '立方体'],
              ['sphere', '球体'],
              ['cylinder', '圆柱'],
              ['cone', '圆锥'],
              ['torus', '圆环'],
              ['plane', '平面'],
              ['obj', 'OBJ 导入'],
            ].map(([id, name]) => (
              <button
                key={id}
                aria-pressed={kind === id}
                className={kind === id ? 'selected' : ''}
                onClick={() => setKind(id)}
              >
                <span className={`primitive-symbol ${id}`}>
                  {id === 'sphere'
                    ? '◯'
                    : id === 'cone'
                      ? '△'
                      : id === 'torus'
                        ? '◎'
                        : id === 'plane'
                          ? '▱'
                          : '◇'}
                </span>
                {name}
              </button>
            ))}
          </div>
          <div className="studio-grid">
            <NumberControl label="模型尺寸" value={size} min={0.01} step={0.1} onChange={setSize} />
            <ColorControl label="模型颜色" value={color} onChange={setColor} />
          </div>
          {kind === 'obj' && (
            <label className="studio-field">
              <span>本地 OBJ 文件路径</span>
              <input
                aria-label="OBJ 文件路径"
                value={obj}
                onChange={(e) => setObj(e.target.value)}
                placeholder="E:\模型\object.obj"
              />
            </label>
          )}
          <CandidateActions
            context={context}
            changeKey={`${kind}:${size}:${color}:${obj}`}
            prepare={() =>
              context.run(kind === 'obj' ? 'meshImport' : 'meshGenerate', {
                revision: base,
                name: kind === 'obj' ? 'OBJ 模型' : kind,
                ...(kind === 'obj'
                  ? { path: obj, normalizeSize: size }
                  : {
                      primitive:
                        kind === 'box'
                          ? { kind, width: size, height: size, depth: size }
                          : kind === 'plane'
                            ? { kind, width: size, depth: size }
                            : kind === 'cylinder' || kind === 'cone'
                              ? { kind, radius: size / 2, height: size }
                              : kind === 'torus'
                                ? { kind, radius: size / 2, tube: size / 6 }
                                : { kind, radius: size / 2 },
                    }),
                place: {
                  sceneId: context.sceneId,
                  path: context.path,
                  contextFrames: context.contextFrames,
                  frame: context.frame,
                  color,
                  width: context.snapshot.project.width,
                  height: context.snapshot.project.height,
                },
              })
            }
          />
        </>
      ) : (
        draft && (
          <>
            <div className="space-layout">
              <section>
                <h3>相机</h3>
                <VectorControl
                  label="相机位置"
                  value={draft.camera.position}
                  onChange={(position) => patch({ camera: { ...draft.camera, position } })}
                />
                <VectorControl
                  label="相机目标"
                  value={draft.camera.target}
                  onChange={(target) => patch({ camera: { ...draft.camera, target } })}
                />
                <SelectControl
                  label="投影方式"
                  value={draft.camera.projection ?? 'perspective'}
                  options={[
                    ['perspective', '透视'],
                    ['orthographic', '正交'],
                  ]}
                  onChange={(projection) => patch({ camera: { ...draft.camera, projection } })}
                />
                <NumberControl
                  label="视场角"
                  value={draft.camera.fov ?? 45}
                  min={1}
                  max={178}
                  onChange={(fov) => patch({ camera: { ...draft.camera, fov } })}
                />
                <NumberControl
                  label="环境光"
                  value={draft.options.ambient ?? 0.35}
                  min={0}
                  max={1}
                  step={0.05}
                  onChange={(ambient) => patch({ options: { ...draft.options, ambient } })}
                />
                <NumberControl
                  label="曝光"
                  value={draft.options.exposure ?? 1}
                  min={0.01}
                  step={0.1}
                  onChange={(exposure) => patch({ options: { ...draft.options, exposure } })}
                />
                <SelectControl
                  label="色调映射"
                  value={draft.options.toneMapping ?? 'none'}
                  options={['none', 'reinhard', 'aces']}
                  onChange={(toneMapping) => patch({ options: { ...draft.options, toneMapping } })}
                />
                <button
                  onClick={() =>
                    patch({
                      options: {
                        ...draft.options,
                        lights: [
                          ...(draft.options.lights ?? []),
                          {
                            type: 'directional',
                            direction: { x: 0, y: -1, z: -1 },
                            color: '#ffffff',
                            intensity: 3,
                          },
                        ],
                      },
                    })
                  }
                  disabled={(draft.options.lights?.length ?? 0) >= 8}
                >
                  ＋ 添加方向光
                </button>
                {draft.options.lights?.map((light, index) => (
                  <fieldset key={index}>
                    <legend>灯光 {index + 1}</legend>
                    <ColorControl
                      label={`灯光 ${index + 1} 颜色`}
                      value={light.color}
                      onChange={(color) =>
                        patch({
                          options: {
                            ...draft.options,
                            lights: draft.options.lights!.map((l, i) =>
                              i === index ? { ...l, color } : l,
                            ),
                          },
                        })
                      }
                    />
                    <NumberControl
                      label={`灯光 ${index + 1} 强度`}
                      value={light.intensity}
                      min={0}
                      step={0.1}
                      onChange={(intensity) =>
                        patch({
                          options: {
                            ...draft.options,
                            lights: draft.options.lights!.map((l, i) =>
                              i === index ? { ...l, intensity } : l,
                            ),
                          },
                        })
                      }
                    />
                    <VectorControl
                      label={`灯光 ${index + 1} ${light.type === 'directional' ? '方向' : '位置'}`}
                      value={light.type === 'directional' ? light.direction : light.position}
                      onChange={(value) =>
                        patch({
                          options: {
                            ...draft.options,
                            lights: draft.options.lights!.map((l, i) =>
                              i === index
                                ? {
                                    ...l,
                                    [l.type === 'directional' ? 'direction' : 'position']: value,
                                  }
                                : l,
                            ),
                          },
                        })
                      }
                    />
                    <button
                      onClick={() =>
                        patch({
                          options: {
                            ...draft.options,
                            lights: draft.options.lights!.filter((_, i) => i !== index),
                          },
                        })
                      }
                    >
                      删除灯光
                    </button>
                  </fieldset>
                ))}
              </section>
              <section>
                <h3>物体与材质</h3>
                <SelectControl
                  label="3D 物体"
                  value={selected}
                  options={draft.instances.map((i) => [i.id, i.id])}
                  onChange={setSelected}
                />
                {instance && (
                  <>
                    {(['position', 'rotation', 'scale'] as const).map((key) => (
                      <VectorControl
                        key={key}
                        label={
                          { position: '物体位置', rotation: '物体旋转', scale: '物体缩放' }[key]
                        }
                        value={
                          instance.transform?.[key] ?? {
                            x: key === 'scale' ? 1 : 0,
                            y: key === 'scale' ? 1 : 0,
                            z: key === 'scale' ? 1 : 0,
                          }
                        }
                        onChange={(value) =>
                          editInstance({ transform: { ...instance.transform, [key]: value } })
                        }
                      />
                    ))}
                    <ColorControl
                      label="材质颜色"
                      value={material!.color ?? instance.color ?? '#74b8df'}
                      onChange={(color) => editInstance({ material: { ...material, color } })}
                    />
                    <SelectControl
                      label="材质模型"
                      value={material!.model}
                      options={[
                        ['standard', '标准'],
                        ['unlit', '无光照'],
                      ]}
                      onChange={(model) => editInstance({ material: { ...material, model } })}
                    />
                    <NumberControl
                      label="金属度"
                      value={material!.metallic}
                      min={0}
                      max={1}
                      step={0.05}
                      onChange={(metallic) => editInstance({ material: { ...material, metallic } })}
                    />
                    <NumberControl
                      label="粗糙度"
                      value={material!.roughness}
                      min={0.05}
                      max={1}
                      step={0.05}
                      onChange={(roughness) =>
                        editInstance({ material: { ...material, roughness } })
                      }
                    />
                    <ColorControl
                      label="自发光颜色"
                      value={material!.emissive}
                      onChange={(emissive) => editInstance({ material: { ...material, emissive } })}
                    />
                    <NumberControl
                      label="自发光强度"
                      value={material!.emissiveIntensity}
                      min={0}
                      max={8}
                      step={0.1}
                      onChange={(emissiveIntensity) =>
                        editInstance({ material: { ...material, emissiveIntensity } })
                      }
                    />
                    <Toggle
                      label="双面材质"
                      value={material!.doubleSided}
                      onChange={(doubleSided) =>
                        editInstance({ material: { ...material, doubleSided } })
                      }
                    />
                  </>
                )}
              </section>
            </div>
            <CandidateActions
              context={context}
              changeKey={JSON.stringify(draft)}
              prepare={() =>
                context.run('compositionTransactBatch', {
                  mode: 'plan',
                  revision: base,
                  sceneId: context.sceneId,
                  frame: context.frame,
                  edits: [
                    {
                      nodeId: context.node!.id,
                      path: context.path,
                      contextFrames: context.contextFrames,
                      frame: context.frame,
                      patch: {
                        scene3d: draft,
                        animations: context.node!.animations.map((channel) => {
                          if (!channel.property.startsWith('scene3d.')) return channel;
                          let value: number, old: number;
                          try {
                            value = getNumericPath(
                              { ...context.node!, scene3d: draft },
                              channel.property,
                            );
                            old = getNumericPath(context.node!, channel.property);
                          } catch {
                            return channel;
                          }
                          return value === old
                            ? channel
                            : {
                                ...channel,
                                keys: [
                                  ...channel.keys.filter(
                                    (k) => k.frame !== Math.round(context.frame),
                                  ),
                                  {
                                    frame: Math.round(context.frame),
                                    value,
                                    easing: 'linear' as const,
                                  },
                                ].sort((a, b) => a.frame - b.frame),
                              };
                        }),
                      },
                    },
                  ],
                })
              }
            />
          </>
        )
      )}
    </>
  );
}
