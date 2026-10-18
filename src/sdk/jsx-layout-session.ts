/*
 * One flex/grid layout pass: the JSX lowering registers every element of a layout subtree
 * as a box (in emit order), then `run()` encodes the tree, calls taffy once and lowers the
 * resulting boxes onto the already-emitted nodes (x/y/width/height, plus every style value
 * that depends on the element size: transform origin, % translate, gradients, radius, clip).
 */
import type { Node } from '../core/model.js';
import { computeLayout, type LayoutSpace } from '../core/layout/taffy.js';
import { applyLetterSpacing, measureTextNode } from '../core/text-layout.js';
import { encodeBox, layoutStyleKeys, type LayoutInput } from './jsx-layout.js';
import { lowerStyle } from './jsx-style.js';

export type BoxRole = 'root' | 'flow' | 'cell' | 'absolute';
export interface SessionBox extends LayoutInput {
  node: Node;
  parent: number;
  role: BoxRole;
  /** Explicit x/y props: added to flow positions (relative offset); margins for cells. */
  offset: { x: number; y: number };
  /** Props written directly on the element (they win over style values). */
  explicit: Set<string>;
  explicitOrigin: { originX?: number; originY?: number };
  originCenter: boolean;
  background?: Node;
  letterSpacing?: number;
}

const positionKeys = new Set(['position', 'left', 'top', 'right', 'bottom']);
/** The part of a style that lowerStyle handles for a layout box (layout keys go to taffy). */
export function styleForLowering(style: Record<string, unknown>, root: boolean) {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(style)) {
    if (layoutStyleKeys.has(k) || k === 'width' || k === 'height') continue;
    if (k === 'display' && v !== 'none') continue;
    if (!root && positionKeys.has(k)) continue;
    out[k] = v;
  }
  return out;
}
const sizeKeys = new Set(['x', 'y', 'width', 'height', 'zIndex', 'letterSpacing', 'textTransform']);

export class LayoutSession {
  readonly boxes: SessionBox[] = [];
  /** Text measurements, for diagnostics/tests. */
  measures = 0;
  constructor(readonly available: { width: number; height: number }) {}
  add(box: SessionBox) {
    this.boxes.push(box);
    return this.boxes.length - 1;
  }
  run() {
    const stream: number[] = [];
    this.boxes.forEach((b) => encodeBox(b.parent, b, stream));
    const space = (v: number): LayoutSpace => (Number.isFinite(v) ? v : 'max');
    const results = computeLayout(
      stream,
      this.boxes.length,
      { width: space(this.available.width), height: space(this.available.height) },
      (index, known, available) => {
        const box = this.boxes[index];
        this.measures++;
        if (known.width !== undefined && known.height !== undefined)
          return { width: known.width, height: known.height };
        const wrap =
          known.width ??
          (typeof available.width === 'number'
            ? available.width
            : available.width === 'min'
              ? 'min'
              : Infinity);
        const m = measureTextNode(box.node, wrap, box.letterSpacing ?? 0);
        return { width: known.width ?? m.width, height: known.height ?? m.height };
      },
    );
    this.boxes.forEach((box, i) => {
      const r = results[i],
        node = box.node as Node & Record<string, unknown>;
      const parent = i === 0 ? this.available : results[box.parent];
      // Text gets a hair of slack so f32 rounding never makes the renderer wrap earlier.
      node.width = node.type === 'text' ? r.width + 1e-3 : r.width;
      node.height = r.height;
      const restyle = lowerStyle(
        styleForLowering(box.style, box.role === 'root'),
        {
          parent: { width: parent.width, height: parent.height },
          self: { width: r.width, height: r.height },
          fontSize: node.fontSize,
        },
        box.at,
        box.explicitOrigin,
      );
      for (const [k, v] of Object.entries(restyle))
        if (!sizeKeys.has(k) && !box.explicit.has(k)) node[k] = v;
      if (box.originCenter) {
        node.originX = r.width / 2;
        node.originY = r.height / 2;
      }
      const tx = (restyle.x as number | undefined) ?? 0,
        ty = (restyle.y as number | undefined) ?? 0;
      if (box.role === 'root') {
        if (!box.explicit.has('x')) node.x = tx;
        if (!box.explicit.has('y')) node.y = ty;
      } else {
        const relative = box.role === 'cell' ? { x: 0, y: 0 } : box.offset;
        node.x = r.x + relative.x + tx;
        node.y = r.y + relative.y + ty;
      }
      if (box.background) {
        box.background.width = r.width;
        box.background.height = r.height;
      }
      if (box.letterSpacing) applyLetterSpacing(node, box.letterSpacing);
    });
    return results;
  }
}
