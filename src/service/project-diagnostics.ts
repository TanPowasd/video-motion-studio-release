import { z } from 'zod';
import { VmotionError } from '../core/model.js';
import type { ProjectService } from './service.js';
import { hash } from './project.js';

export const projectDiagnosticsSchema = z
  .object({
    section: z.enum(['diagnostics', 'conflicts', 'pendingFiles']).default('diagnostics'),
    revision: z.string().optional(),
    files: z.array(z.string().min(1)).min(1).max(100).optional(),
    severities: z
      .array(z.enum(['error', 'warning']))
      .min(1)
      .max(2)
      .optional(),
    codes: z.array(z.string().min(1)).min(1).max(100).optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: z.number().int().min(1).max(100).default(20),
    detail: z.boolean().default(false),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (p.section !== 'diagnostics')
      for (const name of ['severities', 'codes'] as const)
        if (p[name])
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [name],
            message: 'This filter only applies to diagnostics',
          });
  });

type DiagnosticService = Pick<
  ProjectService,
  'snapshot' | 'diagnostics' | 'conflicts' | 'pendingFiles'
>;

/** Page existing evidence without reloading, compiling, copying source or changing history. */
export function queryProjectDiagnostics(service: DiagnosticService, raw: unknown = {}) {
  const p = projectDiagnosticsSchema.parse(raw),
    revision = service.snapshot.revision;
  if (p.revision && p.revision !== revision)
    throw new VmotionError('REVISION_CONFLICT', 'Project diagnostics revision changed', {
      expected: p.revision,
      actual: revision,
    });
  const files = p.files ? new Set(p.files) : undefined,
    severities = p.severities ? new Set(p.severities) : undefined,
    codes = p.codes ? new Set(p.codes) : undefined,
    items: unknown[] = [];
  let available = 0,
    total = 0;
  const page = (matches: boolean, value: () => unknown) => {
    available++;
    if (!matches) return;
    if (total >= p.offset && total - p.offset < p.limit) items.push(value());
    total++;
  };
  if (p.section === 'diagnostics') {
    service.diagnostics.forEach((d, index) => {
      page(
        (!files || (!!d.file && files.has(d.file))) &&
          (!severities || severities.has(d.severity)) &&
          (!codes || codes.has(d.code)),
        () =>
          p.detail
            ? { ...d, index }
            : {
                index,
                severity: d.severity,
                code: d.code,
                file: d.file,
                path: d.path,
                line: d.line,
                column: d.column,
                message: d.message.slice(0, 240),
                ...(d.message.length > 240
                  ? { messageTruncated: true, messageChars: d.message.length }
                  : {}),
              },
      );
    });
  } else if (p.section === 'conflicts') {
    service.conflicts.forEach((c, index) =>
      page(!files || files.has(c.file), () =>
        p.detail ? { ...c, index } : { index, file: c.file, path: c.path },
      ),
    );
  } else if (service.pendingFiles) {
    for (const file of new Set([
      ...Object.keys(service.snapshot.files),
      ...Object.keys(service.pendingFiles),
    ])) {
      const before = service.snapshot.files[file],
        after = service.pendingFiles[file];
      if (before === after) continue;
      page(!files || files.has(file), () => ({
        file,
        status: before === undefined ? 'added' : after === undefined ? 'deleted' : 'modified',
        ...(p.detail
          ? {
              beforeHash: before === undefined ? null : hash(before),
              afterHash: after === undefined ? null : hash(after),
              beforeBytes: before === undefined ? 0 : Buffer.byteLength(before),
              afterBytes: after === undefined ? 0 : Buffer.byteLength(after),
            }
          : {}),
      }));
    }
  }
  const errors = service.diagnostics.filter((d) => d.severity === 'error').length,
    warnings = service.diagnostics.length - errors;
  return {
    revision,
    section: p.section,
    summary: {
      errors,
      warnings,
      conflicts: service.conflicts.length,
      pendingFiles: !!service.pendingFiles,
    },
    coverage: {
      available,
      filteredOut: available - total,
      returned: items.length,
      omitted: total - items.length,
    },
    total,
    offset: p.offset,
    ...(p.offset + items.length < total ? { nextOffset: p.offset + items.length } : {}),
    items,
  };
}
