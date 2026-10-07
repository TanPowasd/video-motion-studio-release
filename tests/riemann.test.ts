import { it, expect } from 'vitest';
import { zeta } from '../scripts/riemann-component.js';
import { chapters } from '../scripts/riemann-story.js';
it('the plotted zeta function agrees with the Basel value and known low zeros', () => {
  expect(zeta(2, 0).re).toBeCloseTo(Math.PI ** 2 / 6, 10);
  for (const t of [14.134725141734693, 21.022039638771555, 25.01085758014569]) {
    const value = zeta(0.5, t);
    expect(Math.hypot(value.re, value.im)).toBeLessThan(1e-9);
  }
});
it('the script distinguishes continuation, evidence and hypothetical points', () => {
  expect(chapters).toHaveLength(21);
  expect(chapters.find((c) => c.id === 'continuation')!.paragraphs.join('')).toContain('普通求和');
  expect(chapters.find((c) => c.id === 'symmetry')!.paragraphs.join('')).toContain('假想反例');
  expect(chapters.find((c) => c.id === 'proof')!.paragraphs.join('')).toContain('有限');
});
