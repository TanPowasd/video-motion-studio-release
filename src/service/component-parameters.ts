import { z } from 'zod';
import { removeEmptyAnimationLayers } from '../core/animation-layers.js';
import {
  resolveParameters,
  parameterDefault,
  type Parameter,
  type ParameterDefinitions,
  ParameterError,
} from '../core/parameters.js';
import { evaluateNode, getNumericPath } from '../core/time.js';
import {
  keyframeSchema,
  VmotionError,
  type Snapshot,
  type Node,
  type Operation,
} from '../core/model.js';
import type { Renderer } from '../core/renderer.js';
import { contextFramesSchema } from '../core/content-time.js';
export const parameterEditSchema = z
  .object({
    sceneId: z.string(),
    nodeId: z.string(),
    path: z.array(z.string()).max(32).default([]),
    contextFrames: contextFramesSchema.default([]),
    frame: z.number().int().nonnegative().default(0),
    revision: z.string().optional(),
    updates: z
      .array(z.object({ path: z.string().min(1), value: z.unknown() }))
      .max(1000)
      .default([]),
    reset: z.array(z.string()).max(1000).default([]),
    arrays: z
      .array(
        z.discriminatedUnion('type', [
          z.object({
            type: z.literal('insert'),
            path: z.string(),
            index: z.number().int().nonnegative(),
            value: z.unknown().optional(),
          }),
          z.object({
            type: z.literal('remove'),
            path: z.string(),
            index: z.number().int().nonnegative(),
          }),
          z.object({
            type: z.literal('move'),
            path: z.string(),
            from: z.number().int().nonnegative(),
            to: z.number().int().nonnegative(),
          }),
        ]),
      )
      .max(1000)
      .default([]),
    keys: z
      .array(
        keyframeSchema.extend({
          path: z.string().min(1),
          value: z.number().finite().optional(),
          easing: keyframeSchema.shape.easing.optional(),
        }),
      )
      .max(1000)
      .default([]),
  })
  .strict();
