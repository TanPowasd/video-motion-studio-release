import { rpc } from '../state/rpc-client.js';

export type GlyphSetSummary = {
  id: string;
  name?: string;
  builtin: boolean;
  file?: string;
  components?: number;
  glyphs?: number;
  style?: GlyphStyle;
  extends?: string;
  error?: string;
};
export type GlyphStyle = {
  strokeWidth: number;
  cap: 'round' | 'butt' | 'square';
  join: 'round' | 'miter' | 'bevel';
  roundness: number;
  slant: number;
  strokeScaling: number;
};
export type GlyphAdjust = {
  ratio?: number | number[];
  inner?: [number, number, number, number];
  offset?: [number, number];
  scale?: [number, number];
};
export type InspectResult = {
  revision: string;
  sets: GlyphSetSummary[];
  set?: { id: string; name: string; file?: string; style: GlyphStyle; components: number; glyphs: number };
  components?: { total: number; items: Array<{ id: string; name?: string; ids?: string; strokes: number }> };
  glyphs?: { total: number; items: Array<{ char: string; ids?: string; explicit?: boolean }> };
  project?: Array<{
    set: string;
    error?: string;
    layers?: number;
    ratio?: number;
    unique?: number;
    coveredUnique?: number;
    missingTotal?: number;
    missing?: Array<{ char: string; count: number; reason: string; needs?: string[]; where?: string[] }>;
  }>;
  expression?: { ok: boolean; ids?: string; leaves?: string[]; message?: string };
  data?: string;
};

export const inspectGlyphs = (request: Record<string, unknown>) =>
  rpc('glyphsInspect', { ...request, inline: true }) as Promise<InspectResult>;

/** Plan → preflight → apply as one undo step; returns the plan result. */
export async function applyGlyphPlan(request: Record<string, unknown>) {
  const plan = (await rpc('glyphsPlan', request)) as any;
  if (plan.unchanged) return plan;
  const check = (await rpc('projectPreflight', plan.candidate)) as any;
  if (!check.valid)
    throw new Error(
      (check.diagnostics ?? [])
        .filter((d: any) => d.severity === 'error')
        .map((d: any) => d.message)
        .join('\n') || '预检未通过',
    );
  await rpc('projectApply', plan.apply);
  return plan;
}
/** Preview a plan without applying it (style edits). */
export const previewGlyphPlan = (request: Record<string, unknown>) =>
  rpc('glyphsPlan', { ...request, inline: true }) as Promise<{ data?: string; brokenTotal?: number }>;

export const imageSrc = (data?: string) => (data ? `data:image/png;base64,${data}` : undefined);
export const fallbackLabels = { font: '用字体补缺', tofu: '显示缺字框', none: '不显示' } as const;
