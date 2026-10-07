import { VmotionError } from './model.js';
export type ExpressionAST =
  | { type: 'literal'; value: number | string | boolean }
  | { type: 'symbol'; name: string }
  | { type: 'get'; object: ExpressionAST; key: string }
  | { type: 'call'; name: string; args: ExpressionAST[] }
  | { type: 'binary'; op: string; a: ExpressionAST; b: ExpressionAST }
  | { type: 'unary'; op: string; value: ExpressionAST }
  | { type: 'conditional'; test: ExpressionAST; yes: ExpressionAST; no: ExpressionAST };
type Token = {
  kind: 'number' | 'string' | 'name' | 'operator' | 'end';
  text: string;
  value?: number | string;
  offset: number;
};
const operators = [
    '===',
    '!==',
    '**',
    '<=',
    '>=',
    '&&',
    '||',
    '+',
    '-',
    '*',
    '/',
    '%',
    '<',
    '>',
    '!',
    '?',
    ':',
    '(',
    ')',
    '[',
    ']',
    '.',
    ',',
  ],
  priority: Record<string, number> = {
    '||': 1,
    '&&': 2,
    '===': 3,
    '!==': 3,
    '<': 4,
    '>': 4,
    '<=': 4,
    '>=': 4,
    '+': 5,
    '-': 5,
    '*': 6,
    '/': 6,
    '%': 6,
    '**': 7,
  },
  forbidden = new Set(['__proto__', 'prototype', 'constructor', 'length']);
