import { z } from 'zod';
import path from 'node:path';
import { createCanvas, type SKRSContext2D } from '@napi-rs/canvas';
import { Renderer } from '../core/renderer.js';
import { VmotionError, type Snapshot, type Diagnostic } from '../core/model.js';
import {
  visualOptionsSchema,
  auditFrame,
  auditMotion,
  type VisualFinding,
  type LayerGeometry,
} from '../core/visual-audit.js';
import { atomicWrite, safePath, hash } from './project.js';
import { errorDiagnostics } from './agent.js';
import { contextFramesSchema } from '../core/content-time.js';
export const visualAuditSchema = z
  .object({
    sceneId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    revision: z.string().optional(),
    frames: z.array(z.number().finite().nonnegative()).min(1).max(60).optional(),
    options: visualOptionsSchema.default({}),
    images: z.boolean().default(true),
    width: z.number().int().min(160).max(800).default(480),
    maxImages: z.number().int().min(1).max(12).default(8),
    output: z.string().optional(),
    inline: z.boolean().default(false),
  })
  .strict();
export type VisualAuditRequest = z.input<typeof visualAuditSchema>;
type AuditFrame = {
  frame: number;
  status: 'passed' | 'failed';
  layerCount: number;
  findings: VisualFinding[];
  omitted: number;
  renderMs: number;
};
function annotation(
  ctx: SKRSContext2D,
  finding: VisualFinding,
  index: number,
  scale: number,
  dx: number,
  dy: number,
) {
  if (!finding.bounds) return;
  const b = finding.bounds,
    x = dx + b.x * scale,
    y = dy + b.y * scale,
    w = b.width * scale,
    h = b.height * scale;
  ctx.save();
  ctx.strokeStyle = finding.severity === 'error' ? '#ff759a' : '#ffc47d';
  ctx.lineWidth = 1.5;
  ctx.strokeRect(x, y, w, h);
  const label = String(index + 1),
    left = Math.max(dx, Math.min(dx + ctx.canvas.width - 24, x)),
    top = Math.max(dy + 14, y);
  ctx.fillStyle = ctx.strokeStyle;
  ctx.fillRect(left, top - 14, 20, 14);
  ctx.fillStyle = '#152039';
  ctx.font = '10px "Microsoft YaHei"';
  ctx.fillText(label, left + 5, top - 3);
  ctx.restore();
}
export async function visualAudit(root: string, snapshot: Snapshot, raw: VisualAuditRequest) {
  const request = visualAuditSchema.parse(raw);
  if (request.revision && request.revision !== snapshot.revision)
    throw new VmotionError('REVISION_CONFLICT', 'The project changed before visual audit', {
      expected: request.revision,
      actual: snapshot.revision,
    });
  const scene = snapshot.scenes.find((s) => s.id === request.sceneId);
  if (!scene) throw new VmotionError('NOT_FOUND', 'Scene not found');
  const focusRenderer = new Renderer(root);
  let duration = scene.duration;
  try {
    if (request.path.length)
      duration = (
        await focusRenderer.inspectComposition(
          snapshot,
          request.sceneId,
          0,
          request.path,
          request.contextFrames,
        )
      ).scene.duration;
  } finally {
    await focusRenderer.close();
  }
  const frames = [
      ...new Set(
        request.frames ?? [
          0,
          Math.floor((duration - 1) * 0.25),
          Math.floor((duration - 1) * 0.5),
          Math.floor((duration - 1) * 0.75),
          duration - 1,
        ],
      ),
    ].sort((a, b) => a - b),
    renderer = new Renderer(root),
    results: AuditFrame[] = [],
    findings: VisualFinding[] = [],
    diagnostics: Diagnostic[] = [],
    fps = snapshot.project.fps.num / snapshot.project.fps.den;
  let previous: { frame: number; geometry: LayerGeometry[] } | undefined,
    width = snapshot.project.width,
    height = snapshot.project.height,
    omitted = 0,
    output: string | undefined,
    data: string | undefined;
  try {
    for (const frame of frames) {
      const start = performance.now();
      let layerCount = 0,
        local: VisualFinding[] = [],
        lost = 0;
      try {
        const scope = await renderer.inspectComposition(
          snapshot,
          request.sceneId,
          frame,
          request.path,
          request.contextFrames,
        );
        width = scope.width;
        height = scope.height;
        const graph = await renderer.inspectInteractions(
          snapshot,
          request.sceneId,
          frame,
          request.path,
          { includeEmpty: true, contextFrames: request.contextFrames },
        );
        layerCount = graph.layers.length;
        const checked = auditFrame(graph.layers, width, height, frame, request.options);
        local = checked.findings;
        lost = checked.omitted;
        if (previous)
          local.push(
            ...auditMotion(
              previous.geometry,
              checked.geometry,
              previous.frame,
              frame,
              fps,
              width,
              height,
              request.options,
            ),
          );
        previous = { frame, geometry: checked.geometry };
        local = local.map((finding) => {
          const layer = graph.layers.find((l) => l.node.id === finding.nodeId);
          return layer
            ? { ...finding, contextFrames: layer.contextFrames, localFrame: layer.frame }
            : finding;
        });
        results.push({
          frame,
          status: 'passed',
          layerCount,
          findings: local,
          omitted: lost,
          renderMs: Math.round(performance.now() - start),
        });
      } catch (e) {
        const errors = errorDiagnostics(e);
        diagnostics.push(
          ...errors.map((d) => ({
            ...d,
            path: `${request.sceneId}@${frame}f${d.path ? ':' + d.path : ''}`,
          })),
        );
        local = [
          {
            frame,
            code: 'FRAME_ERROR',
            severity: 'error',
            nodeId: '',
            name: scene.name,
            path: request.path,
            contextFrames: request.contextFrames,
            message: errors.map((d) => d.message).join('; '),
          },
        ];
        results.push({
          frame,
          status: 'failed',
          layerCount,
          findings: local,
          omitted: 0,
          renderMs: Math.round(performance.now() - start),
        });
        previous = undefined;
      }
      for (const finding of local) {
        if (findings.length < request.options.maxFindings) findings.push(finding);
        else omitted++;
      }
      omitted += lost;
    }
    const evidence = results
      .slice()
      .sort(
        (a, b) =>
          b.findings.filter((f) => f.severity === 'error').length -
            a.findings.filter((f) => f.severity === 'error').length ||
          b.findings.length - a.findings.length ||
          a.frame - b.frame,
      )
      .slice(0, request.maxImages)
      .sort((a, b) => a.frame - b.frame);
    if (request.images && evidence.length) {
      const tileHeight = Math.round((request.width * 9) / 16),
        columns = Math.min(4, evidence.length),
        sheet = createCanvas(
          columns * request.width,
          Math.ceil(evidence.length / columns) * (tileHeight + 32),
        ),
        ctx = sheet.getContext('2d');
      ctx.fillStyle = '#101b2d';
      ctx.fillRect(0, 0, sheet.width, sheet.height);
      for (const [index, entry] of evidence.entries()) {
        const left = (index % columns) * request.width,
          top = Math.floor(index / columns) * (tileHeight + 32),
          scale = Math.min(request.width / width, tileHeight / height),
          renderWidth = Math.max(16, Math.round(width * scale)),
          renderHeight = Math.max(16, Math.round(height * scale)),
          dx = left + (request.width - renderWidth) / 2,
          dy = top + (tileHeight - renderHeight) / 2;
        try {
          const image = await renderer.render(snapshot, entry.frame, {
            sceneId: request.sceneId,
            path: request.path,
            contextFrames: request.contextFrames,
            width: renderWidth,
            height: renderHeight,
          });
          ctx.drawImage(image, dx, dy);
          image.width = 1;
          image.height = 1;
          ctx.save();
          ctx.beginPath();
          ctx.rect(left, top, request.width, tileHeight);
          ctx.clip();
          entry.findings.slice(0, 12).forEach((finding) => {
            const number = findings.indexOf(finding);
            if (number >= 0) annotation(ctx, finding, number, scale, dx, dy);
          });
          ctx.restore();
        } catch (e) {
          entry.status = 'failed';
          diagnostics.push(...errorDiagnostics(e));
          ctx.fillStyle = '#eda4b7';
          ctx.font = '13px "Microsoft YaHei"';
          ctx.fillText('画面生成失败 · 查看诊断', left + 10, top + tileHeight / 2);
        }
        ctx.fillStyle = '#bdd1ed';
        ctx.font = '12px "Microsoft YaHei"';
        ctx.fillText(
          `${entry.frame}f · ${(entry.frame / fps).toFixed(2)}s · ${entry.findings.length} 提示`,
          left + 10,
          top + tileHeight + 21,
        );
      }
      const buffer = await sheet.encode('png');
      sheet.width = 1;
      sheet.height = 1;
      output = path.resolve(
        request.output ??
          safePath(
            root,
            `.vmotion/visual-audit/${snapshot.revision}-${hash(JSON.stringify(request)).slice(0, 20)}.png`,
          ),
      );
      await atomicWrite(output, buffer);
      if (request.inline) data = buffer.toString('base64');
    }
    const objects = new Map<
      string,
      { nodeId: string; name: string; path: string[]; codes: Set<string>; frames: Set<number> }
    >();
    for (const finding of findings) {
      const key = JSON.stringify([finding.path, finding.nodeId]),
        object = objects.get(key) ?? {
          nodeId: finding.nodeId,
          name: finding.name,
          path: finding.path,
          codes: new Set<string>(),
          frames: new Set<number>(),
        };
      object.codes.add(finding.code);
      object.frames.add(finding.frame);
      objects.set(key, object);
    }
    return {
      revision: snapshot.revision,
      sceneId: scene.id,
      path: request.path,
      width,
      height,
      fps,
      frames: results.map(({ findings, ...result }) => ({
        ...result,
        findingCount: findings.length,
      })),
      findings: findings.map((finding, index) => ({
        ...finding,
        index: index + 1,
        id: hash(
          JSON.stringify([
            snapshot.revision,
            scene.id,
            request.path,
            finding.code,
            finding.frame,
            finding.previousFrame,
            request.contextFrames,
            finding.contextFrames,
            finding.localFrame,
            finding.nodeId,
            finding.relatedNodeId,
          ]),
        ).slice(0, 24),
        locator: {
          sceneId: scene.id,
          nodeId: finding.nodeId,
          path: finding.path,
          frame: finding.localFrame ?? finding.frame,
          contextFrames: finding.contextFrames ?? [],
        },
      })),
      objects: [...objects.values()].map((object) => ({
        ...object,
        codes: [...object.codes],
        frames: [...object.frames],
      })),
      summary: {
        errors: findings.filter((f) => f.severity === 'error').length,
        reviews: findings.filter((f) => f.severity === 'review').length,
        omitted,
        incomplete: omitted > 0,
        status:
          diagnostics.length || findings.some((f) => f.severity === 'error')
            ? 'failed'
            : omitted > 0
              ? 'incomplete'
              : findings.length
                ? 'review'
                : 'clear',
      },
      diagnostics,
      evidenceFrames: evidence.map((frame) => frame.frame),
      limitations: [
        '结果只覆盖所选时间点，未检查的帧可能存在其他问题',
        '文字重叠/遮挡按字形包围几何估算，需要目视确认',
        '遮罩、透明素材、效果和混合不做逐像素可见性证明',
        '场景引用、组件和图层组可展开；场景背景遮挡与公式专用排版暂未独立分析',
      ],
      ...(output ? { output, mimeType: 'image/png' } : {}),
      ...(data ? { data } : {}),
    };
  } finally {
    await renderer.close();
  }
}
