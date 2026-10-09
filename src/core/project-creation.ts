import { z } from 'zod';
import { stillPresetIds, stillTemplateIds } from './still.js';
import { STILL_MAX_SIDE, renderSizeIssue } from './still-schema.js';

export const projectCreationSchema = z
  .object({
    name: z.string().trim().min(1, '请输入项目名称').max(120),
    template: z.enum(['blank', 'science']).default('blank'),
    /** 'still' creates an image project: one 1-frame artboard, no timeline work needed. */
    kind: z.enum(['video', 'still']).default('video'),
    preset: z.enum(stillPresetIds).optional(),
    stillTemplate: z.enum(stillTemplateIds).default('poster'),
    width: z.number().int().min(16).max(STILL_MAX_SIDE).default(1920),
    height: z.number().int().min(16).max(STILL_MAX_SIDE).default(1080),
    fps: z
      .object({
        num: z.number().int().positive().max(60000),
        den: z.number().int().positive().max(1001),
      })
      .refine((v) => v.num / v.den >= 1 && v.num / v.den <= 60, '帧率需要在 1–60 fps 之间')
      .default({ num: 30, den: 1 }),
    durationSeconds: z.number().finite().min(1).max(7200).default(10),
  })
  .strict()
  .superRefine((value, ctx) => {
    const issue = renderSizeIssue(value.width, value.height, value.kind === 'still');
    if (issue)
      ctx.addIssue({
        code: 'custom',
        path: ['width'],
        message: value.kind === 'still' ? `图片尺寸超出范围：${issue}` : '视频画布需要在 3840×2160 以内',
      });
  });
export type ProjectCreation = z.infer<typeof projectCreationSchema>;
export type ProjectCreationInput = z.input<typeof projectCreationSchema>;
export type RecentProject = { root: string; name: string; openedAt: string; available?: boolean };
export type ProjectHome = { directory: string; recent: RecentProject[] };
