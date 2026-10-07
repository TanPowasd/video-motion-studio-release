import { transform, type Point, type Matrix, type Bounds } from './interaction.js';
export type Polygon = Point[];
export function signedArea(points: Polygon) {
  return (
    points.reduce((sum, p, i) => {
      const q = points[(i + 1) % points.length];
      return sum + p.x * q.y - q.x * p.y;
    }, 0) / 2
  );
}
export const polygonArea = (polygon: Polygon) => Math.abs(signedArea(polygon));
export function boundsPolygon(bounds: Bounds, matrix: Matrix): Polygon {
  return [
    { x: bounds.x, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y },
    { x: bounds.x + bounds.width, y: bounds.y + bounds.height },
    { x: bounds.x, y: bounds.y + bounds.height },
  ].map((p) => transform(matrix, p));
}
export function clipPolygon(subject: Polygon, clip: Polygon): Polygon {
  if (subject.length < 3 || clip.length < 3) return [];
  const orientation = signedArea(clip) < 0 ? -1 : 1,
    cross = (a: Point, b: Point, p: Point) =>
      orientation * ((b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x));
  let result = subject;
  for (let i = 0; i < clip.length; i++) {
    const a = clip[i],
      b = clip[(i + 1) % clip.length],
      input = result;
    result = [];
    if (!input.length) break;
    for (let j = 0; j < input.length; j++) {
      const p = input[j],
        q = input[(j + 1) % input.length],
        pd = cross(a, b, p),
        qd = cross(a, b, q),
        inside = pd >= -1e-8,
        nextInside = qd >= -1e-8;
      if (inside) result.push(p);
      if (inside !== nextInside) {
        const t = pd / (pd - qd);
        result.push({ x: p.x + t * (q.x - p.x), y: p.y + t * (q.y - p.y) });
      }
    }
  }
  return result;
}
export function polygonBounds(polygons: Polygon[]): Bounds {
  const points = polygons.flat();
  if (!points.length) return { x: 0, y: 0, width: 0, height: 0 };
  let x = Infinity,
    y = Infinity,
    right = -Infinity,
    bottom = -Infinity;
  for (const p of points) {
    x = Math.min(x, p.x);
    y = Math.min(y, p.y);
    right = Math.max(right, p.x);
    bottom = Math.max(bottom, p.y);
  }
  return { x, y, width: right - x, height: bottom - y };
}
export function polygonsArea(polygons: Polygon[]) {
  return polygons.reduce((sum, p) => sum + polygonArea(p), 0);
}
export function overlapArea(a: Polygon[], b: Polygon[], budget = { remaining: 100000 }) {
  let area = 0;
  for (const p of a)
    for (const q of b) {
      if (--budget.remaining < 0) return undefined;
      area += polygonArea(clipPolygon(p, q));
    }
  return area;
}
