import { useEffect, useState, useRef } from 'react';
import {useWorkbenchField} from './state/workbench-selectors.js';
export interface PanelLayout {
  left: number;
  right: number;
  timeline: number;
  showLeft: boolean;
  showRight: boolean;
}
const defaults: PanelLayout = {
  left: 250,
  right: 304,
  timeline: 260,
  showLeft: true,
  showRight: true,
};
export function usePanelLayout() {
  const [layout, setLayout] = useWorkbenchField('panels','layout');
  useEffect(()=>{setLayout((current)=>{
    try {
      const value = JSON.parse(localStorage.getItem('vmotion.workbench.layout') ?? '{}');
      return {
        ...defaults,
        left: Math.max(180, Math.min(420, Number(value.left) || defaults.left)),
        right: Math.max(240, Math.min(480, Number(value.right) || defaults.right)),
        timeline: Math.max(150, Math.min(500, Number(value.timeline) || defaults.timeline)),
        showLeft: value.showLeft !== false,
        showRight: value.showRight !== false,
      };
    } catch {
      return current;
    }
  });},[]);
  useEffect(() => {
    localStorage.setItem('vmotion.workbench.layout', JSON.stringify(layout));
  }, [layout]);
  useEffect(() => {
    const resize = () =>
      setLayout((value) => ({
        ...value,
        timeline: Math.max(150, Math.min(value.timeline, window.innerHeight - 310)),
      }));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { layout, setLayout, reset: () => setLayout(defaults) };
}
export function Splitter({
  label,
  direction,
  value,
  onChange,
  min,
  max,
  invert = false,
}: {
  label: string;
  direction: 'horizontal' | 'vertical';
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  invert?: boolean;
}) {
  const start = useRef<{ coordinate: number; value: number } | undefined>(undefined);
  return (
    <div
      className={`splitter ${direction}`}
      role="separator"
      aria-label={label}
      aria-orientation={direction === 'horizontal' ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(event) => {
        const delta =
          event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -12
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? 12
              : 0;
        if (delta) {
          event.preventDefault();
          onChange(Math.max(min, Math.min(max, value + delta)));
        }
      }}
      onPointerDown={(event) => {
        event.currentTarget.setPointerCapture(event.pointerId);
        start.current = {
          coordinate: direction === 'horizontal' ? event.clientY : event.clientX,
          value,
        };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const coordinate = direction === 'horizontal' ? event.clientY : event.clientX;
        onChange(
          Math.max(
            min,
            Math.min(
              max,
              start.current.value + (coordinate - start.current.coordinate) * (invert ? -1 : 1),
            ),
          ),
        );
      }}
      onPointerUp={() => (start.current = undefined)}
      onPointerCancel={() => (start.current = undefined)}
    />
  );
}
