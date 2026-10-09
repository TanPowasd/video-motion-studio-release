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
) {
  ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
  ctx.textBaseline = 'top';
  ctx.textAlign = n.align;
  const width = (s: string) => measurer.width(s);
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' }),
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
