import { type Image } from '@napi-rs/canvas';
import { liteAdaptor } from 'mathjax-full/js/adaptors/liteAdaptor.js';
import { RegisterHTMLHandler } from 'mathjax-full/js/handlers/html.js';
import { TeX } from 'mathjax-full/js/input/tex.js';
import { AllPackages } from 'mathjax-full/js/input/tex/AllPackages.js';
import { mathjax } from 'mathjax-full/js/mathjax.js';
import { SVG } from 'mathjax-full/js/output/svg.js';
import { VmotionError } from '../model.js';
import type { NodeRenderer } from './registry.js';
const adaptor = liteAdaptor();
RegisterHTMLHandler(adaptor);
const math = mathjax.document('', {
  InputJax: new TeX({ packages: AllPackages }),
  OutputJax: new SVG({ fontCache: 'none' }),
});
export const renderers: NodeRenderer[] = ['formula'].map((type) => ({
  type: type as NodeRenderer['type'],
  async render(context, n) {
    const { target: ctx, snapshot, frame, depth, services, nodeSource } = context;
    const key = `math:${n.text}:${n.fill}:${n.fontSize}`;
    let image: Image;
    if (services.images.has(key)) image = services.images.get(key)!.image;
    else {
      const outer = adaptor.outerHTML(math.convert(n.text, { display: true }));
      let svg = outer
        .slice(outer.indexOf('<svg'), outer.lastIndexOf('</svg>') + 6)
        .replace(/currentColor/g, n.fill);
      const box = svg
        .match(/viewBox="([^"]+)"/)?.[1]
        .split(/\s+/)
        .map(Number);
      if (!box || box.length !== 4)
        throw new VmotionError('FORMULA_RENDER', 'Formula has no valid SVG viewBox');
      svg = svg
        .replace(/width="[^"]+"/, `width="${Math.max(1, (box[2] * n.fontSize) / 1000)}"`)
        .replace(/height="[^"]+"/, `height="${Math.max(1, (box[3] * n.fontSize) / 1000)}"`);
      image = await services.image(key, Buffer.from(svg));
    }
    const scale = Math.min(1, n.width / image.width, n.height / image.height);
    ctx.drawImage(image, 0, 0, image.width * scale, image.height * scale);
    return { target: ctx };
  },
}));
