import {
  nodeSchema,
  sceneSchema,
  sequenceSchema,
  assetSchema,
  operationSchema,
  VmotionError,
  type Snapshot,
  type Operation,
} from '../core/model.js';
import { safePath, serialize, parseFiles, hash, revision } from './project.js';
import type { FileEdit } from '../core/file-edits.js';

export function applyOperations(root: string, input: Snapshot, raw: Operation[]): Snapshot {
  if (!raw.length || raw.length > 1000)
    throw new VmotionError('OPERATIONS', 'Expected 1–1000 operations');
  const operations = raw.map((op) => operationSchema.parse(op)) as Operation[],
    candidate = structuredClone(input);
  const fileEdits: FileEdit[] = [];
  const scene = (id: string) => {
    const value = candidate.scenes.find((s) => s.id === id);
    if (!value) throw new VmotionError('NOT_FOUND', `Scene ${id} not found`);
    return value;
  };
  const sequence = (id: string) => {
    const value = candidate.sequences.find((s) => s.id === id);
    if (!value) throw new VmotionError('NOT_FOUND', `Sequence ${id} not found`);
    return value;
  };
  const track = (seq: string, id: string) => {
    const value = sequence(seq).tracks.find((t) => t.id === id);
    if (!value) throw new VmotionError('NOT_FOUND', `Track ${id} not found`);
    return value;
  };
  for (const op of operations) {
    switch (op.type) {
      case 'editFiles':
        fileEdits.push(...op.edits);
        break;
      case 'writeDrawing': {
        const existing = candidate.project.drawings.find((d) => d.id === op.document.id),
          file = existing?.path ?? `drawings/${encodeURIComponent(op.document.id)}.json`;
        safePath(root, file);
        candidate.files[file] = JSON.stringify(op.document, null, 2) + '\n';
        if (existing) existing.name = op.document.name;
        else
          candidate.project.drawings.push({
            id: op.document.id,
            name: op.document.name,
            path: file,
          });
        break;
      }
      case 'removeDrawing': {
        const entry = candidate.project.drawings.find((d) => d.id === op.id);
        if (!entry) throw new VmotionError('NOT_FOUND', 'Drawing document not found');
        candidate.project.drawings = candidate.project.drawings.filter((d) => d.id !== op.id);
        delete candidate.files[entry.path];
        break;
      }
      case 'updateNode': {
        const s = scene(op.sceneId),
          i = s.nodes.findIndex((n) => n.id === op.nodeId);
        if (i < 0) throw new VmotionError('NOT_FOUND', `Node ${op.nodeId} not found`);
        s.nodes[i] = nodeSchema.parse({ ...s.nodes[i], ...op.patch, id: op.nodeId });
        break;
      }
      case 'addNode':
        scene(op.sceneId).nodes.push(nodeSchema.parse(op.node));
        break;
      case 'removeNode': {
        const s = scene(op.sceneId);
        if (!s.nodes.some((n) => n.id === op.nodeId))
          throw new VmotionError('NOT_FOUND', 'Node not found');
        const remove = new Set([op.nodeId]);
        let changed = true;
        while (changed) {
          changed = false;
          for (const n of s.nodes)
            if (n.parentId && remove.has(n.parentId) && !remove.has(n.id)) {
              remove.add(n.id);
              changed = true;
            }
        }
        s.nodes = s.nodes.filter((n) => !remove.has(n.id));
        for (const n of s.nodes) if (n.maskId && remove.has(n.maskId)) delete n.maskId;
        break;
      }
      case 'updateScene':
        Object.assign(
          scene(op.sceneId),
          sceneSchema.parse({ ...scene(op.sceneId), ...op.patch, id: op.sceneId }),
        );
        break;
      case 'addScene':
        candidate.scenes.push(sceneSchema.parse(op.scene));
        candidate.project.scenes.push(`scenes/${op.scene.id.replace(/[^\w-]/g, '_')}.json`);
        break;
      case 'removeScene': {
        const i = candidate.scenes.findIndex((s) => s.id === op.sceneId);
        if (i < 0) throw new VmotionError('NOT_FOUND', 'Scene not found');
        candidate.scenes.splice(i, 1);
        delete candidate.files[candidate.project.scenes[i]];
        candidate.project.scenes.splice(i, 1);
        break;
      }
      case 'updateSequence':
        Object.assign(
          sequence(op.sequenceId),
          sequenceSchema.parse({ ...sequence(op.sequenceId), ...op.patch, id: op.sequenceId }),
        );
        break;
      case 'addTrack':
        sequence(op.sequenceId).tracks.push(op.track);
        break;
      case 'removeTrack':
        sequence(op.sequenceId).tracks = sequence(op.sequenceId).tracks.filter(
          (t) => t.id !== op.trackId,
        );
        break;
      case 'addClip':
        if (track(op.sequenceId, op.trackId).locked)
          throw new VmotionError('TRACK_LOCKED', 'Unlock the target track before adding clips');
        track(op.sequenceId, op.trackId).clips.push(op.clip);
        break;
      case 'updateClip': {
        const t = track(op.sequenceId, op.trackId),
          c = t.clips.find((c) => c.id === op.clipId);
        if (!c) throw new VmotionError('NOT_FOUND', 'Clip not found');
        if (t.locked)
          throw new VmotionError('TRACK_LOCKED', 'Unlock the target track before editing clips');
        if (Object.hasOwn(op.patch, 'fadeIn') || Object.hasOwn(op.patch, 'fadeOut'))
          delete c.fadeWindow;
        Object.assign(c, op.patch, { id: op.clipId });
        break;
      }
      case 'removeClip': {
        const t = track(op.sequenceId, op.trackId);
        if (t.locked)
          throw new VmotionError('TRACK_LOCKED', 'Unlock the target track before removing clips');
        t.clips = t.clips.filter((c) => c.id !== op.clipId);
        break;
      }
      case 'updateProject':
        Object.assign(candidate.project, op.patch, {
          id: candidate.project.id,
          formatVersion: 1,
        });
        break;
      case 'addAsset':
        candidate.project.assets.push(assetSchema.parse(op.asset));
        break;
      case 'writeSource':
        safePath(root, op.path);
        if (!op.path.startsWith('components/') || !/\.(ts|tsx|json|py|wgsl)$/.test(op.path))
          throw new VmotionError(
            'SOURCE_PATH',
            'Project source must be a .ts, .tsx, .json, .py or .wgsl file below components/',
          );
        candidate.files[op.path] = op.content;
        break;
    }
  }
  const semantic = operations.some((op) => op.type !== 'editFiles' && op.type !== 'writeSource');
  if (semantic) candidate.files = serialize(candidate);
  const canonical = serialize(input);
  const touched = new Set<string>();
  for (const edit of fileEdits) {
    const file = edit.path;
    safePath(root, file);
    const alias = Object.keys(input.files).find(
      (existing) => existing !== file && existing.toLowerCase() === file.toLowerCase(),
    );
    if (alias)
      throw new VmotionError(
        'FILE_PATH',
        'Use the existing filename case to keep Windows projects portable',
        { file, existing: alias },
      );
    if (
      file.includes('\\') ||
      file.split('/').some((part) => part === '' || part === '.' || part === '..') ||
      !(
        file === 'project.vmotion.json' ||
        /^(components\/.*\.(ts|tsx|json|py|wgsl)|(scenes|sequences|drawings)\/.*\.json)$/.test(file)
      )
    )
      throw new VmotionError(
        'FILE_PATH',
        'Edit only project JSON or TypeScript below project source directories',
        { file },
      );
    if (touched.has(file.toLowerCase()))
      throw new VmotionError('FILE_EDITS', 'A transaction may edit each file only once', { file });
    touched.add(file.toLowerCase());
    if (operations.some((op) => op.type === 'writeSource' && op.path === file))
      throw new VmotionError(
        'FILE_EDITS',
        'Do not combine writeSource and editFiles on the same file',
        { file },
      );
    const original = input.files[file],
      actualHash = original === undefined ? null : hash(original);
    if (actualHash !== edit.expectedHash)
      throw new VmotionError(
        'FILE_HASH_CONFLICT',
        'File contents changed; read the current file and retry',
        { file, expected: edit.expectedHash, actual: actualHash },
      );
    if (semantic && candidate.files[file] !== canonical[file])
      throw new VmotionError(
        'FILE_EDITS',
        'Do not combine semantic operations and file edits on the same file',
        { file },
      );
    if (edit.type === 'delete') {
      delete candidate.files[file];
      continue;
    }
    if (edit.type === 'replace') {
      candidate.files[file] = edit.content;
      continue;
    }
    let text = original!;
    for (const replacement of edit.replacements) {
      const at = text.indexOf(replacement.before),
        next = at < 0 ? -1 : text.indexOf(replacement.before, at + 1);
      if (at < 0 || next >= 0)
        throw new VmotionError(
          'TEXT_MATCH',
          'Replacement text must occur exactly once; include more surrounding context',
          { file, matches: at < 0 ? 0 : 'multiple' },
        );
      text = text.slice(0, at) + replacement.after + text.slice(at + replacement.before.length);
    }
    candidate.files[file] = text;
  }
  const checked = parseFiles(candidate.files),
    allowed = new Set([
      'project.vmotion.json',
      ...checked.project.scenes,
      ...checked.project.sequences,
      ...checked.project.drawings.map((d) => d.path),
    ]);
  for (const file of Object.keys(checked.files)) {
    if (file.startsWith('components/') && /\.(ts|tsx|json|py|wgsl)$/.test(file)) continue;
    if (!allowed.has(file)) delete checked.files[file];
  }
  for (const edit of fileEdits)
    if (edit.type !== 'delete' && !allowed.has(edit.path) && !edit.path.startsWith('components/'))
      throw new VmotionError(
        'UNREFERENCED_FILE',
        'New scene, sequence or drawing files must be referenced by the project manifest',
        { file: edit.path },
      );
  checked.revision = revision(checked.files);
  return checked;
}