export function parseExpression(source: string, symbols: Set<string>, functions: Set<string>) {
  const tokens: Token[] = [],
    references = new Set<string>(),
    usedSymbols = new Set<string>();
  let at = 0;
  const error = (message: string, offset = at): never => {
    throw new VmotionError('EXPRESSION_SYNTAX', message, { offset, column: offset + 1 });
  };
  while (at < source.length) {
    if (/\s/.test(source[at])) {
      at++;
      continue;
    }
    if (source.startsWith('//', at)) {
      const end = source.indexOf('\n', at);
      at = end < 0 ? source.length : end;
      continue;
    }
    if (source.startsWith('/*', at)) {
      const end = source.indexOf('*/', at + 2);
      if (end < 0) error('Unterminated expression comment');
      at = end + 2;
      continue;
    }
    const start = at,
      quote = source[at];
    if (quote === '"' || quote === "'") {
      at++;
      let value = '',
        closed = false;
      while (at < source.length) {
        const char = source[at++];
        if (char === quote) {
          closed = true;
          break;
        }
        if (char === '\n' || char === '\r') error('Unescaped newline in expression string', start);
        if (char !== '\\') {
          value += char;
          continue;
        }
        const escaped = source[at++];
        if (escaped === undefined) error('Unterminated expression escape', start);
        const escapes: Record<string, string> = {
          n: '\n',
          r: '\r',
          t: '\t',
          b: '\b',
          f: '\f',
          v: '\v',
          '0': '\0',
          '\\': '\\',
          '"': '"',
          "'": "'",
        };
        if (escaped === 'u' || escaped === 'x') {
          const count = escaped === 'u' ? 4 : 2,
            hex = source.slice(at, at + count);
          if (hex.length !== count || !/^[0-9a-f]+$/i.test(hex))
            error('Invalid expression string escape', at);
          value += String.fromCharCode(parseInt(hex, 16));
          at += count;
        } else if (Object.hasOwn(escapes, escaped)) value += escapes[escaped];
        else error('Unsupported expression string escape', at - 1);
      }
      if (!closed) error('Unterminated expression string', start);
      tokens.push({ kind: 'string', text: source.slice(start, at), value, offset: start });
    } else {
      const number = source
        .slice(at)
        .match(/^(?:0[xX][0-9a-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)/);
      if (number) {
        const value = Number(number[0]);
        if (!Number.isFinite(value)) error('Number literal must be finite');
        at += number[0].length;
        tokens.push({ kind: 'number', text: number[0], value, offset: start });
      } else {
        const name = source.slice(at).match(/^[A-Za-z_$][\w$]*/);
        if (name) {
          at += name[0].length;
          tokens.push({ kind: 'name', text: name[0], offset: start });
        } else {
          const operator = operators.find((operator) => source.startsWith(operator, at));
          if (!operator) error('Unsupported expression token');
          at += operator!.length;
          tokens.push({ kind: 'operator', text: operator!, offset: start });
        }
      }
    }
    if (tokens.length > 2000)
      throw new VmotionError('EXPRESSION_BUDGET', 'Expression exceeds 2000 tokens');
  }
  tokens.push({ kind: 'end', text: '', offset: source.length });
  let index = 0,
    remaining = 2000;
  const peek = () => tokens[index],
    take = () => tokens[index++],
    expect = (text: string) => {
      const token = take();
      if (token.text !== text) error(`Expected ${text}`, token.offset);
    },
    consume = (text: string) => {
      if (peek().text !== text) return false;
      index++;
      return true;
    },
    tick = (depth: number) => {
      if (--remaining < 0 || depth > 64)
        throw new VmotionError('EXPRESSION_BUDGET', 'Expression exceeds syntax size/depth limits');
    };
  const parse = (minimum = 0, depth = 0): ExpressionAST => {
    tick(depth);
    let a = unary(depth + 1);
    while (Object.hasOwn(priority, peek().text) && priority[peek().text] >= minimum) {
      const op = take().text,
        b = parse(priority[op] + (op === '**' ? 0 : 1), depth + 1);
      a = { type: 'binary', op, a, b };
    }
    if (minimum === 0 && consume('?')) {
      const yes = parse(0, depth + 1);
      expect(':');
      const no = parse(0, depth + 1);
      a = { type: 'conditional', test: a, yes, no };
    }
    return a;
  };
  const unary = (depth: number): ExpressionAST => {
    tick(depth);
    if (['+', '-', '!'].includes(peek().text)) {
      const op = take().text;
      return { type: 'unary', op, value: unary(depth + 1) };
    }
    let a: ExpressionAST,
      token = take();
    if (token.kind === 'number' || token.kind === 'string')
      a = { type: 'literal', value: token.value! };
    else if (token.text === '(') {
      a = parse(0, depth + 1);
      expect(')');
    } else if (token.kind === 'name') {
      if (token.text === 'true' || token.text === 'false')
        a = { type: 'literal', value: token.text === 'true' };
      else {
        if (
          !symbols.has(token.text) &&
          !(peek().text === '(' && (functions.has(token.text) || token.text === 'layer'))
        )
          throw new VmotionError('EXPRESSION_SYMBOL', 'Unknown expression symbol', {
            symbol: token.text,
            column: token.offset + 1,
          });
        if (symbols.has(token.text)) usedSymbols.add(token.text);
        a = { type: 'symbol', name: token.text };
      }
    } else error('Expected an expression value', token.offset);
    while (['.', '[', '('].includes(peek().text)) {
      tick(depth);
      if (consume('.')) {
        const key = take();
        if (key.kind !== 'name' || forbidden.has(key.text))
          throw new VmotionError(
            'EXPRESSION_PROPERTY',
            'Use a named field without prototype access',
          );
        a = { type: 'get', object: a!, key: key.text };
      } else if (consume('[')) {
        const key = take();
        if (!['string', 'number'].includes(key.kind) || forbidden.has(String(key.value)))
          throw new VmotionError('EXPRESSION_PROPERTY', 'Use a literal field/array index');
        expect(']');
        a = { type: 'get', object: a!, key: String(key.value) };
      } else {
        expect('(');
        const callable = a!,
          name =
            callable.type === 'symbol'
              ? callable.name
              : callable.type === 'get' &&
                  callable.object.type === 'symbol' &&
                  callable.object.name === 'Math'
                ? callable.key
                : undefined;
        if (!name || (!functions.has(name) && name !== 'layer'))
          throw new VmotionError('EXPRESSION_FUNCTION', 'Function is not available');
        const args: ExpressionAST[] = [];
        if (!consume(')')) {
          do {
            args.push(parse(0, depth + 1));
            if (args.length > 32)
              throw new VmotionError('EXPRESSION_BUDGET', 'Too many function arguments');
          } while (consume(','));
          expect(')');
        }
        if (name === 'layer') {
          if (args.length !== 1 || args[0].type !== 'literal' || typeof args[0].value !== 'string')
            throw new VmotionError(
              'EXPRESSION_REFERENCE',
              'layer() needs one stable literal layer ID',
            );
          references.add(args[0].value);
        }
        if (name === 'random' && (callable.type !== 'symbol' || args.length !== 1))
          throw new VmotionError(
            'EXPRESSION_FUNCTION',
            'Use random(seed); Math.random is unavailable',
          );
        a = { type: 'call', name, args };
      }
    }
    return a!;
  };
  const ast = parse();
  if (peek().kind !== 'end') error('Unexpected trailing expression tokens', peek().offset);
  return { ast, references: [...references], symbols: [...usedSymbols] };
}
