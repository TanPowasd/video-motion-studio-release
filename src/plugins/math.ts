import type { ToolDefinition } from '../mcp/catalog.js';
import { linearAlgebra, linearAlgebraSchema } from '../service/linear-algebra.js';
import { matrix3d, matrix3dSchema } from '../service/matrix3d.js';
import { defineRpcHandler, invokeRpcHandler } from './rpc-handler.js';
import type { BuiltinPluginHost } from './types.js';

export const mathPlugin = {
  id: 'vmotion.math',
  name: '数学与矩阵几何',
  version: '1.0.0',
  methods: new Set(['linearAlgebra', 'matrix3d']),
  tools(): ToolDefinition[] {
    return [
      {
        name: 'linear_algebra',
        description:
          'Deterministic numerical operations for math animation: multiply/transpose/inverse/determinant, scaled-pivot LU solve with residual, pivoted QR least squares, batch affine/homogeneous point transforms, and conjugate-gradient quadratic optimization with optional iteration trace. Row-major matrices, column vectors; bounded to 128 dimensions. Singular/rank-deficient inputs return diagnostics. SDK has reusable LU and prepared point transforms.',
        method: 'linearAlgebra',
        schema: { request: linearAlgebraSchema },
        plugin: { id: 'vmotion.math', version: '1.0.0', origin: 'builtin' as const },
        categories: ['math'],
        keywords: '数学 线性代数 矩阵 求解 优化 最小二乘',

        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
      {
        name: 'matrix3d',
        description:
          'Evaluate 4x4 model/view/projection matrices, perspective/orthographic cameras, batch vertices or hierarchical shaded mesh faces. Returns matrices, clip visibility, depth, geometry bounds and paginated stable face IDs for agent inspection. SDK scene3D/mesh3D convert the same clipped, globally depth-sorted geometry into native path layers. Convex planar faces, flat directional lighting; no z-buffer/textures/PBR.',
        method: 'matrix3d',
        schema: { request: matrix3dSchema },
        plugin: { id: 'vmotion.math', version: '1.0.0', origin: 'builtin' as const },
        categories: ['math', '3d'],

        keywords: '三维 矩阵 顶点 相机 透视 正交 投影 网格',
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          idempotentHint: true,
          openWorldHint: false,
        },
      },
    ];
  },
  dispatch(host: BuiltinPluginHost, method: string, params: unknown) {
    return invokeRpcHandler(mathRpcHandlers, host, method, params);
  },
};

export const mathRpcHandlers = {
  linearAlgebra: defineRpcHandler(linearAlgebraSchema, async (host, params) => {
    const method = 'linearAlgebra';

    return linearAlgebra(params);
  }),
  matrix3d: defineRpcHandler(matrix3dSchema, async (host, params) => {
    const method = 'matrix3d';

    return matrix3d(params);
  }),
};
