import { useEffect, useRef, useState } from 'react';
/**
 * One app-wide tooltip that replaces the slow, unstyled native `title` popups.
 *
 * Any element with a `title` (or an icon-only button with an `aria-label`) gets a styled
 * tooltip after a short hover delay. A trailing " · Ctrl+G" style suffix is rendered as
 * key chips. The `title` attribute is parked in `data-vm-title` only while the tooltip is
 * showing so the native popup does not double up, and restored on leave.
 */
const SHORTCUT = /^(ctrl|shift|alt|cmd|delete|space|esc|enter|tab|home|end|f\d+|[a-z0-9?\[\]←→↑↓]|.*\+.*)$/i;
interface Tip {
  text: string;
  keys?: string;
  x: number;
  y: number;
  place: 'below' | 'above';
}
function describe(element: HTMLElement): string | undefined {
  const title = element.getAttribute('title') ?? element.dataset.vmTitle;
  if (title) return title;
  if (element.matches('button,[role="button"]') && !element.textContent?.trim())
    return element.getAttribute('aria-label') ?? undefined;
  return undefined;
}
export function Tooltips() {
  const [tip, setTip] = useState<Tip>();
  const [visible, setVisible] = useState(false);
  const timer = useRef<number | undefined>(undefined);
  const owner = useRef<HTMLElement | undefined>(undefined);
  useEffect(() => {
    const release = () => {
      window.clearTimeout(timer.current);
      const element = owner.current;
      if (element?.dataset.vmTitle !== undefined) {
        if (!element.hasAttribute('title')) element.setAttribute('title', element.dataset.vmTitle);
        delete element.dataset.vmTitle;
      }
      owner.current = undefined;
      setVisible(false);
    };
    const over = (event: PointerEvent) => {
      if (event.pointerType === 'touch' || document.body.classList.contains('vm-resizing')) return;
      const target = (event.target as HTMLElement | null)?.closest?.<HTMLElement>(
        '[title],[data-vm-title],button[aria-label],[role="button"][aria-label]',
      );
      if (target === owner.current) return;
      release();
      if (!target || target.closest('.vm-no-tooltip')) return;
      const text = describe(target);
      if (!text) return;
      owner.current = target;
      if (target.hasAttribute('title')) {
        target.dataset.vmTitle = target.getAttribute('title')!;
        target.removeAttribute('title');
      }
      timer.current = window.setTimeout(() => {
        if (owner.current !== target || !target.isConnected) return;
        const box = target.getBoundingClientRect();
        const parts = text.split(' · ');
        const last = parts.at(-1)!.trim();
        const keys = parts.length > 1 && SHORTCUT.test(last) ? last : undefined;
        const label = keys ? parts.slice(0, -1).join(' · ') : text;
        const place = box.bottom + 40 > window.innerHeight ? 'above' : 'below';
        setTip({
          text: label,
          keys,
          x: Math.min(window.innerWidth - 12, Math.max(12, box.left + box.width / 2)),
          y: place === 'below' ? box.bottom + 6 : box.top - 6,
          place,
        });
        requestAnimationFrame(() => setVisible(true));
      }, 420);
    };
    const leave = (event: PointerEvent) => {
      // Leaving the window entirely; moves between elements are handled by `over`.
      if (!event.relatedTarget) release();
    };
    window.addEventListener('pointerover', over, true);
    window.addEventListener('pointerout', leave, true);
    window.addEventListener('pointerdown', release, true);
    window.addEventListener('keydown', release, true);
    window.addEventListener('wheel', release, { capture: true, passive: true });
    window.addEventListener('blur', release);
    return () => {
      release();
      window.removeEventListener('pointerover', over, true);
      window.removeEventListener('pointerout', leave, true);
      window.removeEventListener('pointerdown', release, true);
      window.removeEventListener('keydown', release, true);
      window.removeEventListener('wheel', release, true);
      window.removeEventListener('blur', release);
    };
  }, []);
  if (!tip) return null;
  return (
    <div
      className={`vm-tooltip ${visible ? 'visible' : ''}`}
      role="tooltip"
      ref={(element) => {
        if (!element) return;
        const width = element.offsetWidth;
        const left = Math.min(window.innerWidth - width - 8, Math.max(8, tip.x - width / 2));
        element.style.left = `${left}px`;
        element.style.top =
          tip.place === 'below' ? `${tip.y}px` : `${tip.y - element.offsetHeight}px`;
      }}
    >
      {tip.text}
      {tip.keys && <kbd>{tip.keys}</kbd>}
    </div>
  );
}
