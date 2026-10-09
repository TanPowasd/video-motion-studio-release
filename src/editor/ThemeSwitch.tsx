import { Icon } from './Icons.js';
import { THEME_PREFERENCES, useTheme } from './theme.js';

/** Three-way 跟随系统 / 暗色 / 亮色 segmented switch (arrow keys move between options). */
export function ThemeSwitch({ compact = false, label = '界面主题' }: { compact?: boolean; label?: string }) {
  const { preference, resolved, setPreference } = useTheme();
  return (
    <div
      className={`vm-theme-switch ${compact ? 'compact' : ''}`}
      role="radiogroup"
      aria-label={label}
      onKeyDown={(e) => {
        if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(e.key)) return;
        e.preventDefault();
        e.stopPropagation();
        const i = THEME_PREFERENCES.findIndex((p) => p.id === preference),
          step = e.key === 'ArrowLeft' || e.key === 'ArrowUp' ? -1 : 1,
          next = THEME_PREFERENCES[(i + step + THEME_PREFERENCES.length) % THEME_PREFERENCES.length];
        setPreference(next.id);
        (e.currentTarget.querySelector(`[data-theme-option="${next.id}"]`) as HTMLElement | null)?.focus();
      }}
    >
      {THEME_PREFERENCES.map((p) => {
        const on = p.id === preference;
        return (
          <button
            key={p.id}
            type="button"
            role="radio"
            aria-checked={on}
            tabIndex={on ? 0 : -1}
            data-theme-option={p.id}
            className={on ? 'on' : ''}
            title={p.id === 'system' ? `跟随系统（当前${resolved === 'dark' ? '暗色' : '亮色'}）` : p.label}
            onClick={() => setPreference(p.id)}
          >
            <Icon name={p.icon} size={13} />
            {!compact && <span>{p.label}</span>}
          </button>
        );
      })}
    </div>
  );
}
