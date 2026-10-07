import React, { Suspense, lazy, useState } from 'react';
import { Icon } from '../Icons.js';
import { studioTabs, type StudioContext, type StudioTab } from './types.js';
import './studio.css';
const panels = {
  graph: lazy(() => import('./GraphEditor.js')),
  motion: lazy(() => import('./MotionPanel.js')),
  space: lazy(() => import('./SpacePanel.js')),
  particles: lazy(() => import('./ParticlesPanel.js')),
  storyboard: lazy(() => import('./StoryboardPanel.js')),
  mix: lazy(() => import('./MixPanel.js')),
  review: lazy(() => import('./ReviewPanel.js')),
  performance: lazy(() => import('./PerformancePanel.js')),
};
export function StudioWorkspace({
  tab,
  onTab,
  context,
  onClose,
}: {
  tab: StudioTab;
  onTab: (v: StudioTab) => void;
  context: StudioContext;
  onClose: () => void;
}) {
  const Panel = panels[tab];
  const [reset, setReset] = useState(0);
  return (
    <section className="studio-workspace" aria-label="可视化创作工具">
      <header className="studio-heading">
        <div>
          <span className="eyebrow">创作工具</span>
          <strong>
            {context.node?.name ??
              context.snapshot.scenes.find((s) => s.id === context.sceneId)?.name ??
              '工程'}
          </strong>
        </div>
        <span>
          {context.frame.toFixed(0)} 帧 · {context.selected.length} 个对象
        </span>
        <button aria-label="返回画布" onClick={onClose}>
          <Icon name="close" />
          返回画布
        </button>
        <button aria-label="重新读取工具草稿" onClick={() => setReset((v) => v + 1)}>
          重置草稿
        </button>
      </header>
      <div className="studio-layout">
        <nav aria-label="创作工具分类">
          {studioTabs.map((item) => (
            <button
              key={item.id}
              aria-label={item.name}
              aria-pressed={tab === item.id}
              className={tab === item.id ? 'active' : ''}
              onClick={() => onTab(item.id)}
            >
              <Icon name={item.icon} />
              <span>
                <strong>{item.name}</strong>
                <small>{item.description}</small>
              </span>
            </button>
          ))}
        </nav>
        <div className="studio-content">
          <Suspense fallback={<div className="studio-empty">正在打开工具…</div>}>
            <Panel
              key={`${reset}:${tab}:${context.sceneId}:${context.node?.id ?? ''}:${JSON.stringify(context.path)}`}
              context={context}
            />
          </Suspense>
        </div>
      </div>
    </section>
  );
}
