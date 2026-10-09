import React from 'react';
export function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section
      className="inspector-section"
      data-title={title}
      data-category={
        ['效果栈', '遮罩与羽化'].includes(title)
          ? 'effects'
          : title === '动画'
            ? 'animation'
            : 'properties'
      }
    >
      <h3>{title}</h3>
      {children}
    </section>
  );
}
export function Field({
  label,
  value,
  onChange,
  onKey,
}: {
  label: string;
  value: number;
  onChange: (value: number) => unknown;
  onKey?: () => void;
}) {
  return (
    <label className="number-field">
      <span>{label}</span>
      <input
        aria-label={label}
        key={value}
        type="number"
        defaultValue={Number(value.toFixed(3))}
        onBlur={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n) && n !== Number(value.toFixed(3))) onChange(n);
        }}
        onKeyDown={(e) => {
          if (e.key === 'Enter') e.currentTarget.blur();
        }}
      />
      {onKey && (
        <button title={`Add ${label} keyframe`} type="button" onClick={onKey}>
          ◇
        </button>
      )}
    </label>
  );
}
