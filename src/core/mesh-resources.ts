import { meshDocumentSchema } from './mesh-document.js';
import { VmotionError, type Snapshot } from './model.js';
import type { Scene3DData } from './scene3d-schema.js';
export function meshResource(snapshot: Snapshot, file: string) {
  if (!/^components\/(?!.*(?:^|\/)\.\.\/).+\.json$/.test(file) || file.includes('\\'))
    throw new VmotionError(
      'MESH3D_SOURCE',
      'Mesh resources must be tracked components/*.json project files',
      { file },
    );
  const source = snapshot.files[file];
  if (source === undefined)
    throw new VmotionError('MESH3D_SOURCE', 'Mesh resource is missing from this project revision', {
      file,
    });
  try {
    return meshDocumentSchema.parse(JSON.parse(source));
  } catch (e) {
    throw new VmotionError('MESH3D_DOCUMENT', `Invalid mesh resource: ${(e as Error).message}`, {
      file,
    });
  }
}
export function resolveSceneMeshes(snapshot: Snapshot, data: Scene3DData): Scene3DData {
  const cache = new Map<string, ReturnType<typeof meshResource>>();
  return {
    ...data,
    instances: data.instances.map((instance) => {
      if (instance.mesh && instance.meshSource)
        throw new VmotionError(
          'MESH3D_SOURCE',
          `Instance ${instance.id} must choose inline mesh or meshSource`,
        );
      if (!instance.meshSource) {
        if (!instance.mesh)
          throw new VmotionError('MESH3D_SOURCE', `Instance ${instance.id} has no mesh`);
        return instance;
      }
      const { meshSource, ...rest } = instance;
      if (!cache.has(meshSource)) cache.set(meshSource, meshResource(snapshot, meshSource));
      const document = cache.get(meshSource)!,
        attributes = document.attributes;
      return {
        ...rest,
        mesh: attributes?.normals.length
          ? {
              ...document.mesh,
              cornerNormals: attributes.faceNormals.map((face) =>
                face.map((i) => (i < 0 ? null : attributes.normals[i])),
              ),
            }
          : document.mesh,
      };
    }),
  };
}
