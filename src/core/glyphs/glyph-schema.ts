import { z } from 'zod';

/**
 * Radical-composed glyph sets (偏旁部件拼字). A set lives at
 * components/glyphs/<id>.vmglyph.json and needs no font file: components are vector
 * strokes/outlines in a 0..em design box and characters are Unicode IDS compositions.
 */
const finite = z.number().finite();
const fraction = finite.min(0).max(1);
export const GLYPH_SET_ID = /^[a-z0-9][a-z0-9-]{0,62}$/;
export const glyphSetIdSchema = z
  .string()
  .regex(GLYPH_SET_ID, 'Glyph set IDs use lowercase letters, digits and hyphens (max 63)');
/** Built-in sets are referenced as builtin:<id> and need no project file. */
export const glyphSetRefSchema = z
  .string()
  .regex(
    /^(builtin:)?[a-z0-9][a-z0-9-]{0,62}$/,
    'Use a project glyph set ID or builtin:<id> (lowercase letters, digits and hyphens)',
  );
export const glyphFallbackSchema = z.enum(['font', 'none', 'tofu']);
export type GlyphFallback = z.infer<typeof glyphFallbackSchema>;

const point = z.tuple([finite, finite]);
/** x, y, width, height as fractions of the parent placement box. */
export const glyphBoxSchema = z
  .tuple([fraction, fraction, finite.gt(0).max(1), finite.gt(0).max(1)])
  .refine(([x, y, w, h]) => x + w <= 1.0001 && y + h <= 1.0001, 'Box must stay inside 0..1');
const pathData = z
  .string()
  .min(1)
  .max(16384)
  .refine((d) => !/[Aa]/.test(d), 'Arc commands are not supported; use C/Q curves')
  .refine((d) => /^[\sMmLlHhVvCcSsQqTtZz0-9eE.,+-]+$/.test(d), 'Invalid SVG path data');

export const glyphStrokeSchema = z
  .object({
    /** Centerline polyline in em units (stroke order = array order). */
    points: z.array(point).min(2).max(256).optional(),
    /** Centerline SVG path (M/L/H/V/C/S/Q/T/Z) in em units. */
    d: pathData.optional(),
    /** Multiplier of the set's global stroke width. */
    width: finite.min(0.1).max(4).optional(),
    closed: z.boolean().optional(),
  })
  .strict()
  .refine((s) => Boolean(s.points) !== Boolean(s.d), 'A stroke needs exactly one of points or d');
export const glyphFillSchema = z
  .object({
    d: pathData,
    rule: z.enum(['nonzero', 'evenodd']).default('nonzero'),
  })
  .strict();

const shareSchema = finite.min(0.05).max(0.95);
export const glyphComponentSchema = z
  .object({
    name: z.string().max(100).optional(),
    /** Composed component: an IDS expression over other components. */
    ids: z.string().min(1).max(400).optional(),
    strokes: z.array(glyphStrokeSchema).max(64).default([]),
    fills: z.array(glyphFillSchema).max(64).default([]),
    /** Preferred share of the split when placed in ⿰/⿲ (width) or ⿱/⿳ (height). */
    prefer: z
      .object({ width: shareSchema.optional(), height: shareSchema.optional() })
      .strict()
      .optional(),
    /** Inset applied to the placement box: left, top, right, bottom fractions. */
    inset: z.tuple([fraction, fraction, fraction, fraction]).optional(),
    /** Region left open for the inner part when this component surrounds (⿴–⿺). */
    inner: glyphBoxSchema.optional(),
    tags: z.array(z.string().max(40)).max(8).optional(),
  })
  .strict();

export const glyphAdjustSchema = z
  .object({
    /** Split ratio(s) for ⿰⿱ (one value) or ⿲⿳ (two or three shares). */
    ratio: z.union([shareSchema, z.array(shareSchema).min(2).max(3)]).optional(),
    /** Inner region of a surround operator. */
    inner: glyphBoxSchema.optional(),
    /** Explicit placement box relative to the parent box (any child). */
    box: glyphBoxSchema.optional(),
    /** Translation as fractions of the node box. */
    offset: z.tuple([finite.min(-1).max(1), finite.min(-1).max(1)]).optional(),
    /** Scale around the node box centre. */
    scale: z.tuple([finite.min(0.1).max(3), finite.min(0.1).max(3)]).optional(),
  })
  .strict();
