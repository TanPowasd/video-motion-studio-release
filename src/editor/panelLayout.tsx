import { useEffect, useRef } from 'react';
import { useWorkbenchField } from './state/workbench-selectors.js';
export interface PanelLayout {
  left: number;
  right: number;
  timeline: number;
  showLeft: boolean;
  showRight: boolean;
  /** When false the timeline collapses to its transport bar. Optional for older saved layouts. */
  showTimeline?: boolean;
}
export const panelDefaults: PanelLayout = {
  left: 260,
  right: 316,
  timeline: 260,
  showLeft: true,
  showRight: true,
  showTimeline: true,
};
export const panelLimits = {
  left: { min: 200, max: 440 },
  right: { min: 260, max: 520 },
  timeline: { min: 150, max: 560 },
} as const;
const clamp = (value: number, min: number, max: number) => Math.max(min, Math.min(max, value));
const STORAGE_KEY = 'vmotion.workbench.layout';
export function usePanelLayout() {
  const [layout, setLayout] = useWorkbenchField('panels', 'layout');
  useEffect(() => {
    setLayout((current) => {
      try {
        const value = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '{}');
        return {
          ...panelDefaults,
          left: clamp(Number(value.left) || panelDefaults.left, panelLimits.left.min, panelLimits.left.max),
          right: clamp(
            Number(value.right) || panelDefaults.right,
            panelLimits.right.min,
            panelLimits.right.max,
          ),
          timeline: clamp(
            Number(value.timeline) || panelDefaults.timeline,
            panelLimits.timeline.min,
            panelLimits.timeline.max,
          ),
          showLeft: value.showLeft !== false,
          showRight: value.showRight !== false,
          showTimeline: value.showTimeline !== false,
        };
      } catch {
        return current;
      }
    });
  }, []);
  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(layout));
  }, [layout]);
  useEffect(() => {
    const resize = () =>
      setLayout((value) => ({
        ...value,
        timeline: Math.max(
          panelLimits.timeline.min,
          Math.min(value.timeline, window.innerHeight - 300),
        ),
      }));
    resize();
    window.addEventListener('resize', resize);
    return () => window.removeEventListener('resize', resize);
  }, []);
  return { layout, setLayout, reset: () => setLayout(panelDefaults) };
}
/**
 * Draggable panel divider. Drag or use arrow keys (Shift = larger steps) to resize,
 * double-click (or Home) to restore the default size.
 */
export function Splitter({
  label,
  direction,
  value,
  onChange,
  min,
  max,
  invert = false,
  defaultValue,
}: {
  label: string;
  direction: 'horizontal' | 'vertical';
  value: number;
  onChange: (value: number) => void;
  min: number;
  max: number;
  invert?: boolean;
  defaultValue?: number;
}) {
  const start = useRef<{ coordinate: number; value: number } | undefined>(undefined);
  const end = () => {
    start.current = undefined;
    document.body.classList.remove('vm-resizing', 'vm-resizing-row', 'vm-resizing-col');
  };
  return (
    <div
      className={`splitter ${direction}`}
      role="separator"
      aria-label={label}
      title={defaultValue === undefined ? label : `${label}（双击恢复默认）`}
      aria-orientation={direction === 'horizontal' ? 'horizontal' : 'vertical'}
      aria-valuenow={Math.round(value)}
      aria-valuemin={min}
      aria-valuemax={max}
      tabIndex={0}
      onKeyDown={(event) => {
        const step = event.shiftKey ? 48 : 12;
        const delta =
          event.key === 'ArrowLeft' || event.key === 'ArrowUp'
            ? -step
            : event.key === 'ArrowRight' || event.key === 'ArrowDown'
              ? step
              : 0;
        if (delta) {
          event.preventDefault();
          onChange(clamp(value + delta * (invert ? -1 : 1), min, max));
        } else if (event.key === 'Home' && defaultValue !== undefined) {
          event.preventDefault();
          onChange(defaultValue);
        }
      }}
      onDoubleClick={() => defaultValue !== undefined && onChange(defaultValue)}
      onPointerDown={(event) => {
        if (event.button !== 0) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        document.body.classList.add(
          'vm-resizing',
          direction === 'horizontal' ? 'vm-resizing-row' : 'vm-resizing-col',
        );
        start.current = {
          coordinate: direction === 'horizontal' ? event.clientY : event.clientX,
          value,
        };
      }}
      onPointerMove={(event) => {
        if (!start.current) return;
        const coordinate = direction === 'horizontal' ? event.clientY : event.clientX;
        onChange(
          clamp(
            start.current.value + (coordinate - start.current.coordinate) * (invert ? -1 : 1),
            min,
            max,
          ),
        );
      }}
      onPointerUp={end}
      onPointerCancel={end}
    />
  );
}
