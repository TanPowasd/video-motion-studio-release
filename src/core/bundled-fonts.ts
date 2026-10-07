import { GlobalFonts } from '@napi-rs/canvas';
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runtimeFile } from './bundled-runtime.js';
import { VmotionError } from './model.js';
let initialized = false;
let signature: { family: string; sha256: string[] } | undefined;
export function initializeBundledFonts() {
  if (initialized) return signature;
  const regular = runtimeFile('fonts/NotoSansSC-Regular.otf');
  if (!regular) return;
  const files = [regular, runtimeFile('fonts/NotoSansSC-Bold.otf')!];
  for (const file of files)
    if (!existsSync(file) || !GlobalFonts.registerFromPath(file, 'Vmotion Sans'))
      throw new VmotionError('FONT_RUNTIME', 'Bundled Chinese font is unavailable');
  initialized = true;
  signature = {
    family: 'Vmotion Sans',
    sha256: files.map((file) => createHash('sha256').update(readFileSync(file)).digest('hex')),
  };
  return signature;
}
export function nativeTextFont(weight: number, size: number, family: string) {
  initializeBundledFonts();
  return `${weight} ${size}px ${JSON.stringify(family)}${signature ? ', "Vmotion Sans"' : ''}`;
}
