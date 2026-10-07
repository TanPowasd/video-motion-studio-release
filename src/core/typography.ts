import { type SKRSContext2D } from '@napi-rs/canvas';
import { type Node, VmotionError } from './model.js';
import { nativeTextFont } from './bundled-fonts.js';
import { layoutTextLines } from './text-layout.js';
import { GeometryCache } from './geometry-cache.js';
import { prepareCurvePath, sampleCurvePath } from './curve-path.js';
import type { TextSelector } from './typography-schema.js';

const graphemes = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const words = new Intl.Segmenter('zh', { granularity: 'word' });
let fontEpoch = 0;
export function invalidateTypographyFonts() {
  fontEpoch++;
}
export function textSelectorWeight(selector: TextSelector, index: number, count: number) {
  if (index < 0 || !count || selector.end <= selector.start) return 0;
  const position = selector.mode === 'percent' ? ((index + 0.5) / count) * 100 : index + 0.5,
    t = (position - selector.start - selector.offset) / (selector.end - selector.start);
  if (t < 0 || t > 1) return 0;
  const shape =
    selector.shape === 'rampUp'
      ? t
      : selector.shape === 'rampDown'
        ? 1 - t
        : selector.shape === 'triangle'
          ? 1 - Math.abs(2 * t - 1)
          : selector.shape === 'smooth'
            ? Math.sin(Math.PI * t) ** 2
            : 1;
  return shape * selector.amount;
}
export type TextRun = {
  text: string;
  x: number;
  y: number;
  rotation: number;
  scaleX: number;
  scaleY: number;
  alpha: number;
  fill?: string;
  baseline: 'top' | 'alphabetic';
  index: number;
  wordIndex: number;
  lineIndex: number;
  width: number;
  box: { x: number; y: number; width: number; height: number };
};
type Unit = Omit<TextRun, 'alpha' | 'scaleX' | 'scaleY' | 'rotation'> & {
  start: number;
  count: number;
};
type PreparedText = {
  units: Unit[];
  lines: string[];
  counts: { grapheme: number; word: number; line: number };
  advance: number;
};
export class TypographyLayout {
  readonly cache: GeometryCache<PreparedText>;
  readonly lineCache: GeometryCache<string[]>;
  constructor(budgetBytes = 8 * 1024 * 1024) {
    this.cache = new GeometryCache(budgetBytes);
    this.lineCache = new GeometryCache(budgetBytes / 4);
  }
  report() {
    return { layout: this.cache.report(), lines: this.lineCache.report() };
  }
  clear() {
    this.cache.clear();
    this.lineCache.clear();
  }
  lines(ctx: SKRSContext2D, n: Node) {
    ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
    ctx.textAlign = n.align;
    ctx.textBaseline = 'top';
    const key = JSON.stringify([
        fontEpoch,
        n.text,
        n.width,
        n.fontFamily,
        n.fontWeight,
        n.fontSize,
        n.reveal,
      ]),
      hit = this.lineCache.get(key);
    if (hit) return [...hit];
    const lines = layoutTextLines(ctx, n);
    if (this.lineCache.budgetBytes)
      this.lineCache.put(
        key,
        Object.freeze([...lines]) as unknown as string[],
        lines.join('').length * 2 + lines.length * 24,
      );
    return lines;
  }
  layout(ctx: SKRSContext2D, n: Node, frame = 0) {
    if (n.text.length > 65536)
      throw new VmotionError(
        'TEXT_BUDGET',
        'Advanced typography allows at most 65536 UTF-16 units per layer',
      );
    const animators = n.textAnimators.filter((v) => v.enabled),
      path = n.pathText,
      granularity =
        path ||
        n.textMotion?.unit === 'grapheme' ||
        animators.some((a) => a.selector.unit === 'grapheme' || a.values.tracking) ||
        n.animations.some((a) => /textAnimators\.\d+\.values\.tracking$/.test(a.property)) ||
        Object.keys(n.expressions ?? {}).some((p) =>
          /textAnimators\.\d+\.values\.tracking$/.test(p),
        )
          ? 'grapheme'
          : n.textMotion?.unit === 'word' || animators.some((a) => a.selector.unit === 'word')
            ? 'word'
            : 'line',
      baseline = path ? ('alphabetic' as const) : ('top' as const),
      key = JSON.stringify([
        fontEpoch,
        n.text,
        n.width,
        n.fontFamily,
        n.fontWeight,
        n.fontSize,
        n.lineHeight,
        n.align,
        !!path,
        granularity,
      ]);
    ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
    ctx.textAlign = 'left';
    ctx.textBaseline = baseline;
    let prepared = this.cache.get(key);
    if (!prepared) {
      const chars = Array.from(graphemes.segment(n.text), (s) => s.segment);
      if (chars.length > 4096)
        throw new VmotionError(
          'TEXT_BUDGET',
          'Advanced typography allows at most 4096 graphemes per layer',
        );
      const lines = path ? [n.text.replace(/\n/g, ' ')] : this.lines(ctx, { ...n, reveal: 1 });
      ctx.textAlign = 'left';
      ctx.textBaseline = baseline;
      const units: Unit[] = [],
        counts = { grapheme: 0, word: 0, line: lines.length };
      let advance = 0;
      for (const [lineIndex, line] of lines.entries()) {
        const lineWidth = ctx.measureText(line).width,
          origin = path
            ? 0
            : n.align === 'center'
              ? (n.width - lineWidth) / 2
              : n.align === 'right'
                ? n.width - lineWidth
                : 0,
          tokens = Array.from(words.segment(line)),
          segments =
            granularity === 'line'
              ? [{ segment: line, index: 0 }]
              : granularity === 'word'
                ? tokens
                : Array.from(graphemes.segment(line));
        const wordRanges = tokens.map((t) => ({
          start: t.index,
          end: t.index + t.segment.length,
          index: t.isWordLike ? counts.word++ : -1,
        }));
        for (const segment of segments) {
          const m = ctx.measureText(segment.segment),
            width = m.width,
            count = Array.from(graphemes.segment(segment.segment)).length,
            wordIndex =
              wordRanges.find((r) => segment.index >= r.start && segment.index < r.end)?.index ??
              -1;
          units.push({
            text: segment.segment,
            x: origin + ctx.measureText(line.slice(0, segment.index)).width,
            y: lineIndex * n.fontSize * n.lineHeight,
            index: counts.grapheme,
            wordIndex,
            lineIndex,
            width,
            baseline,
            start: counts.grapheme,
            count,
            box: {
              x: -m.actualBoundingBoxLeft,
              y: -m.actualBoundingBoxAscent,
              width: Math.max(width, m.actualBoundingBoxRight) + m.actualBoundingBoxLeft,
              height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
            },
          });
          counts.grapheme += count;
        }
        advance = lineWidth;
      }
      prepared = { units, lines, counts, advance };
      // Never expose the cached layout to SDK callers.
      if (this.cache.budgetBytes)
        this.cache.put(key, prepared, JSON.stringify(prepared).length * 2);
    }
    const curve = path ? prepareCurvePath(path.path) : undefined,
      visible = Math.ceil(prepared.counts.grapheme * n.reveal),
      runs: TextRun[] = [];
    const trackingAnimators = animators.filter((a) => a.values.tracking),
      selectorIndex = (selector: TextSelector, unit: Unit) =>
        selector.unit === 'word'
          ? unit.wordIndex
          : selector.unit === 'line'
            ? unit.lineIndex
            : unit.index,
      totalTracking = path
        ? Math.max(0, prepared.units.length - 1) * path.tracking +
          (trackingAnimators.length
            ? prepared.units
                .slice(0, -1)
                .reduce(
                  (sum, unit) =>
                    sum +
                    trackingAnimators.reduce(
                      (s, a) =>
                        s +
                        a.values.tracking *
                          textSelectorWeight(
                            a.selector,
                            selectorIndex(a.selector, unit),
                            prepared!.counts[a.selector.unit],
                          ),
                      0,
                    ),
                  0,
                )
            : 0)
        : 0,
      alignment =
        path && curve
          ? path.align === 'center'
            ? (curve.length - prepared.advance - totalTracking) / 2
            : path.align === 'end'
              ? curve.length - prepared.advance - totalTracking
              : 0
          : 0;
    let tracking = 0,
      currentLine = -1,
      overflowUnits = 0;
    for (const unit of prepared.units) {
      if (unit.lineIndex !== currentLine) {
        tracking = 0;
        currentLine = unit.lineIndex;
      }
      if (!path && unit.y >= n.height) continue;
      const run: TextRun = {
        ...unit,
        box: { ...unit.box },
        rotation: 0,
        scaleX: 1,
        scaleY: 1,
        alpha: 1,
      };
      let extraTracking = path?.tracking ?? 0;
      for (const animator of animators) {
        const selector = animator.selector,
          index =
            selector.unit === 'word'
              ? unit.wordIndex
              : selector.unit === 'line'
                ? unit.lineIndex
                : unit.index,
          weight = textSelectorWeight(selector, index, prepared.counts[selector.unit]),
          v = animator.values;
        run.x += v.x * weight;
        run.y += v.y * weight;
        run.rotation += v.rotation * weight;
        run.scaleX *= 1 + (v.scaleX - 1) * weight;
        run.scaleY *= 1 + (v.scaleY - 1) * weight;
        run.alpha *= Math.max(0, Math.min(1, 1 + (v.opacity - 1) * weight));
        extraTracking += v.tracking * weight;
        if (v.fill && weight >= 0.5) run.fill = v.fill;
      }
      if (n.textMotion) {
        const m = n.textMotion,
          index = m.unit === 'word' ? Math.max(0, unit.wordIndex) : unit.index,
          p = Math.max(0, Math.min(1, (frame - m.start - index * m.stagger) / m.duration)),
          e = 1 - (1 - p) ** 3;
        run.x += m.offsetX * (1 - e);
        run.y += m.offsetY * (1 - e);
        run.rotation += m.rotation * (1 - e);
        run.scaleX *= m.scale + (1 - m.scale) * e;
        run.scaleY *= m.scale + (1 - m.scale) * e;
        run.alpha *= p;
      }
      if (path && curve) {
        const distance = unit.x + unit.width / 2 + tracking + path.offset + alignment;
        if (
          path.overflow === 'hide' &&
          (distance - unit.width / 2 < 0 || distance + unit.width / 2 > curve.length)
        ) {
          overflowUnits++;
          tracking += extraTracking;
          continue;
        }
        const sampled = sampleCurvePath(
            curve,
            path.reverse ? 1 - distance / (curve.length || 1) : distance / (curve.length || 1),
            path.overflow === 'loop' ? 'loop' : 'clamp',
          ),
          tx = sampled.tangentX * (path.reverse ? -1 : 1),
          ty = sampled.tangentY * (path.reverse ? -1 : 1),
          angle = path.tangent ? Math.atan2(ty, tx) : 0,
          dx = run.x - unit.x,
          dy = run.y - unit.y;
        run.x = sampled.x - (Math.cos(angle) * unit.width) / 2 - ty * path.normalOffset + dx;
        run.y = sampled.y - (Math.sin(angle) * unit.width) / 2 + tx * path.normalOffset + dy;
        run.rotation += (angle * 180) / Math.PI;
      } else run.x += tracking;
      tracking += extraTracking;
      if (unit.start >= visible || run.alpha <= 0) continue;
      if (unit.start + unit.count > visible) {
        run.text = Array.from(graphemes.segment(unit.text), (s) => s.segment)
          .slice(0, visible - unit.start)
          .join('');
        const m = ctx.measureText(run.text);
        run.width = m.width;
        run.box = {
          x: -m.actualBoundingBoxLeft,
          y: -m.actualBoundingBoxAscent,
          width: Math.max(m.width, m.actualBoundingBoxRight) + m.actualBoundingBoxLeft,
          height: m.actualBoundingBoxAscent + m.actualBoundingBoxDescent,
        };
      }
      runs.push(run);
    }
    return {
      runs,
      metrics: {
        lineCount: prepared.lines.length,
        fullLineCount: prepared.lines.length,
        renderedLineCount: path
          ? 1
          : prepared.lines.filter((_, i) => i * n.fontSize * n.lineHeight < n.height).length,
        truncatedCharacters: path
          ? 0
          : prepared.units.filter((u) => u.y >= n.height).reduce((s, u) => s + u.text.length, 0),
        requiredHeight: path
          ? undefined
          : prepared.lines.length * n.fontSize * n.lineHeight + n.strokeWidth,
        counts: { ...prepared.counts },
        overflowUnits,
        pathLength: curve?.length,
      },
    };
  }
}
const sdkTypography = new TypographyLayout();
export function layoutAnimatedText(ctx: SKRSContext2D, node: Node, frame = 0) {
  return sdkTypography.layout(ctx, node, frame);
}
