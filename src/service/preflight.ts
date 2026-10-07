import path from 'node:path';
import { z } from 'zod';
import { createCanvas } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import {
  operationSchema,
  VmotionError,
  type Snapshot,
  type Diagnostic,
  type Operation,
} from '../core/model.js';
import { fileEditSchema } from '../core/file-edits.js';
import { applyOperations } from './operations.js';
import { validateSnapshot, atomicWrite, safePath, hash } from './project.js';
import { changedFiles, errorDiagnostics } from './agent.js';
import { visualAudit } from './visual-audit.js';
import { visualOptionsSchema } from '../core/visual-audit.js';
import { contextFramesSchema } from '../core/content-time.js';
import { assetCheckSchema, checkAssets } from './media-evidence.js';
export const preflightSchema = z
  .object({
    version: z.enum(['active', 'pending']).default('active'),
    revision: z.string().optional(),
    planId: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    operations: z.array(operationSchema).max(1000).default([]),
    files: z.array(fileEditSchema).max(1000).default([]),
    assetChecks: z.array(assetCheckSchema).max(1000).default([]),
    samples: z
      .array(
        z
          .object({
            frame: z.number().finite().nonnegative(),
            sceneId: z.string().optional(),
            sequenceId: z.string().optional(),
            path: z.array(z.string()).max(32).default([]),
            contextFrames: contextFramesSchema.default([]),
          })
          .strict(),
      )
      .max(12)
      .default([]),
    width: z.number().int().min(160).max(800).default(640),
    determinism: z.boolean().default(false),
    visual: z.boolean().default(false),
    visualOptions: visualOptionsSchema.optional(),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export type PreflightRequest = z.input<typeof preflightSchema>;
export async function preflight(root: string, base: Snapshot, raw: PreflightRequest = {}) {
  const params = preflightSchema.parse(raw);
  if (params.planId)
    throw new VmotionError(
      'AGENT_PLAN',
      'Resolve stored plans through the project service before preflight',
    );
  if (params.revision && params.revision !== base.revision)
    throw new VmotionError(
      'REVISION_CONFLICT',
      'The project changed; inspect the current revision and retry',
      { expected: params.revision, actual: base.revision },
    );
  const diagnostics: Diagnostic[] = [],
    operations: Operation[] = [
      ...params.operations,
      ...(params.files.length ? [{ type: 'editFiles' as const, edits: params.files }] : []),
    ];
  let candidate: Snapshot | undefined;
  try {
    candidate = operations.length ? applyOperations(root, base, operations) : structuredClone(base);
    await checkAssets(root, candidate, params.assetChecks);
    diagnostics.push(...(await validateSnapshot(root, candidate)));
  } catch (e) {
    diagnostics.push(...errorDiagnostics(e));
  }
  const renderer = new Renderer(root),
    samples: Array<{
      frame: number;
      sceneId?: string;
      sequenceId?: string;
      path: string[];
      status: 'passed' | 'failed';
      pixelHash?: string;
      renderMs?: number;
    }> = [];
  let output: string | undefined, data: string | undefined;
  const visualReports: Array<Awaited<ReturnType<typeof visualAudit>>> = [];
  try {
    if (candidate && !diagnostics.some((d) => d.severity === 'error')) {
      diagnostics.push(...renderer.components.typecheck(candidate));
      if (!diagnostics.some((d) => d.severity === 'error'))
        try {
          await renderer.components.validate(candidate);
        } catch (e) {
          diagnostics.push(...errorDiagnostics(e));
        }
      if (!diagnostics.some((d) => d.severity === 'error') && params.samples.length) {
        const tileHeight = Math.round((params.width * 9) / 16),
          columns = Math.min(4, params.samples.length),
          sheet = createCanvas(
            columns * params.width,
            Math.ceil(params.samples.length / columns) * (tileHeight + 28),
          ),
          ctx = sheet.getContext('2d');
        ctx.fillStyle = '#121b2b';
        ctx.fillRect(0, 0, sheet.width, sheet.height);
        for (const [index, sample] of params.samples.entries()) {
          const x = (index % columns) * params.width,
            y = Math.floor(index / columns) * (tileHeight + 28),
            start = performance.now();
          ctx.fillStyle = '#d1def2';
          ctx.font = '14px "Microsoft YaHei"';
          ctx.fillText(
            `${sample.sceneId ?? sample.sequenceId ?? 'sequence'} · ${sample.frame}f`,
            x + 10,
            y + 19,
          );
          try {
            if (sample.sceneId && sample.sequenceId)
              throw new VmotionError('SAMPLE_SCOPE', 'Choose a scene or sequence, not both');
            const renderSnapshot = sample.sequenceId
              ? {
                  ...candidate,
                  project: { ...candidate.project, activeSequence: sample.sequenceId },
                }
              : candidate;
            const scope = sample.path.length
                ? await renderer.inspectComposition(
                    candidate,
                    sample.sceneId ?? candidate.scenes[0].id,
                    sample.frame,
                    sample.path,
                    sample.contextFrames,
                  )
                : undefined,
              width = scope?.width ?? candidate.project.width,
              height = scope?.height ?? candidate.project.height,
              scale = Math.min(params.width / width, tileHeight / height),
              options = {
                sceneId: sample.sceneId,
                path: sample.path,
                contextFrames: sample.contextFrames,
                width: Math.max(16, Math.round(width * scale)),
                height: Math.max(16, Math.round(height * scale)),
              },
              image = await renderer.render(renderSnapshot, sample.frame, options),
              pixels = image.getContext('2d').getImageData(0, 0, image.width, image.height).data,
              pixelHash = hash(Buffer.from(pixels));
            ctx.drawImage(
              image,
              x + (params.width - image.width) / 2,
              y + 28 + (tileHeight - image.height) / 2,
            );
            if (params.determinism) {
              const again = await renderer.render(renderSnapshot, sample.frame, options),
                other = hash(
                  Buffer.from(
                    again.getContext('2d').getImageData(0, 0, again.width, again.height).data,
                  ),
                );
              again.width = 1;
              again.height = 1;
              if (other !== pixelHash)
                throw new VmotionError(
                  'NONDETERMINISTIC_FRAME',
                  'Rendering the same frame twice produced different pixels',
                );
            }
            image.width = 1;
            image.height = 1;
            samples.push({
              ...sample,
              status: 'passed',
              pixelHash,
              renderMs: Math.round(performance.now() - start),
            });
          } catch (e) {
            samples.push({ ...sample, status: 'failed' });
            diagnostics.push(
              ...errorDiagnostics(e).map((d) => ({
                ...d,
                path: `${sample.sceneId ?? 'sequence'}@${sample.frame}f${d.path ?? ''}`,
              })),
            );
            ctx.fillStyle = '#efacbb';
            ctx.font = '14px "Microsoft YaHei"';
            ctx.fillText('预检失败 · 查看诊断', x + 10, y + tileHeight / 2);
          }
        }
        const buffer = await sheet.encode('png');
        sheet.width = 1;
        sheet.height = 1;
        const sampleKey = hash(
          JSON.stringify({
            samples: params.samples,
            width: params.width,
            determinism: params.determinism,
          }),
        ).slice(0, 20);
        output = path.resolve(
          params.output ??
            safePath(root, `.vmotion/preflight/${candidate.revision}-${sampleKey}.png`),
        );
        await atomicWrite(output, buffer);
        if (params.inline) data = buffer.toString('base64');
      }
      if (params.visual && !diagnostics.some((d) => d.severity === 'error')) {
        const groups = new Map<
          string,
          { sceneId: string; path: string[]; frames: number[]; contextFrames: number[] }
        >();
        for (const sample of params.samples) {
          if (!sample.sceneId) continue;
          const key = JSON.stringify([sample.sceneId, sample.path, sample.contextFrames]),
            group = groups.get(key) ?? {
              sceneId: sample.sceneId,
              path: sample.path,
              contextFrames: sample.contextFrames,
              frames: [],
            };
          group.frames.push(sample.frame);
          groups.set(key, group);
        }
        if (!groups.size)
          diagnostics.push({
            severity: 'warning',
            code: 'VISUAL_SCOPE',
            message: 'Visual audit requires samples with sceneId; no scene geometry was checked',
          });
        for (const group of groups.values()) {
          const report = await visualAudit(root, candidate, {
            ...group,
            images: false,
            options: params.visualOptions,
          });
          visualReports.push(report);
          for (const finding of report.findings)
            diagnostics.push({
              severity: finding.severity === 'error' ? 'error' : 'warning',
              code: finding.code,
              message: finding.message,
              path: `${group.sceneId}@${finding.frame}f:${finding.nodeId}`,
            });
          diagnostics.push(...report.diagnostics);
        }
      }
    }
  } finally {
    await renderer.close();
  }
  if (candidate && !diagnostics.some((d) => d.severity === 'error')) {
    try {
      await checkAssets(root, candidate, params.assetChecks);
    } catch (e) {
      diagnostics.push(...errorDiagnostics(e));
    }
  }
  const result = {
    valid: !!candidate && !diagnostics.some((d) => d.severity === 'error'),
    baseRevision: base.revision,
    candidateRevision: candidate?.revision,
    assetChecks: params.assetChecks,
    changes: candidate ? changedFiles(base, candidate) : [],
    diagnostics,
    samples,
    ...(params.visual ? { visualReports } : {}),
    ...(output ? { output, mimeType: 'image/png' } : {}),
    ...(data ? { data } : {}),
  };
  return { result, candidate, operations };
}
