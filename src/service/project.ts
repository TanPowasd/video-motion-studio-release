import { readFile, mkdir, readdir, stat, copyFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, safePath, json, atomicWrite } from '../platform/project-files.js';
import {
  projectSchema,
  sceneSchema,
  sequenceSchema,
  VmotionError,
  type Snapshot,
  type Diagnostic,
  type Project,
  type Scene,
  type Sequence,
  type Node,
} from '../core/model.js';
import { z, type ZodTypeAny } from 'zod';
import { drawingDocumentSchema } from '../core/drawing-model.js';
import { programDefinition } from '../core/programs/program-host.js';
import { getNumericPath } from '../core/time.js';
import { parsePath } from '../core/vector.js';
import { declaredSceneLinks } from '../core/scene-links.js';
import { contentTiming, timeControlled } from '../core/content-time.js';
import { captionsSchema } from '../core/captions.js';
import { evaluateScene3D, type MeshInstance3D } from '../sdk/matrix3d.js';
import { resolveSceneMeshes } from '../core/mesh-resources.js';
import { meshDocumentSchema } from '../core/mesh-document.js';
import { motionTemplateSchema } from '../core/motion-template.js';
import { effectGraphSchema } from '../core/effect-graph-schema.js';
import { evaluateDrivers, hasDrivers, validateDriverSyntax } from '../core/drivers.js';
import { compileSound } from '../core/sound.js';
import { compileAudioMix } from '../core/audio-mix.js';
import { storyboardSchema } from '../core/storyboard.js';
import { trackingDocumentSchema } from '../core/tracking-schema.js';
import { ThemeResolver } from '../core/theme.js';
import { PluginRegistry } from '../core/plugins.js';
import { themeDocumentSchema } from '../core/theme-schema.js';
import { TemplateResolver } from '../core/template-resource.js';
import { templateDocumentSchema } from '../core/template-schema.js';
import { validateThemeColors } from './themes.js';
import {
  compileEffectGraph,
  effectGraphResource,
  resolveEffectGraph,
} from '../core/effect-graph.js';

