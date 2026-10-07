import { transform, type Matrix, type Bounds } from './interaction.js';
export function pixelRegion(matrix: Matrix, region: Bounds, width: number, height: number) {
  const points = [
    { x: region.x, y: region.y },
    { x: region.x + region.width, y: region.y },
    { x: region.x, y: region.y + region.height },
    { x: region.x + region.width, y: region.y + region.height },
  ].map((p) => transform(matrix, p));
  const x0 = Math.max(0, Math.min(width, Math.floor(Math.min(...points.map((p) => p.x)) - 0.5))),
    y0 = Math.max(0, Math.min(height, Math.floor(Math.min(...points.map((p) => p.y)) - 0.5))),
    x1 = Math.max(-1, Math.min(width - 1, Math.ceil(Math.max(...points.map((p) => p.x)) - 0.5))),
    y1 = Math.max(-1, Math.min(height - 1, Math.ceil(Math.max(...points.map((p) => p.y)) - 0.5)));
  return { x0, y0, x1, y1, pixels: Math.max(0, x1 - x0 + 1) * Math.max(0, y1 - y0 + 1) };
}
