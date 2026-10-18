/* Static preflight checks for .tsx components: catch DOM/React/browser habits before render. */
import ts from 'typescript';
import type { Diagnostic } from './model.js';
import { htmlAlternatives, intrinsicPropProblem, intrinsicTags } from '../sdk/jsx.js';
import { styleKeyProblem } from '../sdk/jsx-style.js';
import { containerKeys } from '../sdk/jsx-layout.js';

const intrinsic = new Set<string>(intrinsicTags);
const reactHooks = new Set([
  'useState',
  'useEffect',
  'useLayoutEffect',
  'useRef',
  'useMemo',
  'useCallback',
  'useReducer',
  'useContext',
  'useTransition',
  'useDeferredValue',
  'useSyncExternalStore',
  'useId',
]);
const browserGlobals: Record<string, string> = {
  window: 'There is no browser window; read size from useClock().width/height.',
  document: 'There is no DOM; build nodes with JSX elements.',
  fetch:
    'Network access is not available while rendering; put data in project files or parameters.',
  XMLHttpRequest: 'Network access is not available while rendering.',
  localStorage: 'There is no persistent browser storage; use component parameters.',
  sessionStorage: 'There is no persistent browser storage; use component parameters.',
  navigator: 'There is no browser navigator.',
  requestAnimationFrame: 'Frames are rendered on demand; derive motion from useClock().frame.',
  setTimeout: 'Timers do not exist in frame rendering; derive timing from useClock().frame.',
  setInterval: 'Timers do not exist in frame rendering; derive timing from useClock().frame.',
};
const blockedModules: Record<string, string> = {
  react: "Vmotion JSX is not React: import elements and helpers from '@vmotion/sdk'.",
  'react-dom': 'There is no DOM renderer; components return Vmotion nodes.',
  'react/jsx-runtime': "The JSX runtime is '@vmotion/sdk' (set automatically for .tsx components).",
  remotion:
    "Use the Vmotion equivalents from '@vmotion/sdk' (see docs/JSX-COMPONENTS.md mapping table).",
  '@remotion/player': 'Preview runs in the Vmotion studio; no player component is needed.',
};

