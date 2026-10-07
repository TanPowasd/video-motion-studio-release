import { loadImage, type Image } from '@napi-rs/canvas';
import { VideoDecoder } from '../../media/ffmpeg.js';
export class RenderMediaResources {
  readonly images = new Map<string, { image: Image; bytes: number }>();
  private imageBytes = 0;
  readonly decoders = new Map<string, VideoDecoder>();
  readonly decoderLeases = new Map<string, () => void>();
  quality: 'original' | 'auto' = 'original';
  readonly framing: 'direct' | 'concat';
  used: Array<{
    assetId?: string;
    proxy: boolean;
    decodeWidth: number;
    decodeHeight: number;
    path: string;
  }> = [];
  constructor(framing: 'direct' | 'concat' = 'direct') {
    this.framing = framing;
  }
  async image(key: string, source: string | Buffer): Promise<Image> {
    if (this.images.has(key)) {
      const value = this.images.get(key)!;
      this.images.delete(key);
      this.images.set(key, value);
      return value.image;
    }
    const image = await loadImage(source),
      bytes = image.width * image.height * 4;
    while (this.imageBytes + bytes > 128 * 1024 * 1024 && this.images.size) {
      const first = this.images.keys().next().value!;
      this.imageBytes -= this.images.get(first)!.bytes;
      this.images.delete(first);
    }
    if (bytes <= 128 * 1024 * 1024) {
      this.images.set(key, { image, bytes });
      this.imageBytes += bytes;
    }
    return image;
  }
  async clear() {
    await Promise.all([...this.decoders.values()].map((decoder) => decoder.close()));
    for (const release of this.decoderLeases.values()) release();
    this.decoders.clear();
    this.decoderLeases.clear();
    this.images.clear();
    this.imageBytes = 0;
  }
  info() {
    return {
      quality: this.quality,
      uses: this.used,
      framing: this.framing,
      decoders: [...this.decoders.values()].map((decoder) => decoder.diagnostics()),
    };
  }
}
