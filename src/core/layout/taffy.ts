/*
 * Synchronous bridge to the taffy flexbox/grid engine (crates/vmotion-layout, wasm32).
 * The wasm is embedded (zlib + base64) so component workers, CLI, MCP and packaged builds
 * all run the byte-identical engine; float math in wasm is IEEE-deterministic, and text
 * leaves call back into the host measurer (Skia via @napi-rs/canvas) synchronously.
 */
import { unzlibSync } from 'fflate';
import { wasmZlibBase64, wasmSha256 } from './taffy-wasm.generated.js';

/** Available space: a definite px value, or 'min' / 'max' content. */
export type LayoutSpace = number | 'min' | 'max';
export type LayoutMeasure = (
  index: number,
  known: { width?: number; height?: number },
  available: { width: LayoutSpace; height: LayoutSpace },
) => { width: number; height: number };

interface Exports {
  memory: WebAssembly.Memory;
  input_ptr(len: number): number;
  output_ptr(): number;
  measure_slot(): number;
  error_code(): number;
  compute(count: number, availW: number, availH: number): number;
}
let engine: Exports | undefined;
let activeMeasure: LayoutMeasure | undefined;

const decodeSpace = (v: number): LayoutSpace => (v === -1 ? 'min' : v === -2 ? 'max' : v);
function load(): Exports {
  if (engine) return engine;
  const bytes = unzlibSync(Uint8Array.from(Buffer.from(wasmZlibBase64, 'base64')));
  const module = new WebAssembly.Module(bytes);
  let exports: Exports | undefined;
  const instance = new WebAssembly.Instance(module, {
    env: {
      measure(index: number, kw: number, kh: number, aw: number, ah: number) {
        const size = activeMeasure
          ? activeMeasure(
              index,
              {
                width: Number.isNaN(kw) ? undefined : kw,
                height: Number.isNaN(kh) ? undefined : kh,
              },
              { width: decodeSpace(aw), height: decodeSpace(ah) },
            )
          : { width: 0, height: 0 };
        const view = new Float32Array(exports!.memory.buffer, exports!.measure_slot(), 2);
        view[0] = Number.isFinite(size.width) ? size.width : 0;
        view[1] = Number.isFinite(size.height) ? size.height : 0;
      },
    },
  });
  exports = instance.exports as unknown as Exports;
  engine = exports;
  return exports;
}

export interface LayoutResult {
  x: number;
  y: number;
  width: number;
  height: number;
}
/**
 * Lay out an encoded node stream (see crates/vmotion-layout/src/lib.rs for the format).
 * `available` is the space offered to the root (usually its parent group's box).
 */
export function computeLayout(
  stream: ArrayLike<number>,
  count: number,
  available: { width: LayoutSpace; height: LayoutSpace },
  measure?: LayoutMeasure,
): LayoutResult[] {
  const e = load();
  const ptr = e.input_ptr(stream.length);
  new Float32Array(e.memory.buffer, ptr, stream.length).set(stream);
  const enc = (v: LayoutSpace) => (v === 'min' ? -1 : v === 'max' ? -2 : v);
  const previous = activeMeasure;
  activeMeasure = measure;
  let code: number;
  try {
    code = e.compute(count, enc(available.width), enc(available.height));
  } finally {
    activeMeasure = previous;
  }
  if (code !== 0) throw new Error(`layout engine rejected the node stream (code ${code})`);
  const out = new Float32Array(e.memory.buffer, e.output_ptr(), count * 4);
  const result: LayoutResult[] = [];
  for (let i = 0; i < count; i++)
    result.push({ x: out[i * 4], y: out[i * 4 + 1], width: out[i * 4 + 2], height: out[i * 4 + 3] });
  return result;
}
export const layoutEngineInfo = () => ({ engine: 'taffy 0.9.2 (wasm32)', wasmSha256 });
