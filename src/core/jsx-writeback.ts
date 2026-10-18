/*
 * Literal-prop write-back for .tsx components: turns stable-ID overrides (what visual edits
 * produce) into edits of the JSX source when the target attribute is a literal. Pure text
 * transform; callers submit the result through the normal preflight/apply path.
 */
import ts from 'typescript';
import type { Node, Snapshot, Operation } from './model.js';
import { VmotionError } from './model.js';
import { hash } from '../platform/project-files.js';

export type WritableValue = string | number | boolean;
export interface WriteBackResult {
  source: string;
  written: string[];
  skipped: Array<{
    prop: string;
    reason: 'computed' | 'non-literal-value' | 'spread' | 'layout';
    detail?: string;
  }>;
}
const geometry = new Set(['x', 'y', 'width', 'height']);
const layoutKey =
  /^(display|flex|flexGrow|flexShrink|flexBasis|alignSelf|justifySelf|placeSelf|gridColumn|gridRow|gridColumnStart|gridColumnEnd|gridRowStart|gridRowEnd|margin|padding|minWidth|minHeight|maxWidth|maxHeight|aspectRatio|position)/;
/** Style object literal of an element, if written inline. */
const styleProps = (element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, source: ts.SourceFile) => {
  for (const attr of element.attributes.properties)
    if (
      ts.isJsxAttribute(attr) &&
      attr.name.getText(source) === 'style' &&
      attr.initializer &&
      ts.isJsxExpression(attr.initializer) &&
      attr.initializer.expression
    )
      return ts.isObjectLiteralExpression(attr.initializer.expression)
        ? attr.initializer.expression
        : ('dynamic' as const);
  return undefined;
};
const styleKeys = (style: ReturnType<typeof styleProps>) =>
  !style || style === 'dynamic'
    ? []
    : style.properties.flatMap((p) =>
        (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) &&
        p.name &&
        (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name))
          ? [p.name.text]
          : [],
      );
/**
 * Whether flex/grid layout positions/sizes this element, judged from the source: its own style
 * has layout keys, or a lexical ancestor element in the file is a display:flex/grid container
 * (a dynamic style object counts). Elements placed by layout in another file are caught by the
 * service-level verification (planVerifiedJsxWriteBack).
 */
function layoutDriven(element: ts.JsxOpeningElement | ts.JsxSelfClosingElement, source: ts.SourceFile) {
  const own = styleProps(element, source);
  if (own === 'dynamic' || styleKeys(own).some((k) => layoutKey.test(k))) return true;
  let node: ts.Node | undefined = element.parent;
  if (ts.isJsxOpeningElement(element)) node = element.parent?.parent;
  for (; node; node = node.parent)
    if (ts.isJsxElement(node)) {
      const style = styleProps(node.openingElement, source);
      if (style === 'dynamic') return true;
      if (style)
        for (const p of style.properties)
          if (
            ts.isPropertyAssignment(p) &&
            p.name.getText(source) === 'display' &&
            !(ts.isStringLiteralLike(p.initializer) && !['flex', 'grid'].includes(p.initializer.text))
          )
            return true;
    }
  return false;
}

const literalOf = (value: WritableValue) =>
  typeof value === 'string' ? JSON.stringify(value) : `{${String(value)}}`;
const isLiteral = (init: ts.JsxAttributeValue | undefined): boolean => {
  if (!init) return true; // boolean shorthand
  if (ts.isStringLiteral(init)) return true;
  if (!ts.isJsxExpression(init) || !init.expression) return false;
  const e = init.expression;
  return (
    ts.isNumericLiteral(e) ||
    ts.isStringLiteral(e) ||
    ts.isNoSubstitutionTemplateLiteral(e) ||
    e.kind === ts.SyntaxKind.TrueKeyword ||
    e.kind === ts.SyntaxKind.FalseKeyword ||
    (ts.isPrefixUnaryExpression(e) &&
      e.operator === ts.SyntaxKind.MinusToken &&
      ts.isNumericLiteral(e.operand))
  );
};

