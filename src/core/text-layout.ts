import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { newNode, type Node } from './model.js';
import { nativeTextFont } from './bundled-fonts.js';
export function layoutTextLines(ctx: SKRSContext2D, n: Node) {
  ctx.font = nativeTextFont(n.fontWeight, n.fontSize, n.fontFamily);
  ctx.textBaseline = 'top';
  ctx.textAlign = n.align;
  const segmenter = new Intl.Segmenter('zh', { granularity: 'grapheme' }),
    chars = Array.from(segmenter.segment(n.text), (s) => s.segment);
  const visible = chars.slice(0, Math.ceil(chars.length * n.reveal)).join('');
  const lines: string[] = [];
  for (const paragraph of visible.split('\n')) {
    let line = '';
    for (const { segment: word } of new Intl.Segmenter('zh', { granularity: 'word' }).segment(
      paragraph,
    )) {
      if (line && ctx.measureText(line + word).width > n.width) {
        lines.push(line.trimEnd());
        line = '';
      }
      if (ctx.measureText(word).width > n.width) {
        for (const { segment: char } of segmenter.segment(word)) {
          if (line && ctx.measureText(line + char).width > n.width) {
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
export function measureTextBlock(value: string, props: Partial<Node> = {}) {
  const node = newNode({ ...props, id: 'text-measure', type: 'text', text: value }),
    lines = layoutTextLines(measureContext, node);
  return {
    lines,
    lineCount: lines.length,
    width: Math.max(0, ...lines.map((line) => measureContext.measureText(line).width)),
    height: lines.length * node.fontSize * node.lineHeight,
  };
}
