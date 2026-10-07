import { material3dSchema, type Material3D } from '../core/material3d-schema.js';
export type { Material3D, Light3D } from '../core/material3d-schema.js';
export const standardMaterial = (options: Material3D = {}) => material3dSchema.parse(options);
export const unlitMaterial = (color: string) => material3dSchema.parse({ model: 'unlit', color });