export type GlyphAdjust = z.infer<typeof glyphAdjustSchema>;

export const glyphEntrySchema = z.union([
  z.string().min(1).max(400),
  z
    .object({
      ids: z.string().min(1).max(400).optional(),
      strokes: z.array(glyphStrokeSchema).max(128).optional(),
      fills: z.array(glyphFillSchema).max(128).optional(),
      advance: finite.min(0).max(4000).optional(),
      /** Per-node layout overrides keyed by IDS node path ("" root, "0", "1.0", …). */
      adjust: z.record(z.string().regex(/^$|^\d(\.\d)*$/), glyphAdjustSchema).optional(),
    })
    .strict()
    .refine(
      (g) => Boolean(g.ids) || Boolean(g.strokes?.length) || Boolean(g.fills?.length),
      'A glyph needs an IDS expression or explicit strokes/fills',
    ),
]);
export type GlyphEntry = z.infer<typeof glyphEntrySchema>;

export const idsOperators = ['⿰', '⿱', '⿲', '⿳', '⿴', '⿵', '⿶', '⿷', '⿸', '⿹', '⿺', '⿻'] as const;
export type IdsOperator = (typeof idsOperators)[number];

export const glyphMetricsSchema = z
  .object({
    em: finite.min(16).max(4096).default(1000),
    ascent: finite.min(0).max(4096).default(880),
    descent: finite.min(0).max(4096).default(120),
    advance: finite.min(0).max(4096).default(1000),
    /** Advance of an ASCII space; ideographic space uses the default advance. */
    space: finite.min(0).max(4096).default(320),
    /** Margin between the em box and the composed body. */
    margin: finite.min(0).max(1000).default(70),
    /** Gap between split parts, in em units at full size. */
    gap: finite.min(0).max(400).default(36),
  })
  .strict();
export const glyphStyleSchema = z
  .object({
    strokeWidth: finite.min(1).max(400).default(72),
    cap: z.enum(['round', 'butt', 'square']).default('round'),
    join: z.enum(['round', 'miter', 'bevel']).default('round'),
    /** 0 keeps polyline corners sharp; 1 rounds them as far as the segments allow. */
    roundness: fraction.default(0.35),
    /** Italic slant in degrees (positive leans right). */
    slant: finite.min(-30).max(30).default(0),
    /** How much nested (smaller) parts thin their strokes: width × scale^k. */
    strokeScaling: fraction.default(0.3),
  })
  .strict();

export const glyphSetSchema = z
  .object({
    kind: z.literal('glyph-set'),
    version: z.literal(1),
    id: glyphSetIdSchema,
    name: z.string().min(1).max(100),
    description: z.string().max(2000).optional(),
    /** Inherit components/glyphs/style from another set (e.g. builtin:demo). */
    extends: glyphSetRefSchema.optional(),
    metrics: glyphMetricsSchema.default({}),
    style: glyphStyleSchema.default({}),
    /** Default ratio/inner box per IDS operator. */
    operators: z
      .record(
        z.enum(idsOperators),
        z
          .object({
            ratio: z.union([shareSchema, z.array(shareSchema).min(2).max(3)]).optional(),
            inner: glyphBoxSchema.optional(),
          })
          .strict(),
      )
      .default({}),
    components: z
      .record(z.string().min(1).max(40), glyphComponentSchema)
      .default({})
      .refine((v) => Object.keys(v).length <= 4096, 'At most 4096 components'),
    glyphs: z
      .record(z.string().min(1).max(16), glyphEntrySchema)
      .default({})
      .refine((v) => Object.keys(v).length <= 30000, 'At most 30000 glyphs'),
    /** Pair kerning in em units, keyed by the two characters ("AV"). */
    kerning: z.record(z.string().min(2).max(16), finite.min(-2000).max(2000)).default({}),
  })
  .strict();
export type GlyphSetDocument = z.infer<typeof glyphSetSchema>;
export type GlyphSetInput = z.input<typeof glyphSetSchema>;
export type GlyphComponent = z.infer<typeof glyphComponentSchema>;
export type GlyphStroke = z.infer<typeof glyphStrokeSchema>;
export type GlyphFill = z.infer<typeof glyphFillSchema>;
export const glyphSetFile = (id: string) => `components/glyphs/${id}.vmglyph.json`;
export const glyphSetFilePattern = /^components\/glyphs\/([a-z0-9][a-z0-9-]{0,62})\.vmglyph\.json$/;
