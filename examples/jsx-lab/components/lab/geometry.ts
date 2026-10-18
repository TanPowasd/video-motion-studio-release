// Plain .ts helper shared by the .tsx scenes: .ts and .tsx modules mix freely.
import { random, type Vec2 } from '@vmotion/sdk';

/** Points along the logo mark: a "V" stroke inside a ring, evenly spaced, deterministic. */
export function logoPoints(count: number, center: Vec2, size: number): Vec2[] {
  const ring = Math.round(count * 0.55),
    v = count - ring,
    points: Vec2[] = [];
  for (let i = 0; i < ring; i++) {
    const a = (i / ring) * Math.PI * 2 - Math.PI / 2;
    points.push({ x: center.x + Math.cos(a) * size, y: center.y + Math.sin(a) * size });
  }
  const left = { x: center.x - size * 0.52, y: center.y - size * 0.42 },
    bottom = { x: center.x, y: center.y + size * 0.5 },
    right = { x: center.x + size * 0.52, y: center.y - size * 0.42 };
  for (let i = 0; i < v; i++) {
    const t = i / (v - 1),
      [a, b, k] = t < 0.5 ? [left, bottom, t * 2] : [bottom, right, (t - 0.5) * 2];
    points.push({ x: a.x + (b.x - a.x) * k, y: a.y + (b.y - a.y) * k });
  }
  return points;
}

/** Seeded scatter positions (same every frame, so seeking is exact). */
export function scatter(count: number, seed: number, width: number, height: number): Vec2[] {
  const rng = random(seed);
  return Array.from({ length: count }, () => ({ x: rng() * width, y: rng() * height }));
}

/** Deterministic pseudo-spectrum: band energies driven by beat phase and band index. */
export function spectrum(bands: number, beat: number, phase: number): number[] {
  return Array.from({ length: bands }, (_, i) => {
    const kick = Math.exp(-phase * 5) * Math.max(0, 1 - i / (bands * 0.45));
    const shimmer = 0.5 + 0.5 * Math.sin(beat * 2.1 + i * 0.73) * Math.cos(beat * 0.9 - i * 0.31);
    return Math.min(1, 0.12 + kick * 0.8 + shimmer * 0.35 * (0.4 + i / bands));
  });
}
