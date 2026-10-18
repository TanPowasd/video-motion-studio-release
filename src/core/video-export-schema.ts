import { z } from 'zod';

/**
 * Video encoder selection. `auto` probes hardware encoders in platform priority and falls back
 * deterministically to software; `software` never touches a GPU encoder; the hardware names
 * require that backend and fail clearly when it is unavailable. Any other string is treated as a
 * raw FFmpeg encoder name (legacy `encoder: "libx264"` behaviour).
 */
export const encoderModes = [
  'auto',
  'software',
  'nvenc',
  'qsv',
  'amf',
  'mediafoundation',
  'videotoolbox',
  'vaapi',
] as const;
export type EncoderMode = (typeof encoderModes)[number];
export const hardwareEncoderModes = encoderModes.filter(
  (m) => m !== 'auto' && m !== 'software',
) as Exclude<EncoderMode, 'auto' | 'software'>[];
export type HardwareEncoderMode = (typeof hardwareEncoderModes)[number];
export const encoderModeSchema = z.enum(encoderModes);
export const videoCodecs = ['h264', 'hevc', 'av1'] as const;
export type VideoCodec = (typeof videoCodecs)[number];
export const videoCodecSchema = z.enum(videoCodecs);
/** Encoder name accepted by render requests: a mode or a raw FFmpeg encoder name. */
export const encoderRequestSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_.-]+$/, 'Encoder must be a mode or an FFmpeg encoder name');

export const videoQualitySchema = z
  .object({
    /** Constant-quality value on the familiar CRF scale (0 best). Mapped to cq/global_quality/qp/quality per encoder. */
    crf: z.number().int().min(0).max(63).optional(),
    /** Target bitrate in kbit/s; takes precedence over crf. */
    bitrateKbps: z.number().int().min(100).max(400000).optional(),
    /** Speed/quality tier mapped to each encoder's preset scale. */
    preset: z.enum(['speed', 'balanced', 'quality']).optional(),
    /** Keyframe (GOP) interval in frames. */
    keyframeInterval: z.number().int().min(1).max(1200).optional(),
    /** 10-bit output (HEVC/AV1 only). */
    bitDepth: z.union([z.literal(8), z.literal(10)]).optional(),
  })
  .strict();
export type VideoQuality = z.infer<typeof videoQualitySchema>;

/** Project-level MP4 export defaults; render requests override each field. */
export const videoExportSchema = z
  .object({
    encoder: encoderModeSchema.optional(),
    codec: videoCodecSchema.optional(),
    quality: videoQualitySchema.optional(),
  })
  .strict();
export type VideoExportSettings = z.infer<typeof videoExportSchema>;