export { hash, safePath, json, atomicWrite } from '../platform/project-files.js';
export function revision(files: Record<string, string>) {
  return hash(
    Object.keys(files)
      .sort()
      .map((f) => f + '\0' + files[f])
      .join('\0'),
  );
}
export async function sourceFiles(root: string, dir = 'components'): Promise<string[]> {
  const result: string[] = [];
  try {
    for (const entry of await readdir(safePath(root, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) result.push(...(await sourceFiles(root, relative)));
      else if (/\.(ts|tsx|json|py|wgsl)$/.test(entry.name)) result.push(relative);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
  return result;
}
export async function recoverJournal(root: string) {
  const file = safePath(root, '.vmotion/journal.json');
  try {
    const journal = JSON.parse(await readFile(file, 'utf8')) as {
      after: Record<string, string | null>;
      before: Record<string, string>;
      committed: boolean;
    };
    if (!journal.committed) {
      for (const [name, value] of Object.entries(journal.after)) {
        let current: string | undefined;
        try {
          current = await readFile(safePath(root, name), 'utf8');
        } catch (e) {
          if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
        }
        if (current !== journal.before[name] && current !== (value ?? undefined))
          throw new VmotionError(
            'RECOVERY_CONFLICT',
            `File ${name} changed after an interrupted save; the transaction backup and both versions were preserved`,
            { file: name, journal: file },
          );
      }
      for (const [name, value] of Object.entries(journal.after))
        if (value === null)
          await unlink(safePath(root, name)).catch((e) => {
            if (e.code !== 'ENOENT') throw e;
          });
        else await atomicWrite(safePath(root, name), value);
      await atomicWrite(file, json({ ...journal, committed: true }));
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}
export async function saveFiles(
  root: string,
  files: Record<string, string>,
  before: Record<string, string>,
) {
  const changed: Record<string, string | null> = {};
  for (const name of new Set([...Object.keys(before), ...Object.keys(files)]))
    if (files[name] !== before[name]) changed[name] = files[name] ?? null;
  if (!Object.keys(changed).length) return;
  for (const name of Object.keys(changed)) {
    let current: string | undefined;
    try {
      current = await readFile(safePath(root, name), 'utf8');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    if (current !== before[name])
      throw new VmotionError(
        'REVISION_CONFLICT',
        `File ${name} changed before saving; reload and merge before retrying`,
        { file: name },
      );
  }
  const journal = {
    id: randomUUID(),
    at: new Date().toISOString(),
    before,
    after: changed,
    committed: false,
  };
  await atomicWrite(safePath(root, '.vmotion/journal.json'), json(journal));
  await atomicWrite(safePath(root, `.vmotion/history/${journal.id}.json`), json(journal));
  for (const [name, text] of Object.entries(changed))
    if (text === null)
      await unlink(safePath(root, name)).catch((e) => {
        if (e.code !== 'ENOENT') throw e;
      });
    else await atomicWrite(safePath(root, name), text);
  await atomicWrite(safePath(root, '.vmotion/journal.json'), json({ ...journal, committed: true }));
}
export function parseFiles(files: Record<string, string>): Snapshot {
  const parse = (file: string, schema?: ZodTypeAny) => {
    let value: unknown;
    try {
      value = JSON.parse(files[file]);
    } catch (e) {
      const offset = (e as Error).message.match(/position (\d+)/)?.[1],
        position = offset === undefined ? undefined : Number(offset),
        prefix = position === undefined ? '' : (files[file] ?? '').slice(0, position);
      throw new VmotionError('INVALID_JSON', `Cannot parse ${file}: ${(e as Error).message}`, {
        file,
        ...(position === undefined
          ? {}
          : {
              line: prefix.split('\n').length,
              column: prefix.length - (prefix.lastIndexOf('\n') + 1) + 1,
            }),
      });
    }
    try {
      return schema ? schema.parse(value) : value;
    } catch (e) {
      if (e instanceof z.ZodError)
        throw new VmotionError('FORMAT_SCHEMA', `Invalid project data in ${file}`, {
          file,
          issues: e.issues,
        });
      throw e;
    }
  };
  const manifest = parse('project.vmotion.json');
  if (manifest && typeof manifest === 'object' && manifest.formatVersion !== 1)
    throw new VmotionError(
      'FORMAT_VERSION',
      `Unsupported project format ${manifest.formatVersion}; expected 1. The project was not modified.`,
    );
  const project = parse('project.vmotion.json', projectSchema) as Project;
  const scenes = project.scenes.map((f) => parse(f, sceneSchema) as Scene),
    sequences = project.sequences.map((f) => parse(f, sequenceSchema) as Sequence);
  return { project, scenes, sequences, files, revision: revision(files) };
}
export async function readProjectFiles(
  root: string,
  fallback?: Record<string, string>,
): Promise<Record<string, string>> {
  await recoverJournal(root);
  const files: Record<string, string> = {};
  files['project.vmotion.json'] = await readFile(safePath(root, 'project.vmotion.json'), 'utf8');
  let manifest: any;
  try {
    manifest = JSON.parse(files['project.vmotion.json']);
  } catch (e) {
    if (!fallback) throw e;
    manifest = JSON.parse(fallback['project.vmotion.json']);
  }
  const previous = fallback ? JSON.parse(fallback['project.vmotion.json']) : {},
    list = (key: string) =>
      manifest && Array.isArray(manifest[key]) ? manifest[key] : (previous[key] ?? []);
  for (const file of [
    ...list('scenes'),
    ...list('sequences'),
    ...list('drawings')
      .filter(
        (d: unknown) =>
          d && typeof d === 'object' && typeof (d as { path?: unknown }).path === 'string',
      )
      .map((d: { path: string }) => d.path),
    ...(await sourceFiles(root)),
  ]) {
    if (typeof file !== 'string') continue;
    try {
      files[file] = await readFile(safePath(root, file), 'utf8');
    } catch (e) {
      if (!fallback || (e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
  }
  return files;
}
export async function loadProject(root: string): Promise<Snapshot> {
  const files = await readProjectFiles(root);
  return parseFiles(files);
}
export function serialize(snapshot: Snapshot) {
  const files = { ...snapshot.files };
  files['project.vmotion.json'] = json(snapshot.project);
  snapshot.scenes.forEach((s, i) => (files[snapshot.project.scenes[i]] = json(s)));
  snapshot.sequences.forEach((s, i) => (files[snapshot.project.sequences[i]] = json(s)));
  return files;
}
export async function validateSnapshot(root: string, snapshot: Snapshot): Promise<Diagnostic[]> {
  const themes = new ThemeResolver(),
    templates = new TemplateResolver();
  const issues: Diagnostic[] = [];
  const error = (code: string, message: string, file?: string) =>
    issues.push({ severity: 'error', code, message, file });
  try {
    new PluginRegistry().resolve(snapshot);
  } catch (e) {
    error(
      e instanceof VmotionError ? e.code : 'PLUGIN_MANIFEST',
      (e as Error).message,
      e instanceof VmotionError ? (e.details as { file?: string })?.file : undefined,
    );
  }
  for (const [file, source] of Object.entries(snapshot.files).filter(
    ([file]) => file.startsWith('components/') && file.endsWith('.json'),
  )) {
    try {
      const value = JSON.parse(source);
      if (value?.kind === 'render-program') programDefinition(snapshot, file);
      if (value?.kind === 'storyboard' || file.startsWith('components/storyboards/'))
        storyboardSchema.parse(value);
      if (value?.kind === 'tracking' || file.startsWith('components/tracking/'))
        trackingDocumentSchema.parse(value);
      if (value?.kind === 'theme' || file.startsWith('components/themes/')) {
        validateThemeColors(themeDocumentSchema.parse(value));
        themes.prepare(snapshot, file);
      }
      if (value?.kind === 'scene-template' && value.sceneId) {
        templateDocumentSchema.parse(value);
        templates.resolve(snapshot, file);
      }
      if (value?.kind === 'sound' || file.startsWith('components/sounds/')) compileSound(value);
      if (value?.kind === 'mesh3d' || file.startsWith('components/meshes/'))
        meshDocumentSchema.parse(value);
      if (value?.kind === 'motion-template' || file.startsWith('components/motions/'))
        motionTemplateSchema.parse(value);
      if (value?.kind === 'effect-graph' || file.startsWith('components/effects/'))
        compileEffectGraph(effectGraphSchema.parse(value), {}, (file) =>
          effectGraphResource(snapshot, file),
        );
    } catch (e) {
      error(
        file.startsWith('components/meshes/') ? 'MESH3D_DOCUMENT' : 'SOURCE_JSON',
        `Invalid JSON resource: ${(e as Error).message}`,
        file,
      );
    }
  }
  for (const [file, content] of Object.entries(snapshot.files))
    if (/^components\/captions-[\w-]+\.json$/.test(file)) {
      try {
        captionsSchema.parse(JSON.parse(content));
      } catch (e) {
        error('CAPTION_DOCUMENT', (e as Error).message, file);
      }
    }
  const sceneIds = new Set(snapshot.scenes.map((s) => s.id)),
    sequenceIds = new Set(snapshot.sequences.map((s) => s.id)),
    assets = new Set(snapshot.project.assets.map((a) => a.id));
  const allIds = [
    ...snapshot.scenes.map((s) => s.id),
    ...snapshot.sequences.map((s) => s.id),
    ...snapshot.project.assets.map((a) => a.id),
    ...snapshot.project.drawings.map((d) => d.id),
  ];
  for (const entry of snapshot.project.drawings) {
    try {
      safePath(root, entry.path);
      const doc = drawingDocumentSchema.parse(JSON.parse(snapshot.files[entry.path]));
      if (doc.id !== entry.id) throw new Error('画稿 ID 与清单不一致');
    } catch (e) {
      error('INVALID_DRAWING', (e as Error).message, entry.path);
    }
  }
  if (new Set(allIds).size !== allIds.length)
    error('DUPLICATE_ID', 'Scene, sequence and asset IDs must be unique');
  if (!sequenceIds.has(snapshot.project.activeSequence))
    error('MISSING_SEQUENCE', 'Active sequence does not exist');
  for (const [index, scene] of snapshot.scenes.entries()) {
    const file = snapshot.project.scenes[index],
      ids = new Set(scene.nodes.map((n) => n.id));
    if (ids.size !== scene.nodes.length)
      error('DUPLICATE_ID', `Duplicate node ID in ${scene.name}`, file);
    if (hasDrivers(scene.nodes))
      try {
        for (const node of scene.nodes) validateDriverSyntax(node);
        evaluateDrivers(scene.nodes, {
          frame: 0,
          fps: snapshot.project.fps.num / snapshot.project.fps.den,
          width: scene.width ?? snapshot.project.width,
          height: scene.height ?? snapshot.project.height,
          duration: scene.duration,
        });
      } catch (driverError) {
        error(
          driverError instanceof VmotionError ? driverError.code : 'DRIVER_INVALID',
          (driverError as Error).message,
          file,
        );
      }
    for (const node of scene.nodes) {
      try {
        const visit = (n: Node) => {
          const themed = themes.resolveNode(snapshot, n);
          if (n.templateInstance) {
            templates.metadata(snapshot, n);
            templates.apply(
              snapshot,
              themed,
              snapshot.scenes.find((s) => s.id === n.sceneId)?.nodes ?? [],
            );
          }
          for (const added of n.structure?.added ?? []) visit(added as Node);
          for (const nested of Object.values(n.structure?.nested ?? {}))
            for (const added of nested.added) visit(added as Node);
          for (const patch of Object.values(n.overrides)) {
            if (patch.theme) {
              const prepared = themes.prepare(snapshot, patch.theme.source);
              for (const id of Object.values(patch.theme.links))
                if (!prepared.tokens.has(id))
                  throw new VmotionError(
                    'THEME_TOKEN',
                    'Override refers to a missing theme token',
                    { tokenId: id },
                  );
            }
          }
        };
        visit(node);
      } catch (e) {
        error(e instanceof VmotionError ? e.code : 'THEME_VALUE', (e as Error).message, file);
      }
      try {
        const visit = (
          owner: {
            effects?: Node['effects'];
            programSource?: string;
            overrides?: Node['overrides'];
            structure?: Node['structure'];
          },
          depth = 0,
        ) => {
          if (depth > 32)
            throw new VmotionError(
              'NESTING_DEPTH',
              'Declared effect graph structure exceeds 32 levels',
            );
          if (owner.programSource) programDefinition(snapshot, owner.programSource);
          for (const effect of owner.effects ?? [])
            if (effect.type === 'program') programDefinition(snapshot, effect.source);
            else if (effect.type === 'effectGraph') {
              const compiled = resolveEffectGraph(snapshot, effect);
              for (const pass of compiled.nodes)
                if (pass.type === 'pass' && pass.effect.type === 'program')
                  programDefinition(snapshot, pass.effect.source);
              for (const slot of compiled.inputs)
                if (slot !== 'source' && !Object.hasOwn(effect.bindings, slot))
                  throw new VmotionError(
                    'EFFECT_GRAPH_BINDING',
                    'Named effect graph input requires a layer binding',
                    { slot },
                  );
            }
          for (const patch of Object.values(owner.overrides ?? {})) visit(patch, depth + 1);
          for (const added of [
            ...(owner.structure?.added ?? []),
            ...Object.values(owner.structure?.nested ?? {}).flatMap((value) => value.added),
          ])
            visit(added, depth + 1);
        };
        visit(node);
      } catch (errorValue) {
        error(
          errorValue instanceof VmotionError ? errorValue.code : 'EFFECT_GRAPH_DOCUMENT',
          `${node.id}: ${(errorValue as Error).message}`,
          file,
        );
      }
      if (node.type === 'scene3d') {
        if (!node.scene3d) error('SCENE3D_SOURCE', `${node.id}: missing 3D scene data`, file);
        else
          try {
            const data = resolveSceneMeshes(snapshot, node.scene3d);
            evaluateScene3D(
              node.id,
              data.instances as unknown as MeshInstance3D[],
              data.camera,
              data.options,
            );
          } catch (e) {
            error(
              e instanceof VmotionError ? e.code : 'SCENE3D_INVALID',
              `${node.id}: ${(e as Error).message}`,
              file,
            );
          }
      }
      const nestedData: Array<NonNullable<Node['scene3d']>> = [];
      const declared = (owner: Node, depth = 0) => {
        if (depth > 32)
          throw new VmotionError('NESTING_DEPTH', 'Declared 3D structure exceeds 32 levels');
        for (const patch of Object.values(owner.overrides))
          if (patch.scene3d) nestedData.push(patch.scene3d);
        for (const child of [
          ...(owner.structure?.added ?? []),
          ...Object.values(owner.structure?.nested ?? {}).flatMap((edit) => edit.added),
        ]) {
          if (child.scene3d) nestedData.push(child.scene3d);
          declared(child as Node, depth + 1);
        }
      };
      try {
        declared(node);
        for (const raw of nestedData) {
          const data = resolveSceneMeshes(snapshot, raw);
          evaluateScene3D(
            node.id,
            data.instances as unknown as MeshInstance3D[],
            data.camera,
            data.options,
          );
        }
      } catch (e) {
        error(
          e instanceof VmotionError ? e.code : 'SCENE3D_INVALID',
          `${node.id}: ${(e as Error).message}`,
          file,
        );
      }
      if (
        !timeControlled(node) &&
        (node.animations.some((a) => a.property.startsWith('timeMapping.')) ||
          node.timeMapping.mode !== 'linear' ||
          node.timeMapping.rate !== 1 ||
          node.timeMapping.offset !== 0 ||
          node.timeMapping.anchor !== 0 ||
          node.timeMapping.repeat !== 'continue')
      )
        error(
          'CONTENT_TIME_TYPE',
          `${node.id}: content clocks apply to video, components and scene references`,
          file,
        );
      if (timeControlled(node))
        try {
          contentTiming(snapshot, node, 0);
        } catch (e) {
          error(
            e instanceof VmotionError ? e.code : 'CONTENT_TIME',
            `${node.id}: ${(e as Error).message}`,
            file,
          );
        }
      if (node.type === 'path')
        try {
          parsePath(node.path, node.fillRule);
        } catch (e) {
          error('VECTOR_PATH', `${node.id}: ${(e as Error).message}`, file);
        }
      if (node.parentId && !ids.has(node.parentId))
        error('MISSING_PARENT', `${node.id}: missing parent ${node.parentId}`, file);
      if (node.maskId && !ids.has(node.maskId))
        error('MISSING_MASK', `${node.id}: missing mask ${node.maskId}`, file);
      if (node.maskId && scene.nodes.find((n) => n.id === node.maskId)?.parentId !== node.parentId)
        error('MASK_SPACE', `${node.id}: mask and target must share a parent`, file);
      for (const effect of node.effects) {
        if (
          effect.type === 'gradientMap' &&
          effect.stops.some((s, i) => i > 0 && s.offset <= effect.stops[i - 1].offset)
        )
          error('GRADIENT_MAP', `${node.id}: Gradient color stop offsets must increase`, file);
        if (effect.type === 'levels' && effect.inputBlack >= effect.inputWhite)
          error('LEVELS_RANGE', `${node.id}: input white must exceed input black`, file);
        if (
          effect.type === 'lut3d' &&
          (effect.data.length !== effect.size ** 3 * 3 ||
            effect.domainMax.some((v, i) => v <= effect.domainMin[i]))
        )
          error('LUT_FORMAT', `${node.id}: LUT data or domain mismatch`, file);
      }
      if (node.assetId && !assets.has(node.assetId))
        error('MISSING_ASSET', `${node.id}: missing asset ${node.assetId}`, file);
      if (node.audioAssetId && !assets.has(node.audioAssetId))
        error('MISSING_AUDIO', `${node.id}: missing audio ${node.audioAssetId}`, file);
      if (node.sceneId && !sceneIds.has(node.sceneId))
        error('MISSING_SCENE', `${node.id}: missing scene ${node.sceneId}`, file);
      if (node.type === 'scene' && !node.sceneId)
        error('MISSING_SCENE', `${node.id}: scene reference needs a source ID`, file);
      if (node.type === 'component' && (!node.component || !snapshot.files[node.component]))
        error('MISSING_COMPONENT', `${node.id}: missing component ${node.component}`, file);
      if (node.type === 'program' && !node.programSource)
        error('PROGRAM_SOURCE', `${node.id}: missing renderer manifest`, file);
      if (node.programSource) {
        try {
          programDefinition(snapshot, node.programSource);
        } catch (e) {
          error(
            e instanceof VmotionError ? e.code : 'PROGRAM_SOURCE',
            (e as Error).message,
            node.programSource,
          );
        }
      }
      const parents = new Set([node.id]);
      let parent = node.parentId;
      while (parent) {
        if (parents.has(parent)) {
          error('PARENT_CYCLE', `${node.id}: cyclic parent hierarchy`, file);
          break;
        }
        parents.add(parent);
        parent = scene.nodes.find((n) => n.id === parent)?.parentId;
      }
      if (new Set(node.animations.map((c) => c.property)).size !== node.animations.length)
        error('DUPLICATE_ANIMATION', `${node.id}: duplicate base animation properties`, file);
      for (const a of [
        ...node.animations,
        ...(node.animationLayers ?? []).flatMap((layer) => layer.channels),
      ]) {
        try {
          getNumericPath(node, a.property);
        } catch (e) {
          error('ANIMATION_TARGET', `${node.id}: ${(e as Error).message}`, file);
        }
        if (new Set(a.keys.map((k) => k.frame)).size !== a.keys.length)
          error('DUPLICATE_KEYFRAME', `${node.id}.${a.property}: duplicate keyframe times`, file);
      }
    }
  }
  for (const [index, sequence] of snapshot.sequences.entries()) {
    if (sequence.mix)
      try {
        compileAudioMix(sequence, snapshot.project.fps);
      } catch (e) {
        error(
          e instanceof VmotionError ? e.code : 'AUDIO_MIX',
          (e as Error).message,
          snapshot.project.sequences[index],
        );
      }
    if (sequence.workArea && sequence.workArea.end > sequence.duration)
      error(
        'EDIT_RANGE',
        `${sequence.id}: work area exceeds sequence duration`,
        snapshot.project.sequences[index],
      );
    const file = snapshot.project.sequences[index],
      ids = sequence.tracks.flatMap((t) => [t.id, ...t.clips.map((c) => c.id)]);
    if (new Set(ids).size !== ids.length)
      error('DUPLICATE_ID', `Duplicate track/clip ID in ${sequence.name}`, file);
    for (const track of sequence.tracks)
      for (const clip of track.clips) {
        if (clip.sourceOut !== undefined && clip.sourceOut <= clip.sourceIn)
          error('CLIP_SOURCE_RANGE', `${clip.id}: sourceOut must follow sourceIn`, file);
        const references = [clip.sceneId, clip.sequenceId, clip.assetId].filter(Boolean);
        if (references.length !== 1)
          error('CLIP_SOURCE', `${clip.id} must reference exactly one source`, file);
        if (clip.sceneId && !sceneIds.has(clip.sceneId))
          error('MISSING_SCENE', `${clip.id}: missing scene`, file);
        if (clip.sequenceId && !sequenceIds.has(clip.sequenceId))
          error('MISSING_SEQUENCE', `${clip.id}: missing sequence`, file);
        if (clip.assetId && !assets.has(clip.assetId))
          error('MISSING_ASSET', `${clip.id}: missing asset`, file);
      }
  }
  function cycles(ids: string[], links: (id: string) => string[], kind: string) {
    const lengths = new Map<string, number>(),
      visiting = new Set<string>();
    const visit = (id: string): number => {
      if (visiting.has(id)) {
        error('NESTING_CYCLE', `Cyclic ${kind}: ${[...visiting, id].join(' → ')}`);
        return 0;
      }
      if (lengths.has(id)) return lengths.get(id)!;
      if (visiting.size > 32) {
        error('NESTING_DEPTH', `${kind} nesting exceeds 32`);
        return 33;
      }
      visiting.add(id);
      let length = 0;
      for (const child of new Set(links(id))) length = Math.max(length, 1 + visit(child));
      visiting.delete(id);
      lengths.set(id, length);
      return length;
    };
    for (const id of ids) if (visit(id) > 32) error('NESTING_DEPTH', `${kind} nesting exceeds 32`);
  }
  const sceneLinks = declaredSceneLinks(snapshot);
  for (const link of sceneLinks)
    if (!sceneIds.has(link.sceneId))
      error(
        'MISSING_SCENE',
        `Missing referenced scene ${link.sceneId}`,
        link.sourceSceneId
          ? snapshot.project.scenes[snapshot.scenes.findIndex((s) => s.id === link.sourceSceneId)]
          : undefined,
      );
  cycles(
    snapshot.scenes.map((s) => s.id),
    (id) => sceneLinks.filter((link) => link.sourceSceneId === id).map((link) => link.sceneId),
    'scene',
  );
  cycles(
    snapshot.sequences.map((s) => s.id),
    (id) =>
      snapshot.sequences
        .find((s) => s.id === id)
        ?.tracks.flatMap((t) => t.clips.flatMap((c) => (c.sequenceId ? [c.sequenceId] : []))) ?? [],
    'sequence',
  );
  for (const asset of snapshot.project.assets) {
    if (asset.soundSource) {
      try {
        if (
          asset.type !== 'audio' ||
          asset.path !== asset.soundSource ||
          !asset.soundSource.startsWith('components/sounds/') ||
          !asset.soundSource.endsWith('.json')
        )
          throw new Error('Sound assets use their components/sounds JSON as path and soundSource');
        const sound = compileSound(JSON.parse(snapshot.files[asset.soundSource]));
        for (const track of sound.document.tracks)
          if (track.instrument.type === 'sample') {
            const sampleId = track.instrument.assetId,
              source = snapshot.project.assets.find((a) => a.id === sampleId);
            if (!source || !['audio', 'video'].includes(source.type) || source.soundSource)
              throw new Error(`Invalid or recursive sample asset ${track.instrument.assetId}`);
          }
      } catch (e) {
        error('SOUND_DOCUMENT', (e as Error).message, asset.soundSource);
      }
      continue;
    }
    try {
      const info = await stat(path.resolve(root, asset.path));
      if (!info.isFile()) error('MISSING_ASSET', `${asset.name} is not a file`, asset.path);
    } catch {
      error('MISSING_ASSET', `${asset.name}: cannot read ${asset.path}`, asset.path);
    }
  }
  return issues;
}
export async function collectAssets(root: string, target: string, snapshot: Snapshot) {
  if (path.resolve(target) === path.resolve(root))
    throw new VmotionError('PACK_TARGET', 'Pack destination must differ from the source project');
  await mkdir(target, { recursive: true });
  const copy = structuredClone(snapshot);
  for (const asset of copy.project.assets) {
    if (asset.soundSource) continue;
    const name = `assets/${asset.id.replace(/[^\w-]/g, '_')}${path.extname(asset.path)}`;
    await mkdir(path.dirname(safePath(target, name)), { recursive: true });
    await copyFile(path.resolve(root, asset.path), safePath(target, name));
    asset.path = name;
    asset.managed = true;
  }
  for (const [name, content] of Object.entries(serialize(copy)))
    await atomicWrite(safePath(target, name), content);
  for (const file of ['AGENTS.md'])
    try {
      await copyFile(safePath(root, file), safePath(target, file));
    } catch {}
  return {
    path: path.resolve(target),
    assets: copy.project.assets.length,
    revision: revision(serialize(copy)),
  };
}
