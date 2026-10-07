import { z } from 'zod';

export const projectCreationSchema = z
  .object({
    name: z.string().trim().min(1, '请输入项目名称').max(120),
    template: z.enum(['blank', 'science']).default('blank'),
    width: z.number().int().min(16).max(3840).default(1920),
    height: z.number().int().min(16).max(2160).default(1080),
    fps: z
      .object({
        num: z.number().int().positive().max(60000),
        den: z.number().int().positive().max(1001),
      })
      .refine((v) => v.num / v.den >= 1 && v.num / v.den <= 60, '帧率需要在 1–60 fps 之间')
      .default({ num: 30, den: 1 }),
    durationSeconds: z.number().finite().min(1).max(7200).default(10),
  })
  .strict();
export type ProjectCreation = z.infer<typeof projectCreationSchema>;
export type ProjectCreationInput = z.input<typeof projectCreationSchema>;
export type RecentProject = { root: string; name: string; openedAt: string; available?: boolean };
export type ProjectHome = { directory: string; recent: RecentProject[] };
