import { z } from 'zod';
import { hash } from './project.js';
import { VmotionError, type Diagnostic, type Snapshot } from '../core/model.js';
import type { ProjectService } from './service.js';
const bound = z.number().int().positive().max(1000);
export const contextOptionsSchema = z
  .object({
    sceneId: z.string().optional(),
    sequenceId: z.string().optional(),
    offset: z.number().int().nonnegative().default(0),
    limit: bound.default(100),
  })
  .strict();
export function agentContext(service: ProjectService, raw: unknown = {}) {
  const options = contextOptionsSchema.parse(raw),
    snapshot = service.snapshot,
    p = snapshot.project;
  const files = Object.entries(snapshot.files).map(([file, content]) => ({
    path: file,
    hash: hash(content),
    bytes: Buffer.byteLength(content),
    lines: content.split('\n').length,
  }));
  const scene = options.sceneId ? snapshot.scenes.find((s) => s.id === options.sceneId) : undefined,
    sequence = options.sequenceId
      ? snapshot.sequences.find((s) => s.id === options.sequenceId)
      : undefined;
  if (options.sceneId && !scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
  if (options.sequenceId && !sequence) throw new VmotionError('NOT_FOUND', 'Sequence not found');
  return {
    revision: snapshot.revision,
    project: {
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      fps: p.fps,
      colorSpace: p.colorSpace,
      activeSequence: p.activeSequence,
    },
    selection: service.selection,
    history: { canUndo: service.state().canUndo, canRedo: service.state().canRedo },
    diagnostics: service.diagnostics,
    conflicts: service.conflicts.map((c) => ({ file: c.file, path: c.path })),
    pendingFiles: !!service.pendingFiles,
    scenes: snapshot.scenes.map((s, i) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      file: p.scenes[i],
      layers: s.nodes.length,
      components: s.nodes
        .filter((n) => n.type === 'component')
        .map((n) => ({ id: n.id, source: n.component })),
    })),
    sequences: snapshot.sequences.map((s, i) => ({
      id: s.id,
      name: s.name,
      duration: s.duration,
      file: p.sequences[i],
      tracks: s.tracks.map((t) => ({
        id: t.id,
        name: t.name,
        type: t.type,
        clips: t.clips.length,
      })),
    })),
    assets: {
      total: p.assets.length,
      offset: options.offset,
      items: p.assets
        .slice(options.offset, options.offset + options.limit)
        .map((a) => ({ id: a.id, name: a.name, type: a.type, path: a.path, metadata: a.metadata })),
    },
    drawings: p.drawings,
    files: {
      total: files.length,
      offset: options.offset,
      items: files.slice(options.offset, options.offset + options.limit),
    },
    ...(scene
      ? {
          scene: {
            id: scene.id,
            total: scene.nodes.length,
            offset: options.offset,
            nodes: scene.nodes.slice(options.offset, options.offset + options.limit).map((n) => ({
              id: n.id,
              name: n.name,
              type: n.type,
              parentId: n.parentId,
              visible: n.visible,
              start: n.start,
              end: n.end,
              component: n.component,
              params: n.params,
              animations: n.animations.map((a) => ({
                property: a.property,
                keys: a.keys.length,
              })),
            })),
          },
        }
      : {}),
    ...(sequence
      ? {
          sequence: {
            id: sequence.id,
            tracks: sequence.tracks.map((t) => ({
              ...t,
              clips: t.clips.slice(options.offset, options.offset + options.limit),
            })),
          },
        }
      : {}),
  };
}
export const fileReadSchema = z
  .object({
    path: z.string(),
    startLine: z.number().int().positive().default(1),
    lineCount: bound.default(200),
    version: z.enum(['active', 'pending']).default('active'),
  })
  .strict();
export function readProjectFile(service: ProjectService, raw: unknown) {
  const options = fileReadSchema.parse(raw),
    files =
      options.version === 'pending'
        ? (service.pendingFiles ?? service.snapshot.files)
        : service.snapshot.files,
    content = files[options.path];
  if (content === undefined)
    throw new VmotionError('NOT_FOUND', 'Project source file not found', { file: options.path });
  const lines = content.split('\n'),
    start = options.startLine - 1,
    end = Math.min(lines.length, start + options.lineCount);
  return {
    revision: service.snapshot.revision,
    path: options.path,
    hash: hash(content),
    version: options.version,
    pending: options.version === 'pending' && !!service.pendingFiles,
    bytes: Buffer.byteLength(content),
    totalLines: lines.length,
    startLine: options.startLine,
    endLine: end,
    content: lines.slice(start, end).join('\n'),
    truncated: end < lines.length,
    nextLine: end < lines.length ? end + 1 : undefined,
  };
}
export function errorDiagnostics(error: unknown): Diagnostic[] {
  const detail = error instanceof VmotionError ? error.details : undefined;
  if (Array.isArray(detail) && detail.every((v) => v?.severity)) return detail;
  const code =
      error instanceof VmotionError
        ? error.code
        : error instanceof z.ZodError
          ? 'FORMAT_SCHEMA'
          : 'INTERNAL_ERROR',
    meta =
      detail && typeof detail === 'object'
        ? (detail as {
            file?: string;
            line?: number;
            column?: number;
            issues?: z.ZodIssue[];
            stack?: string;
            path?: string;
          })
        : {};
  if (meta.stack) {
    const at = meta.stack.match(
      /(?:\(|\s)(?:project-source:)?([^\n()]*components[/\\][^\n()]*\.(?:ts|tsx)):(\d+):(\d+)/,
    );
    if (at) {
      const file = at[1].replace(/\\/g, '/'),
        index = file.indexOf('components/');
      meta.file = index < 0 ? file : file.slice(index);
      meta.line = Number(at[2]);
      meta.column = Number(at[3]);
    }
  }
  if (meta.issues)
    return meta.issues.map((issue) => ({
      severity: 'error',
      code,
      message: issue.message,
      file: meta.file,
      path: '/' + issue.path.join('/'),
    }));
  if (error instanceof z.ZodError)
    return error.issues.map((issue) => ({
      severity: 'error',
      code,
      message: issue.message,
      path: '/' + issue.path.join('/'),
    }));
  return [
    {
      severity: 'error',
      code,
      message: (error as Error).message,
      ...(meta.file ? { file: meta.file } : {}),
      ...(meta.line ? { line: meta.line } : {}),
      ...(meta.column ? { column: meta.column } : {}),
      ...(meta.path ? { path: meta.path } : {}),
    },
  ];
}
export function changedFiles(base: Snapshot, candidate: Snapshot) {
  return [...new Set([...Object.keys(base.files), ...Object.keys(candidate.files)])]
    .filter((file) => base.files[file] !== candidate.files[file])
    .map((file) => ({
      path: file,
      status:
        base.files[file] === undefined
          ? 'added'
          : candidate.files[file] === undefined
            ? 'deleted'
            : 'modified',
      beforeHash: base.files[file] === undefined ? null : hash(base.files[file]),
      afterHash: candidate.files[file] === undefined ? null : hash(candidate.files[file]),
    }));
}