function parts(property: string) {
  const result = property.split('.');
  if (
    result.length > 17 ||
    result.some(
      (p) =>
        !/^([a-zA-Z][\w-]*|\d+)$/.test(p) || ['__proto__', 'prototype', 'constructor'].includes(p),
    )
  )
    throw new VmotionError('PARAMETER_PATH', 'Invalid parameter path', { path: property });
  return result;
}
export function parameterSpec(specs: ParameterDefinitions, property: string): Parameter {
  const path = parts(property);
  let spec: Parameter | undefined = specs[path[0]];
  for (const part of path.slice(1)) {
    if (spec?.type === 'object') spec = spec.properties[part];
    else if (spec?.type === 'array' && /^\d+$/.test(part)) spec = spec.items;
    else if (
      (spec?.type === 'vec2' || spec?.type === 'vec3') &&
      ['x', 'y', ...(spec.type === 'vec3' ? ['z'] : [])].includes(part)
    )
      spec = { type: 'number', min: spec.min, max: spec.max, step: spec.step };
    else spec = undefined;
  }
  if (!spec)
    throw new VmotionError('PARAMETER_PATH', 'Unknown component parameter', { path: property });
  return spec;
}
function setValue(root: Record<string, unknown>, property: string, value: unknown) {
  const path = parts(property);
  let current: any = root;
  for (const part of path.slice(0, -1)) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, part))
      throw new VmotionError('PARAMETER_PATH', 'Parameter path does not exist', { path: property });
    current = current[part];
  }
  const key = path.at(-1)!;
  if (Array.isArray(current) && (!/^\d+$/.test(key) || Number(key) >= current.length))
    throw new VmotionError('PARAMETER_PATH', 'Array index is outside the parameter value', {
      path: property,
    });
  current[key] = structuredClone(value);
}
export function parameterChannels(
  specs: ParameterDefinitions,
  values: Record<string, unknown>,
  options: { offset?: number; limit?: number; paths?: string[] } = {},
) {
  const offset = options.offset ?? 0,
    limit = options.limit ?? 1000;
  let total = 0;
  const channels: Array<{ path: string; integer?: boolean; min?: number; max?: number }> = [];
  const visit = (spec: Parameter, value: unknown, path: string) => {
    if (
      options.paths &&
      !options.paths.some((p) => p === path || p.startsWith(path + '.') || path.startsWith(p + '.'))
    )
      return;
    if (spec.type === 'number') {
      if (total >= offset && channels.length < limit)
        channels.push({ path, integer: spec.integer, min: spec.min, max: spec.max });
      total++;
      return;
    }
    if (spec.type === 'object')
      for (const [key, child] of Object.entries(spec.properties))
        visit(child, (value as Record<string, unknown>)[key], `${path}.${key}`);
    if (spec.type === 'array')
      (value as unknown[]).forEach((v, i) => visit(spec.items, v, `${path}.${i}`));
    if (spec.type === 'vec2' || spec.type === 'vec3')
      for (const axis of ['x', 'y', ...(spec.type === 'vec3' ? ['z'] : [])])
        visit(
          { type: 'number', min: spec.min, max: spec.max },
          (value as Record<string, unknown>)[axis],
          `${path}.${axis}`,
        );
  };
  for (const [key, spec] of Object.entries(specs)) visit(spec, values[key], key);
  return {
    total,
    channels,
    truncated: offset > 0 || total > channels.length,
  };
}
export async function inspectComponentParameters(
  renderer: Renderer,
  snapshot: Snapshot,
  params: {
    sceneId: string;
    nodeId: string;
    path?: string[];
    frame?: number;
    contextFrames?: number[];
  },
  options: { schema?: boolean; channels?: boolean } = {},
) {
  const scope = await renderer.inspectComposition(
      snapshot,
      params.sceneId,
      params.frame ?? 0,
      params.path ?? [],
      params.contextFrames ?? [],
    ),
    node = scope.scene.nodes.find((n) => n.id === params.nodeId);
  if (
    !node ||
    !(
      (node.type === 'component' && node.component) ||
      (node.type === 'scene' && node.templateInstance)
    )
  )
    throw new VmotionError('COMPONENT_TYPE', 'Select a programmable component');
  const metadata = node.templateInstance
    ? renderer.templates.metadata(snapshot, node, { schema: options.schema })
    : await renderer.components.describe(snapshot, node.component!, { schema: options.schema });
  try {
    const values = resolveParameters(metadata.parameters, node.params),
      evaluated = resolveParameters(
        metadata.parameters,
        evaluateNode(
          renderer.themes.resolveNode(snapshot, { ...node, params: values }),
          params.frame ?? 0,
        ).params,
      );
    return {
      node,
      metadata,
      values,
      evaluated,
      revision: snapshot.revision,
      ...(options.channels === false
        ? { total: 0, channels: [], truncated: false }
        : parameterChannels(metadata.parameters, values)),
    };
  } catch (e) {
    if (e instanceof ParameterError)
      throw new VmotionError(e.code, e.message, { file: node.component, path: e.path });
    throw e;
  }
}
export async function editComponentParameters(
  renderer: Renderer,
  snapshot: Snapshot,
  raw: unknown,
) {
  const request = parameterEditSchema.parse(raw),
    inspected = await inspectComponentParameters(renderer, snapshot, request),
    node = inspected.node,
    params = structuredClone(inspected.values),
    animations = structuredClone(node.animations),
    animationLayers = structuredClone(node.animationLayers),
    updated = new Set<string>();
  for (const action of request.arrays) {
    const spec = parameterSpec(inspected.metadata.parameters, action.path);
    if (spec.type !== 'array')
      throw new VmotionError('PARAMETER_ARRAY', 'Array edit requires an array parameter', {
        path: action.path,
      });
    let value: any = params;
    for (const part of parts(action.path)) value = value?.[part];
    if (!Array.isArray(value))
      throw new VmotionError('PARAMETER_ARRAY', 'Parameter value is not an array', {
        path: action.path,
      });
    const length = value.length,
      map = new Map(Array.from({ length }, (_, i) => [i, i]));
    if (action.type === 'insert') {
      if (action.index > length)
        throw new VmotionError('PARAMETER_ARRAY', 'Insert index is out of range');
      value.splice(
        action.index,
        0,
        action.value === undefined ? parameterDefault(spec.items) : structuredClone(action.value),
      );
      for (let i = action.index; i < length; i++) map.set(i, i + 1);
    } else if (action.type === 'remove') {
      if (action.index >= length)
        throw new VmotionError('PARAMETER_ARRAY', 'Remove index is out of range');
      value.splice(action.index, 1);
      map.delete(action.index);
      for (let i = action.index + 1; i < length; i++) map.set(i, i - 1);
    } else {
      if (action.from >= length || action.to >= length)
        throw new VmotionError('PARAMETER_ARRAY', 'Move index is out of range');
      const [entry] = value.splice(action.from, 1);
      value.splice(action.to, 0, entry);
      const order = Array.from({ length }, (_, i) => i),
        [index] = order.splice(action.from, 1);
      order.splice(action.to, 0, index);
      order.forEach((old, i) => map.set(old, i));
    }
    const prefix = `params.${action.path}.`;
    for (const channels of [animations, ...(animationLayers ?? []).map((l) => l.channels)])
      for (let i = channels.length - 1; i >= 0; i--) {
        const channel = channels[i];
        if (!channel.property.startsWith(prefix)) continue;
        const tail = channel.property.slice(prefix.length),
          match = tail.match(/^(\d+)(\..*)?$/);
        if (!match) continue;
        const index = map.get(Number(match[1]));
        if (index === undefined) channels.splice(i, 1);
        else channel.property = prefix + index + (match[2] ?? '');
      }
  }
  for (const update of request.updates) {
    parameterSpec(inspected.metadata.parameters, update.path);
    setValue(params, update.path, update.value);
    updated.add(update.path);
  }
  for (const property of request.reset) {
    const spec = parameterSpec(inspected.metadata.parameters, property);
    let value: unknown = inspected.metadata.defaults;
    for (const part of parts(property))
      value =
        value && typeof value === 'object' ? (value as Record<string, unknown>)[part] : undefined;
    setValue(params, property, value === undefined ? parameterDefault(spec) : value);
    for (const channels of [animations, ...(animationLayers ?? []).map((l) => l.channels)])
      for (let i = channels.length - 1; i >= 0; i--)
        if (
          channels[i].property === `params.${property}` ||
          channels[i].property.startsWith(`params.${property}.`)
        )
          channels.splice(i, 1);
  }
  // Numeric edits on an existing channel edit the playhead key, matching the inspector's transform behavior.
  for (const property of updated) {
    const channel = animations.find((a) => a.property === `params.${property}`),
      spec = parameterSpec(inspected.metadata.parameters, property);
    if (channel && spec.type === 'number') {
      const value = getNumericPath({ params }, `params.${property}`);
      channel.keys = channel.keys.filter((k) => k.frame !== request.frame);
      channel.keys.push({
        frame: request.frame,
        value,
        easing: spec.integer ? 'hold' : 'easeInOut',
      });
      channel.keys.sort((a, b) => a.frame - b.frame);
    }
  }
  for (const key of request.keys) {
    const spec = parameterSpec(inspected.metadata.parameters, key.path);
    if (spec.type !== 'number')
      throw new VmotionError('PARAMETER_KEYFRAME', 'Keyframes require a numeric parameter leaf', {
        path: key.path,
      });
    const value =
        key.value ??
        getNumericPath(
          evaluateNode(
            removeEmptyAnimationLayers({
              ...node,
              params,
              animations,
              ...(animationLayers ? { animationLayers } : {}),
            }),
            key.frame,
          ),
          `params.${key.path}`,
        ),
      property = `params.${key.path}`,
      channel = animations.find((a) => a.property === property) ?? { property, keys: [] };
    channel.keys = channel.keys.filter((k) => k.frame !== key.frame);
    channel.keys.push({
      frame: key.frame,
      value,
      easing: key.easing ?? (spec.integer ? 'hold' : 'easeInOut'),
      ...(key.bezier ? { bezier: key.bezier } : {}),
    });
    channel.keys.sort((a, b) => a.frame - b.frame);
    if (!animations.includes(channel)) animations.push(channel);
  }
  try {
    resolveParameters(inspected.metadata.parameters, params);
    for (const frame of new Set([
      request.frame,
      ...animations.flatMap((a) => a.keys.map((k) => k.frame)),
    ]))
      resolveParameters(
        inspected.metadata.parameters,
        evaluateNode(
          removeEmptyAnimationLayers({
            ...node,
            params,
            animations,
            ...(animationLayers ? { animationLayers } : {}),
          }),
          frame,
        ).params,
      );
  } catch (e) {
    if (e instanceof ParameterError)
      throw new VmotionError(e.code, e.message, { file: node.component, path: e.path });
    throw e;
  }
  const normalized = removeEmptyAnimationLayers({
    ...node,
    params,
    animations,
    ...(animationLayers ? { animationLayers } : {}),
  });
  return {
    request,
    patch: {
      params,
      animations: normalized.animations,
      ...(animationLayers ? { animationLayers: normalized.animationLayers } : {}),
    },
    nodeId: node.id,
    values: params,
  };
}