export function lintJsxSource(file: string, text: string): Diagnostic[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const out: Diagnostic[] = [];
  let autoIds = 0;
  // Names the file declares itself shadow the browser globals (no full scope analysis needed).
  const declared = new Set<string>();
  const collect = (node: ts.Node) => {
    if (
      (ts.isVariableDeclaration(node) ||
        ts.isParameter(node) ||
        ts.isBindingElement(node) ||
        ts.isFunctionDeclaration(node) ||
        ts.isImportSpecifier(node) ||
        ts.isClassDeclaration(node)) &&
      node.name &&
      ts.isIdentifier(node.name)
    )
      declared.add(node.name.text);
    ts.forEachChild(node, collect);
  };
  collect(source);
  const report = (node: ts.Node, severity: 'error' | 'warning', code: string, message: string) => {
    const at = source.getLineAndCharacterOfPosition(node.getStart(source));
    out.push({ severity, code, message, file, line: at.line + 1, column: at.character + 1 });
  };
  const visit = (node: ts.Node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const name = node.moduleSpecifier.text,
        hint =
          blockedModules[name] ??
          (name.startsWith('@remotion/') ? blockedModules.remotion : undefined);
      if (hint)
        report(
          node,
          'error',
          'JSX_REACT_IMPORT',
          `Import from "${name}" is not available in Vmotion components. ${hint}`,
        );
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      reactHooks.has(node.expression.text)
    )
      report(
        node,
        'error',
        'JSX_REACT_HOOK',
        `${node.expression.text}() is a React hook; Vmotion components are stateless per frame. Derive values from useClock() (frame/seconds) and parameters; precompute data at module scope.`,
      );
    if (
      (ts.isFunctionDeclaration(node) ||
        ts.isArrowFunction(node) ||
        ts.isFunctionExpression(node) ||
        ts.isMethodDeclaration(node)) &&
      node.modifiers?.some((m) => m.kind === ts.SyntaxKind.AsyncKeyword)
    )
      report(
        node,
        'error',
        'JSX_ASYNC',
        'Async functions cannot render frames; components must return synchronously.',
      );
    if (ts.isAwaitExpression(node))
      report(
        node,
        'error',
        'JSX_ASYNC',
        'await is not available while rendering; frames are synchronous and deterministic.',
      );
    if (
      ts.isIdentifier(node) &&
      browserGlobals[node.text] &&
      !declared.has(node.text) &&
      isGlobalReference(node)
    )
      report(node, 'error', 'JSX_BROWSER_API', `${node.text}: ${browserGlobals[node.text]}`);
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const call = `${node.expression.text}.${node.name.text}`;
      if (call === 'Math.random')
        report(
          node,
          'error',
          'JSX_NONDETERMINISTIC',
          'Math.random() changes every render; use random(seed) from @vmotion/sdk with useClock().seed.',
        );
      if (call === 'Date.now' || call === 'performance.now')
        report(
          node,
          'error',
          'JSX_NONDETERMINISTIC',
          `${call}() reads wall-clock time; use useClock().frame / seconds.`,
        );
    }
    if (
      ts.isNewExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'Date' &&
      !node.arguments?.length
    )
      report(
        node,
        'error',
        'JSX_NONDETERMINISTIC',
        'new Date() reads wall-clock time; use useClock().seconds.',
      );
    if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) checkElement(node);
    ts.forEachChild(node, visit);
  };
  const isGlobalReference = (id: ts.Identifier) => {
    const parent = id.parent;
    if (ts.isPropertyAccessExpression(parent) && parent.name === id) return false;
    if (
      (ts.isPropertyAssignment(parent) ||
        ts.isPropertySignature(parent) ||
        ts.isMethodDeclaration(parent)) &&
      parent.name === id
    )
      return false;
    if (ts.isVariableDeclaration(parent) || ts.isParameter(parent) || ts.isBindingElement(parent))
      return false;
    if (ts.isJsxAttribute(parent)) return false;
    if (ts.isImportSpecifier(parent) || ts.isShorthandPropertyAssignment(parent)) return false;
    return true;
  };
  const checkElement = (node: ts.JsxOpeningElement | ts.JsxSelfClosingElement) => {
    const tagNode = node.tagName;
    if (!ts.isIdentifier(tagNode)) return;
    const tag = tagNode.text;
    if (!/^[a-z]/.test(tag)) return;
    if (!intrinsic.has(tag)) {
      const alt = htmlAlternatives[tag];
      if (tag === 'audio')
        report(node, 'error', 'JSX_AUDIO', `<audio> cannot be emitted from a frame: use ${alt}.`);
      else
        report(
          node,
          'error',
          alt ? 'JSX_HTML_ELEMENT' : 'JSX_UNKNOWN_ELEMENT',
          alt
            ? `<${tag}> is an HTML/SVG element; Vmotion JSX is not DOM. Use ${alt}.`
            : `<${tag}> is not a Vmotion element. Use one of: ${intrinsicTags.join(', ')}, or a capitalized function component.`,
        );
      return;
    }
    let hasId = false;
    for (const attribute of node.attributes.properties) {
      if (!ts.isJsxAttribute(attribute)) {
        hasId = true; // spread props may carry id/key
        continue;
      }
      const name = attribute.name.getText(source);
      if (name === 'id' || name === 'key') hasId = true;
      if (tag === 'node' && name === 'type') continue;
      const problem = intrinsicPropProblem(tag, name);
      if (problem) report(attribute, 'error', problem[0], problem[1]);
      if (name === 'style' && attribute.initializer && ts.isJsxExpression(attribute.initializer)) {
        const value = attribute.initializer.expression;
        if (value && ts.isObjectLiteralExpression(value))
          for (const property of value.properties) {
            if (!ts.isPropertyAssignment(property) && !ts.isShorthandPropertyAssignment(property))
              continue;
            const key =
              property.name && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name))
                ? property.name.text
                : undefined;
            if (!key) continue;
            const problemText = styleKeyProblem(key);
            if (problemText) report(property, 'error', 'JSX_STYLE_UNSUPPORTED', problemText);
            else if (tag !== 'group') {
              const initializer = ts.isPropertyAssignment(property) ? property.initializer : undefined,
                literal =
                  initializer && ts.isStringLiteralLike(initializer) ? initializer.text : undefined;
              if (containerKeys.has(key) || (key === 'display' && (literal === 'flex' || literal === 'grid')))
                report(
                  property,
                  'error',
                  'JSX_LAYOUT_CONTEXT',
                  `style.${key}${literal ? `: "${literal}"` : ''} on <${tag}>: flex/grid containers must be <group> (or <Stage>); wrap the children in <group style={{ display: 'flex' }}>`,
                );
            }
          }
      }
    }
    if (!hasId && autoIds++ < 8)
      report(
        node,
        'warning',
        'JSX_AUTO_ID',
        `<${tag}> has no id or key; it gets an automatic id from its position (e.g. ${tag}-0) that shifts when siblings are added. Add id="..." so visual edits, change highlights and undo stay attached.`,
      );
  };
  visit(source);
  if (autoIds > 8)
    out.push({
      severity: 'warning',
      code: 'JSX_AUTO_ID',
      message: `${autoIds - 8} more elements without id/key in this file`,
      file,
    });
  return out;
}