/** Find JSX elements whose literal id (or key) attribute equals `localId`. */
function findElements(source: ts.SourceFile, localId: string) {
  const found: Array<ts.JsxOpeningElement | ts.JsxSelfClosingElement> = [];
  const visit = (node: ts.Node) => {
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
      for (const attr of node.attributes.properties)
        if (
          ts.isJsxAttribute(attr) &&
          ['id', 'key'].includes(attr.name.getText(source)) &&
          attr.initializer &&
          ts.isStringLiteral(attr.initializer) &&
          attr.initializer.text === localId
        )
          found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/**
 * Write literal props onto the element whose literal id/key is `localId`.
 * Attributes holding expressions are left alone (reported as `computed`).
 */
export function writeBackJsxProps(
  file: string,
  text: string,
  localId: string,
  patch: Record<string, unknown>,
): WriteBackResult {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const matches = findElements(source, localId);
  if (!matches.length)
    throw new VmotionError(
      'JSX_WRITEBACK_TARGET',
      `No JSX element with literal id "${localId}" in ${file}`,
      { file },
    );
  if (matches.length > 1)
    throw new VmotionError(
      'JSX_WRITEBACK_AMBIGUOUS',
      `${matches.length} JSX elements use id "${localId}" in ${file}; give them distinct ids to write back`,
      { file },
    );
  const element = matches[0],
    edits: Array<{ start: number; end: number; text: string }> = [],
    result: WriteBackResult = { source: text, written: [], skipped: [] };
  const attributes = new Map<string, ts.JsxAttribute>();
  let spread = false;
  for (const attr of element.attributes.properties)
    if (ts.isJsxAttribute(attr)) attributes.set(attr.name.getText(source), attr);
    else spread = true;
  const insertAt = element.attributes.end,
    inLayout = layoutDriven(element, source);
  for (const [prop, value] of Object.entries(patch)) {
    if (inLayout && geometry.has(prop)) {
      result.skipped.push({
        prop,
        reason: 'layout',
        detail: 'flex/grid layout computes this box; change style (width, gap, padding…) instead',
      });
      continue;
    }
    if (
      !['string', 'number', 'boolean'].includes(typeof value) ||
      (typeof value === 'number' && !Number.isFinite(value))
    ) {
      result.skipped.push({ prop, reason: 'non-literal-value' });
      continue;
    }
    const attr = attributes.get(prop);
    if (attr) {
      if (!isLiteral(attr.initializer)) {
        result.skipped.push({ prop, reason: 'computed' });
        continue;
      }
      edits.push({
        start: attr.getStart(source),
        end: attr.end,
        text: `${prop}=${literalOf(value as WritableValue)}`,
      });
    } else {
      if (spread) {
        result.skipped.push({ prop, reason: 'spread' });
        continue;
      }
      edits.push({
        start: insertAt,
        end: insertAt,
        text: ` ${prop}=${literalOf(value as WritableValue)}`,
      });
    }
    result.written.push(prop);
  }
  let out = text;
  for (const edit of edits
    .map((e, index) => ({ ...e, index }))
    .sort((a, b) => b.start - a.start || b.index - a.index))
    out = out.slice(0, edit.start) + edit.text + out.slice(edit.end);
  result.source = out;
  return result;
}

/**
 * Plan promoting a component node's overrides into its .tsx source. Returns a candidate
 * (files + operations) for project_preflight/project_apply; overrides that cannot be
 * written (computed attributes, non-literal values, ambiguous ids) stay as overrides.
 */
export interface WriteBackPlan {
  files: Array<{ type: 'replace'; path: string; expectedHash: string; content: string }>;
  operations: Operation[];
  report: Array<{
    id: string;
    written: string[];
    skipped: WriteBackResult['skipped'];
    error?: string;
    code?: string;
  }>;
}
export function planJsxWriteBack(
  snapshot: Snapshot,
  sceneId: string,
  nodeId: string,
  options: { filter?: (id: string, prop: string) => boolean } = {},
): WriteBackPlan {
  const scene = snapshot.scenes.find((s) => s.id === sceneId),
    owner = scene?.nodes.find((n) => n.id === nodeId);
  if (!owner || owner.type !== 'component' || !owner.component)
    throw new VmotionError('NOT_FOUND', 'Component layer not found', { sceneId, nodeId });
  const file = owner.component;
  if (!file.endsWith('.tsx'))
    throw new VmotionError(
      'JSX_WRITEBACK_SOURCE',
      'Only .tsx components support source write-back',
      { file },
    );
  let text = snapshot.files[file];
  if (text === undefined)
    throw new VmotionError('MISSING_COMPONENT', `Component not found: ${file}`);
  const remaining: Node['overrides'] = {},
    report: WriteBackPlan['report'] = [];
  for (const [id, override] of Object.entries(owner.overrides)) {
    const local = id.split('/').at(-1)!;
    const selected = Object.fromEntries(
      Object.entries(override as Record<string, unknown>).filter(
        ([prop]) => !options.filter || options.filter(id, prop),
      ),
    );
    if (!Object.keys(selected).length) {
      remaining[id] = override;
      continue;
    }
    try {
      const r = writeBackJsxProps(file, text, local, selected);
      text = r.source;
      report.push({ id, written: r.written, skipped: r.skipped });
      const rest = Object.fromEntries(
        Object.entries(override).filter(([k]) => !r.written.includes(k)),
      );
      if (Object.keys(rest).length) remaining[id] = rest as Node['overrides'][string];
    } catch (e) {
      remaining[id] = override;
      report.push({
        id,
        written: [],
        skipped: [],
        error: (e as Error).message,
        code: (e as { code?: string }).code,
      });
    }
  }
  const changed = text !== snapshot.files[file];
  const operations: Operation[] = changed
    ? [{ type: 'updateNode', sceneId, nodeId, patch: { overrides: remaining } } as Operation]
    : [];
  return {
    files: changed
      ? [
          {
            type: 'replace' as const,
            path: file,
            expectedHash: hash(snapshot.files[file]),
            content: text,
          },
        ]
      : [],
    operations,
    report,
  };
}
