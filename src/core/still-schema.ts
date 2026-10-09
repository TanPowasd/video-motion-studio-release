import { z } from 'zod';

/** Largest side of a still artboard or export (posters at print resolution). */
export const STILL_MAX_SIDE = 8192;
/** Pixel budget for one still render surface (A3 300dpi with bleed fits at 1x, A4 at 2x). */
export const STILL_MAX_PIXELS = 48_000_000;
/** Unchanged limits for animated scenes, sequences and video export. */
export const VIDEO_MAX_WIDTH = 3840;
export const VIDEO_MAX_HEIGHT = 2160;

const finite = z.number().finite();
const id = z.string().min(1).max(200);

export const stillVariantSchema = z
  .object({
    id: id.regex(/^[\w.-]+$/, 'Variant ID may contain letters, digits, _ . -'),
    name: z.string().min(1).max(120),
    width: z.number().int().min(16).max(STILL_MAX_SIDE),
    height: z.number().int().min(16).max(STILL_MAX_SIDE),
    /**
     * contain: whole artboard letterboxed on the background; cover: fills and crops;
     * reflow: renders the design at the variant size so canvas-relative layout constraints adapt.
     */
    fit: z.enum(['contain', 'cover', 'reflow']).default('contain'),
    background: z.string().min(1).optional(),
    preset: z.string().max(64).optional(),
  })
  .strict();

export const stillSchema = z
  .object({
    /** Preset ID the artboard was created from (informational; size lives on the scene). */
    preset: z.string().max(64).optional(),
    /** Print resolution written into exported PNG/JPEG metadata. */
    dpi: z.number().int().min(36).max(2400).default(72),
    /** Bleed in artboard pixels on every side; the trim box sits `bleed` px inside the canvas edge. */
    bleed: finite.min(0).max(1024).default(0),
    /** Safe-area inset in artboard pixels measured from the trim box. */
    safeArea: finite.min(0).max(4096).default(0),
    /** Default export transparency for PNG/WebP (the scene background is omitted). */
    transparent: z.boolean().default(false),
    /** Additional export sizes for the same design. */
    variants: z
      .array(stillVariantSchema)
      .max(16)
      .default([])
      .superRefine((variants, ctx) => {
        if (new Set(variants.map((v) => v.id)).size !== variants.length)
          ctx.addIssue({ code: 'custom', message: 'Variant IDs must be unique' });
      }),
  })
  .strict();
export type StillSettings = z.infer<typeof stillSchema>;
export type StillVariant = z.infer<typeof stillVariantSchema>;

/** Throws a message when the size is outside the video or still render budget. */
export function renderSizeIssue(width: number, height: number, still: boolean): string | undefined {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width < 16 || height < 16)
    return 'Render size must be at least 16px';
  if (!still)
    return width > VIDEO_MAX_WIDTH || height > VIDEO_MAX_HEIGHT
      ? 'Render size must be between 16px and UHD 4K'
      : undefined;
  if (width > STILL_MAX_SIDE || height > STILL_MAX_SIDE)
    return `Still render sides must not exceed ${STILL_MAX_SIDE}px`;
  if (width * height > STILL_MAX_PIXELS)
    return `Still render exceeds the ${STILL_MAX_PIXELS / 1e6}MP pixel budget; lower the scale or size`;
  return undefined;
}
