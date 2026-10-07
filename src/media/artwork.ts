import { readFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createCanvas, ImageData } from '@napi-rs/canvas';
import { readPsd, initializeCanvas, type Layer } from 'ag-psd';
import { unzipSync } from 'fflate';
import { DOMParser } from '@xmldom/xmldom';
import { VmotionError, type Operation } from '../core/model.js';
import { safePath } from '../platform/project-files.js';

initializeCanvas((width, height) => createCanvas(width, height) as any);
export async function importArtwork(root: string, file: string, sceneId: string) {
  const bytes = await readFile(file);
  if (bytes.length > 256 * 1024 * 1024)
    throw new VmotionError('ARTWORK_LIMIT', 'Artwork import currently supports files up to 256MB');
  const operations: Operation[] = [],
    warnings: string[] = [],
    groupId = randomUUID();
  operations.push({
    type: 'addNode',
    sceneId,
    node: { id: groupId, type: 'group', name: path.basename(file), x: 0, y: 0 },
  });
  async function layer(
    name: string,
    png: Buffer | Uint8Array,
    x: number,
    y: number,
    width: number,
    height: number,
    opacity = 1,
    visible = true,
  ) {
    const id = randomUUID(),
      relative = `assets/artwork-${id}.png`;
    await mkdir(path.dirname(safePath(root, relative)), { recursive: true });
    await writeFile(safePath(root, relative), png);
    operations.push(
      {
        type: 'addAsset',
        asset: {
          id,
          name,
          path: relative,
          type: 'image',
          managed: true,
          metadata: { source: file },
        },
      },
      {
        type: 'addNode',
        sceneId,
        node: {
          id,
          type: 'image',
          name,
          assetId: id,
          parentId: groupId,
          x,
          y,
          width,
          height,
          opacity,
          visible,
        },
      },
    );
  }
  if (path.extname(file).toLowerCase() === '.psd') {
    const psd = readPsd(bytes, { skipCompositeImageData: true, useImageData: true });
    async function visit(layers: Layer[], inheritedOpacity = 1, inheritedVisible = true) {
      for (const l of [...layers].reverse()) {
        const opacity = inheritedOpacity * (l.opacity ?? 1),
          visible = inheritedVisible && !l.hidden;
        if (l.effects || l.vectorMask || l.mask || l.text)
          warnings.push(
            `${l.name ?? 'Layer'}: imported its raster pixels; editable Photoshop text, effects and masks are not reproduced.`,
          );
        if (l.children) await visit(l.children, opacity, visible);
        else if (l.imageData) {
          const c = createCanvas(l.imageData.width, l.imageData.height);
          c.getContext('2d').putImageData(
            new ImageData(
              new Uint8ClampedArray(l.imageData.data),
              l.imageData.width,
              l.imageData.height,
            ),
            0,
            0,
          );
          await layer(
            l.name ?? 'Layer',
            await c.encode('png'),
            l.left ?? 0,
            l.top ?? 0,
            c.width,
            c.height,
            opacity,
            visible,
          );
        }
      }
    }
    await visit(psd.children ?? []);
  } else if (path.extname(file).toLowerCase() === '.ora') {
    const archive = unzipSync(bytes);
    if (Object.values(archive).reduce((sum, v) => sum + v.length, 0) > 512 * 1024 * 1024)
      throw new VmotionError('ARTWORK_LIMIT', 'Uncompressed artwork exceeds 512MB');
    const document = new DOMParser().parseFromString(
      Buffer.from(archive['stack.xml'] ?? []).toString(),
      'application/xml',
    );
    if (document.getElementsByTagName('parsererror').length)
      throw new VmotionError('ORA_FORMAT', 'Invalid OpenRaster stack.xml');
    async function visit(
      element: Element,
      inheritedX = 0,
      inheritedY = 0,
      inheritedOpacity = 1,
      inheritedVisible = true,
    ) {
      const children = Array.from(element.childNodes).filter(
        (n) => n.nodeType === 1,
      ) as unknown as Element[];
      for (const child of children.reverse()) {
        const x = inheritedX + Number(child.getAttribute('x') ?? 0),
          y = inheritedY + Number(child.getAttribute('y') ?? 0),
          opacity = inheritedOpacity * Number(child.getAttribute('opacity') ?? 1),
          visible = inheritedVisible && child.getAttribute('visibility') !== 'hidden';
        if (child.tagName === 'stack') await visit(child, x, y, opacity, visible);
        else if (child.tagName === 'layer') {
          const source = child.getAttribute('src') ?? '',
            data = archive[source];
          if (!data) throw new VmotionError('ORA_LAYER', `Missing raster layer ${source}`);
          const { loadImage } = await import('@napi-rs/canvas'),
            image = await loadImage(Buffer.from(data));
          await layer(
            child.getAttribute('name') ?? 'Layer',
            data,
            x,
            y,
            image.width,
            image.height,
            opacity,
            visible,
          );
          const blend = child.getAttribute('composite-op');
          if (blend && blend !== 'svg:src-over')
            warnings.push(
              `Layer ${child.getAttribute('name')}: blend mode ${blend} was imported as normal.`,
            );
        }
      }
    }
    const stack = document.getElementsByTagName('stack')[0];
    if (!stack) throw new VmotionError('ORA_FORMAT', 'OpenRaster file has no layer stack');
    await visit(stack as unknown as Element);
  } else throw new VmotionError('ARTWORK_FORMAT', 'Expected PSD or OpenRaster artwork');
  if (operations.length === 1)
    throw new VmotionError('ARTWORK_EMPTY', 'Artwork contains no supported raster layers');
  return { operations, warnings };
}
