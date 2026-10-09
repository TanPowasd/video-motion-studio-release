import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { builtinGlyphSet } from '../src/core/glyphs/glyph-resources.js';
import { GlyphComposer, isGlyphProblem } from '../src/core/glyphs/compose.js';
import { drawComposedGlyph } from '../src/core/glyphs/glyph-draw.js';
const set = builtinGlyphSet('demo')!;
const c = new GlyphComposer(set);
const chars = (process.argv[2] ?? Object.keys(set.glyphs).concat(Object.keys(set.components)).join('')).split('');
const size = 64, cols = 24, rows = Math.ceil(chars.length / cols);
const canvas = createCanvas(cols * size, rows * (size + 14));
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, canvas.width, canvas.height);
let bad: string[] = [];
chars.forEach((ch, i) => {
  const x = (i % cols) * size, y = Math.floor(i / cols) * (size + 14);
  const g = c.glyph(ch);
  ctx.strokeStyle = '#ddd'; ctx.lineWidth = 1; ctx.strokeRect(x + .5, y + .5, size - 1, size - 1);
  if (isGlyphProblem(g)) { bad.push(ch + ':' + g.message); ctx.fillStyle = 'red'; ctx.fillRect(x + 20, y + 20, 20, 20); return; }
  ctx.save(); ctx.translate(x, y); ctx.fillStyle = '#111'; drawComposedGlyph(ctx, g, set, size); ctx.restore();
  ctx.fillStyle = '#c00'; ctx.font = '11px sans-serif'; ctx.fillText(ch, x + 2, y + size + 11);
});
writeFileSync(process.argv[3] ?? '/workspace/projects/1b630383-67af-4e09-859c-a05230ade7d9/work/glyphs-scratch/sheet.png', canvas.toBuffer('image/png'));
console.log(chars.length, 'chars', bad.length, 'bad', bad.slice(0, 30));
