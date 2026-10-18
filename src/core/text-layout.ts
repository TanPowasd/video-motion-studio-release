import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { newNode, type Node, type NodeInput } from './model.js';
import { nativeTextFont } from './bundled-fonts.js';
import {
  MixedTextMeasurer,
  glyphSourceFor,
  glyphSourceFromDocument,
  noGlyphs,
  type GlyphTextSource,
} from './glyphs/glyph-text.js';
import type { GlyphSetDocument } from './glyphs/glyph-schema.js';
import { glyphSetFile, glyphSetSchema } from './glyphs/glyph-schema.js';
import { sharedGlyphSets } from './glyphs/glyph-resources.js';
export function layoutTextLines(
  ctx: SKRSContext2D,
  n: Node,
  measurer: MixedTextMeasurer = new MixedTextMeasurer(ctx, noGlyphs, n.fontSize),
  /** Extra advance after every grapheme but the last on a line (CSS letter-spacing). */
  tracking = 0,
) {
  ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
  ctx.textBaseline = 'top';
  ctx.textAlign = n.align;
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
  const width = tracking
    ? (s: string) =>
        measurer.width(s) + tracking * Math.max(0, Array.from(segmenter.segment(s)).length - 1)
    : (s: string) => measurer.width(s);
  const
    chars = Array.from(segmenter.segment(n.text), (s) => s.segment);
  const visible = chars.slice(0, Math.ceil(chars.length * n.reveal)).join('');
  const lines: string[] = [];
  for (const paragraph of visible.split('\n')) {
    let line = '';
    for (const { segment: word } of new Intl.Segmenter('zh', { granularity: 'word' }).segment(
      paragraph,
    )) {
      if (line && width(line + word) > n.width) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (width(word) > n.width) {
        for (const { segment: char } of segmenter.segment(word)) {
          if (line && width(line + char) > n.width) {
            lines.push(line);
            line = '';
          }
          line += char;
        }
      } else line += !line ? word.trimStart() : word;
    }
    lines.push(line);
  }
  return lines;
}

const measureContext = createCanvas(1, 1).getContext('2d');
/**
 * Measure a wrapped text block. A props.glyphSet of "builtin:<id>" resolves without a
 * project; for a project glyph set pass its parsed document (e.g. an imported
 * components/glyphs/<id>.vmglyph.json) as options.glyphSet.
 */
export function measureTextBlock(
  value: string,
  props: Partial<NodeInput> = {},
  options: { glyphSet?: GlyphSetDocument | unknown } = {},
) {
  const node = newNode({ ...props, id: 'text-measure', type: 'text', text: value });
  let source: GlyphTextSource = noGlyphs;
  if (options.glyphSet) {
    const document = glyphSetSchema.parse(options.glyphSet),
      // Resolve through the shared resolver so `extends: builtin:*` is honoured.
      prepared = sharedGlyphSets.tryResolve(
        { files: { [glyphSetFile(document.id)]: JSON.stringify(document) } },
        document.id,
      );
    source = prepared
      ? { set: prepared, fallback: node.glyphFallback ?? 'font' }
      : glyphSourceFromDocument(document, node.glyphFallback ?? 'font');
  }
  else if (node.glyphSet) source = glyphSourceFor(node);
  measureContext.font = nativeTextFont(node.fontWeight, node.fontSize, node.fontFamily);
  const measurer = new MixedTextMeasurer(measureContext, source, node.fontSize),
    lines = layoutTextLines(measureContext, node, measurer);
  return {
    lines,
    lineCount: lines.length,
    width: Math.max(0, ...lines.map((line) => measurer.width(line))),
    height: lines.length * node.fontSize * node.lineHeight,
  };
}

const graphemeSegmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' });
const wordSegmenter = new Intl.Segmenter('zh', { granularity: 'word' });
/**
 * Measure a text node for flex/grid layout with the renderer's own font metrics and line
 * breaking. `wrapWidth` is the line length (Infinity = no wrapping, 'min' = longest
 * unbreakable word). letterSpacing adds the CSS advance between graphemes.
 */
export function measureTextNode(
  node: Node,
  wrapWidth: number | 'min',
  letterSpacing = 0,
): { lines: string[]; width: number; height: number } {
  const source = node.glyphSet ? glyphSourceFor(node) : noGlyphs;
  measureContext.font = nativeTextFont(node.fontWeight, node.fontSize, node.fontFamily);
  const measurer = new MixedTextMeasurer(measureContext, source, node.fontSize),
    tracked = (s: string) =>
      measurer.width(s) +
      letterSpacing * Math.max(0, Array.from(graphemeSegmenter.segment(s)).length - 1);
  let width = wrapWidth;
  if (width === 'min') {
    width = 0;
    for (const { segment, isWordLike } of wordSegmenter.segment(node.text))
      if (isWordLike || segment.trim()) width = Math.max(width, tracked(segment.trim()));
  }
  const lines = layoutTextLines(
    measureContext,
    { ...node, width: Number.isFinite(width) ? width : 1e9, reveal: 1 },
    measurer,
    letterSpacing,
  );
  return {
    lines,
    width: Math.max(0, ...lines.map(tracked)),
    height: lines.length * node.fontSize * node.lineHeight,
  };
}
/**
 * Lower CSS letter-spacing onto a text node: a full-range tracking text animator, explicit
 * line breaks where tracked text wraps (the renderer wraps untracked text), and per-line
 * x shifts so center/right alignment includes the spacing.
 */
export function applyLetterSpacing(node: Node, letterSpacing: number) {
  if (!letterSpacing || node.pathText) return;
  const { lines } = measureTextNode(node, node.width, letterSpacing);
  if (lines.length > 1) node.text = lines.join('\n');
  const animators = [
    ...node.textAnimators,
    {
      id: 'css-letter-spacing',
      enabled: true,
      selector: { unit: 'grapheme', mode: 'percent', start: 0, end: 100, offset: 0, shape: 'square', amount: 1 },
      values: { x: 0, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, tracking: letterSpacing },
    },
  ] as Node['textAnimators'];
  if (node.align !== 'left')
    lines.slice(0, 31 - node.textAnimators.length).forEach((line, i) => {
      const shift =
        (-letterSpacing * Math.max(0, Array.from(graphemeSegmenter.segment(line)).length - 1)) /
        (node.align === 'center' ? 2 : 1);
      if (shift)
        animators.push({
          id: `css-letter-spacing-line-${i}`,
          enabled: true,
          selector: { unit: 'line', mode: 'index', start: i, end: i + 1, offset: 0, shape: 'square', amount: 1 },
          values: { x: shift, y: 0, rotation: 0, scaleX: 1, scaleY: 1, opacity: 1, tracking: 0 },
        } as Node['textAnimators'][number]);
    });
  node.textAnimators = animators;
}
