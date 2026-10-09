/**
 * Top-level declaration scanner for Web client bundles.
 *
 * A client bundle reaches the page as a same-origin **classic script**
 * (`packages/client/modules/src/client/system.ts`: "Default bundle-load hook:
 * same-origin external classic script" — one `<script async src>` element per
 * combo URL and per package-local chunk). Classic scripts do not get a scope: a
 * top-level `var` or `function` becomes a property of the global object, and a
 * top-level `let`, `const` or `class` becomes a binding of the page's **global
 * lexical environment**, which the realm owns for the rest of the page's life
 * and which every later classic script must instantiate against.
 *
 * Two bundles therefore collide when they declare the same name at their top
 * level, and what the collision does is decided by the declaration kind — see
 * {@link isLexical}. The scanner answers the only part of that question a
 * composition-time guard can answer statically: which names a bundle declares at
 * its top level.
 *
 * It is deliberately not a parser. It tokenizes JavaScript well enough to keep
 * a nesting count — and the keywords that matter here only count at nesting
 * level zero, which is precisely the level the official bundle shape moves its
 * body out of:
 *
 * ```js
 * window.__ModuleLoader__.load({
 *   id: '@scope/pkg',
 *   factory: (require) => { …bundle body…; return module.exports },
 * })
 * ```
 *
 * A bundle built by the project's own client preset is wrapped in that closure
 * factory (`packages/client/tsdown.client.ts`: `banner: window.__ModuleLoader__.load({ id, factory: (require) => {`,
 * `footer: 'return module.exports; } });'`) and so declares nothing at the top
 * level. A bundle that registers itself by calling `load()` from its own top
 * level — legal JavaScript, and what the contract's own wording asks for
 * (`ClientBundleRegistration.factory`: "Closure factory holding the whole bundle
 * body", `packages/client/modules/src/client/manifest.ts`) — declares whatever
 * it defines. Nothing validates the shape, so both reach composition.
 *
 * ## What the scanner can and cannot judge
 *
 * - It reports declarations, not writes: an undeclared assignment (`x = 1`) that
 *   silently creates a global is not visible to a static scan.
 * - Within one bundle the first declaration of a name wins; a bundle that
 *   re-declares its own name is already broken on its own, and this guard is
 *   about composition.
 * - `function` and `class` are recorded only where a statement can begin: the
 *   preceding token ends a statement, or the keyword starts a line (automatic
 *   semicolon insertion). A keyword used as an expression (`x = function f() {}`,
 *   `foo(function f() {})`) is not a declaration and is not recorded. A sloppy-mode
 *   declaration that follows a label (`l: function f() {}`) reads as an
 *   expression position and is not recorded.
 * - Only declarations at the script's own level are attributed to it. A `var` or
 *   a sloppy-mode block-level `function` nested in a block or a `for` head does
 *   reach the script's global environment, and is not recorded here; both are
 *   `function`/`var`-class declarations, so what that misses are collisions that
 *   would have been silent anyway. A lexical declaration nested in a block is
 *   block-scoped and is correctly not recorded.
 * - A `/` after `}` is read as division even where a regular expression was
 *   meant, which only mis-tokenizes source that is already ambiguous.
 *
 * @module @argszero/cordis-plugin-client-bundle-conflict-guard/scan
 */

/** One top-level declaration keyword this scanner reports. */
export type DeclarationKeyword = 'let' | 'const' | 'class' | 'function' | 'var'

/**
 * Whether a declaration keyword creates a global **lexical** binding.
 *
 * Lexical declarations conflict with *any* other declaration of the same name
 * in the same realm: `let x` in one script and `var x` in another is a
 * `SyntaxError` in whichever script instantiates second, and the same holds for
 * `const`, `class`, `function` and `var` counterparts. `function` and `var`
 * declarations alone only replace each other.
 * @param keyword - the declaration keyword.
 * @returns true for `let`, `const` and `class`.
 */
export function isLexical(keyword: DeclarationKeyword): boolean {
  return keyword === 'let' || keyword === 'const' || keyword === 'class'
}

/**
 * One lexical token; verbatim values are kept for the punctuation this scanner
 * reasons about. Exported because string, template and regular-expression
 * handling is the part a second reader must not re-derive: `registration.ts`
 * walks the same token stream to find call sites, so a `load({ id: ... })` that
 * appears inside a comment, a string or a template can never be mistaken for
 * one.
 */
export interface Token {
  readonly type: 'name' | 'punct' | 'number' | 'string' | 'template' | 'regex'
  readonly value: string
  /** True when a line terminator separates this token from the previous one. */
  readonly lineBreakBefore: boolean
}

/** Punctuators, longest first so the tokenizer always takes the maximal match. */
const PUNCTUATORS: readonly string[] = [
  '>>>=', '...', '===', '!==', '**=', '<<=', '>>=', '&&=', '||=', '??=',
  '>>>', '=>', '==', '!=', '<=', '>=', '&&', '||', '??', '?.', '++', '--',
  '+=', '-=', '*=', '/=', '%=', '&=', '|=', '^=', '**', '<<', '>>',
  '{', '}', '(', ')', '[', ']', ';', ',', '<', '>', '+', '-', '*', '/', '%',
  '&', '|', '^', '!', '~', '?', ':', '=', '.', '#',
]

/** Punctuators that may open a nested construct. */
const OPENERS = new Set(['(', '[', '{'])

/** Punctuators that close a nested construct. */
const CLOSERS = new Set([')', ']', '}'])

/** Punctuators that may extend an expression across a line break (automatic semicolon insertion). */
const EXPRESSION_CONTINUATIONS = new Set([
  '(', '[', '.', '?.', ',', '?', ':', '=>',
  '=', '==', '===', '!=', '!==', '<', '>', '<=', '>=',
  '+', '-', '*', '/', '%', '**', '&', '|', '^', '&&', '||', '??',
  '<<', '>>', '>>>', '+=', '-=', '*=', '/=', '%=', '**=', '&=', '|=', '^=', '&&=', '||=', '??=', '<<=', '>>=', '>>>=',
])

/** Keywords whose following token is an operand, which decides regular-expression versus division. */
const OPERAND_KEYWORDS = new Set([
  'return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete', 'void',
  'case', 'do', 'else', 'yield', 'await', 'throw',
])

/** Reserved words that can never be a binding name; a hit here means a misread, so it is dropped. */
const RESERVED = new Set([
  'break', 'case', 'catch', 'class', 'const', 'continue', 'debugger', 'default', 'delete', 'do', 'else', 'enum',
  'export', 'extends', 'false', 'finally', 'for', 'function', 'if', 'import', 'in', 'instanceof', 'new', 'null',
  'return', 'super', 'switch', 'this', 'throw', 'true', 'try', 'typeof', 'var', 'void', 'while', 'with',
])

/** Whether a character can start an identifier. */
function isIdentifierStart(char: string): boolean {
  return (char >= 'a' && char <= 'z') || (char >= 'A' && char <= 'Z') || char === '_' || char === '$' || char.charCodeAt(0) > 0x7f
}

/** Whether a character can continue an identifier. */
function isIdentifierPart(char: string): boolean {
  return isIdentifierStart(char) || (char >= '0' && char <= '9')
}

/** Whether a character is a decimal digit. */
function isDigit(char: string): boolean {
  return char >= '0' && char <= '9'
}

/** Whether a character terminates a line. */
function isLineTerminator(char: string): boolean {
  return char === '\n' || char === '\u2028' || char === '\u2029'
}

/** Whether a token is the given punctuator. */
function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.type === 'punct' && token.value === value
}

/** Whether a token can extend the expression before it. */
function continuesExpression(token: Token): boolean {
  if (token.type === 'punct') return EXPRESSION_CONTINUATIONS.has(token.value)
  if (token.type === 'name') return token.value === 'in' || token.value === 'of' || token.value === 'instanceof'
  return false
}

/** Skip a quoted string; stops after the closing quote or at the line break of an unterminated one. */
function skipQuoted(source: string, index: number): number {
  const quote = source[index]!
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]!
    if (char === '\\') { cursor += 2; continue }
    if (char === quote) return cursor + 1
    if (isLineTerminator(char)) return cursor
    cursor += 1
  }
  return cursor
}

/** Whether a `/` inside a template substitution starts a regular expression, judged from the source before it. */
function substitutionRegexAllowed(source: string, index: number): boolean {
  let cursor = index - 1
  while (cursor >= 0) {
    const char = source[cursor]!
    if (char === ' ' || char === '\t' || char === '\r' || char === '\n') { cursor -= 1; continue }
    return '([{,;:=!&|?+-*%~^<>'.includes(char)
  }
  return true
}

/** Skip a template literal, including substitutions with their nested strings, templates, comments and braces. */
function skipTemplate(source: string, index: number): number {
  let depth = 0
  let cursor = index + 1
  while (cursor < source.length) {
    const char = source[cursor]!
    if (char === '\\') { cursor += 2; continue }
    if (char === '`' && depth === 0) return cursor + 1
    if (char === '$' && source[cursor + 1] === '{') { depth += 1; cursor += 2; continue }
    if (depth > 0) {
      if (char === '{') { depth += 1; cursor += 1; continue }
      if (char === '}') { depth -= 1; cursor += 1; continue }
      if (char === '"' || char === "'") { cursor = skipQuoted(source, cursor); continue }
      if (char === '`') { cursor = skipTemplate(source, cursor); continue }
      if (char === '/' && source[cursor + 1] === '/') {
        cursor += 2
        while (cursor < source.length && !isLineTerminator(source[cursor]!)) cursor += 1
        continue
      }
      if (char === '/' && source[cursor + 1] === '*') {
        cursor += 2
        while (cursor < source.length && !(source[cursor] === '*' && source[cursor + 1] === '/')) cursor += 1
        cursor = Math.min(source.length, cursor + 2)
        continue
      }
      if (char === '/' && substitutionRegexAllowed(source, cursor)) { cursor = skipRegex(source, cursor); continue }
    }
    cursor += 1
  }
  return cursor
}

/**
 * Skip a regular-expression literal; returns the index after its flags, or
 * `index + 1` when the text is not a regular expression after all (the caller
 * then reads the `/` as a punctuator).
 */
function skipRegex(source: string, index: number): number {
  let cursor = index + 1
  let inClass = false
  while (cursor < source.length) {
    const char = source[cursor]!
    if (char === '\\') { cursor += 2; continue }
    if (isLineTerminator(char)) return index + 1
    if (char === '[') inClass = true
    else if (char === ']') inClass = false
    else if (char === '/' && !inClass) {
      let end = cursor + 1
      while (end < source.length && isIdentifierPart(source[end]!)) end += 1
      return end
    }
    cursor += 1
  }
  return index + 1
}

/** Whether a `/` at this position starts a regular expression rather than a division. */
function regexAllowed(tokens: readonly Token[]): boolean {
  const previous = tokens[tokens.length - 1]
  if (previous === undefined) return true
  if (previous.type === 'punct') {
    return previous.value !== ')' && previous.value !== ']' && previous.value !== '}' && previous.value !== '++' && previous.value !== '--'
  }
  if (previous.type === 'name') return OPERAND_KEYWORDS.has(previous.value)
  return false
}

/** Skip a numeric literal, including radix prefixes, exponents, separators and a BigInt suffix. */
function skipNumber(source: string, index: number): number {
  let cursor = index
  if (source[cursor] === '0' && /[xXoObB]/.test(source[cursor + 1] ?? '')) {
    cursor += 2
    while (cursor < source.length && /[0-9a-fA-F_]/.test(source[cursor]!)) cursor += 1
  } else {
    while (cursor < source.length && /[0-9_]/.test(source[cursor]!)) cursor += 1
    if (source[cursor] === '.') {
      cursor += 1
      while (cursor < source.length && /[0-9_]/.test(source[cursor]!)) cursor += 1
    }
    if (source[cursor] === 'e' || source[cursor] === 'E') {
      let exponent = cursor + 1
      if (source[exponent] === '+' || source[exponent] === '-') exponent += 1
      if (isDigit(source[exponent] ?? '')) {
        cursor = exponent
        while (cursor < source.length && /[0-9_]/.test(source[cursor]!)) cursor += 1
      }
    }
  }
  if (source[cursor] === 'n') cursor += 1
  return cursor
}

/** Tokenize JavaScript, skipping comments and keeping line breaks as token metadata. */
/**
 * Tokenize one source file, skipping comments and keeping strings, templates and
 * regular expressions as single tokens.
 * @param source - file text.
 * @returns the token stream, comments and whitespace removed.
 */
export function tokenize(source: string): Token[] {
  const tokens: Token[] = []
  const length = source.length
  let index = 0
  let lineBreak = false

  const take = (type: Token['type'], value: string): void => {
    tokens.push({ type, value, lineBreakBefore: lineBreak })
    lineBreak = false
  }

  while (index < length) {
    const char = source[index]!
    if (isLineTerminator(char)) { lineBreak = true; index += 1; continue }
    if (char === ' ' || char === '\t' || char === '\r' || char === '\f' || char === '\v' || char === '\u00a0' || char === '\ufeff') { index += 1; continue }
    if (char === '/' && source[index + 1] === '/') {
      index += 2
      while (index < length && !isLineTerminator(source[index]!)) index += 1
      continue
    }
    if (char === '/' && source[index + 1] === '*') {
      index += 2
      while (index < length && !(source[index] === '*' && source[index + 1] === '/')) {
        if (isLineTerminator(source[index]!)) lineBreak = true
        index += 1
      }
      index = Math.min(length, index + 2)
      continue
    }
    if (char === '"' || char === "'") {
      const start = index
      index = skipQuoted(source, index)
      take('string', source.slice(start, index))
      continue
    }
    if (char === '`') {
      const start = index
      index = skipTemplate(source, index)
      take('template', source.slice(start, index))
      continue
    }
    if (char === '/' && regexAllowed(tokens)) {
      const start = index
      const end = skipRegex(source, index)
      if (end > start + 1) {
        index = end
        take('regex', source.slice(start, index))
      } else {
        index += 1
        take('punct', '/')
      }
      continue
    }
    if (isIdentifierStart(char)) {
      const start = index
      while (index < length && isIdentifierPart(source[index]!)) index += 1
      take('name', source.slice(start, index))
      continue
    }
    if (isDigit(char) || (char === '.' && isDigit(source[index + 1] ?? ''))) {
      const start = index
      index = skipNumber(source, index)
      take('number', source.slice(start, index))
      continue
    }
    const punct = PUNCTUATORS.find(candidate => source.startsWith(candidate, index))
    if (punct === undefined) { index += 1; continue }
    take('punct', punct)
    index += punct.length
  }
  return tokens
}

/** Skip past the construct opened at `index`, returning the index after its matching closer. */
function skipBalanced(tokens: readonly Token[], index: number): number {
  const opener = tokens[index]?.value ?? ''
  const closer = opener === '(' ? ')' : opener === '[' ? ']' : '}'
  let depth = 0
  let cursor = index
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (isPunct(token, opener)) depth += 1
    else if (isPunct(token, closer)) {
      depth -= 1
      if (depth === 0) return cursor + 1
    }
    cursor += 1
  }
  return cursor
}

/** Skip a default value up to the next separator of its own nesting level. */
function skipToSeparator(tokens: readonly Token[], index: number, stops: readonly string[]): number {
  let depth = 0
  let cursor = index
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (token.type === 'punct') {
      if (OPENERS.has(token.value)) depth += 1
      else if (CLOSERS.has(token.value)) {
        if (depth === 0) return cursor
        depth -= 1
      } else if (depth === 0 && stops.includes(token.value)) return cursor
    }
    cursor += 1
  }
  return cursor
}

/** Skip a declaration's initializer up to its `,` or `;` (or the statement that follows under ASI). */
function skipInitializer(tokens: readonly Token[], index: number): number {
  let depth = 0
  let cursor = index
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (cursor > index && depth === 0 && token.lineBreakBefore && !continuesExpression(token)) return cursor
    if (token.type === 'punct') {
      if (OPENERS.has(token.value)) depth += 1
      else if (CLOSERS.has(token.value)) {
        if (depth === 0) return cursor
        depth -= 1
      } else if (depth === 0 && (token.value === ';' || token.value === ',')) return cursor
    }
    cursor += 1
  }
  return cursor
}

/** Parse an object binding pattern, recording each bound name. */
function parseObjectPattern(tokens: readonly Token[], index: number, keyword: DeclarationKeyword, record: (name: string, keyword: DeclarationKeyword) => void): number {
  let cursor = index + 1
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (isPunct(token, '}')) return cursor + 1
    if (isPunct(token, ',')) { cursor += 1; continue }
    if (isPunct(token, '=')) { cursor = skipToSeparator(tokens, cursor + 1, ['}', ',']); continue }
    if (isPunct(token, '...')) { cursor = parseBindingPattern(tokens, cursor + 1, keyword, record); continue }
    if (isPunct(token, '[')) {
      // A computed key: its expression binds nothing, its value position does.
      cursor = skipBalanced(tokens, cursor)
      if (isPunct(tokens[cursor], ':')) cursor = parseBindingPattern(tokens, cursor + 1, keyword, record)
      continue
    }
    if (token.type === 'name') {
      const next = tokens[cursor + 1]
      if (isPunct(next, ':')) { cursor = parseBindingPattern(tokens, cursor + 2, keyword, record); continue }
      if (isPunct(next, '=')) {
        record(token.value, keyword)
        cursor = skipToSeparator(tokens, cursor + 2, ['}', ','])
        continue
      }
      if (next === undefined || isPunct(next, ',') || isPunct(next, '}')) { record(token.value, keyword); cursor += 1; continue }
    }
    cursor += 1
  }
  return cursor
}

/** Parse an array binding pattern, recording each bound name. */
function parseArrayPattern(tokens: readonly Token[], index: number, keyword: DeclarationKeyword, record: (name: string, keyword: DeclarationKeyword) => void): number {
  let cursor = index + 1
  while (cursor < tokens.length) {
    const token = tokens[cursor]!
    if (isPunct(token, ']')) return cursor + 1
    if (isPunct(token, ',')) { cursor += 1; continue }
    if (isPunct(token, '=')) { cursor = skipToSeparator(tokens, cursor + 1, [']', ',']); continue }
    if (isPunct(token, '...')) { cursor = parseBindingPattern(tokens, cursor + 1, keyword, record); continue }
    if (token.type === 'name' || isPunct(token, '{') || isPunct(token, '[')) {
      cursor = parseBindingPattern(tokens, cursor, keyword, record)
      continue
    }
    cursor += 1
  }
  return cursor
}

/** Parse one binding pattern, recording each name it binds. */
function parseBindingPattern(tokens: readonly Token[], index: number, keyword: DeclarationKeyword, record: (name: string, keyword: DeclarationKeyword) => void): number {
  const token = tokens[index]
  if (token === undefined) return index
  if (token.type === 'name') {
    record(token.value, keyword)
    return index + 1
  }
  if (isPunct(token, '{')) return parseObjectPattern(tokens, index, keyword, record)
  if (isPunct(token, '[')) return parseArrayPattern(tokens, index, keyword, record)
  return index + 1
}

/** Parse a `var`/`let`/`const` declaration at script level, recording every name it binds. */
function parseVariableDeclaration(
  tokens: readonly Token[],
  index: number,
  keyword: 'var' | 'let' | 'const',
  record: (name: string, keyword: DeclarationKeyword) => void,
): number {
  let cursor = index + 1
  for (;;) {
    cursor = parseBindingPattern(tokens, cursor, keyword, record)
    if (isPunct(tokens[cursor], '=')) cursor = skipInitializer(tokens, cursor + 1)
    if (!isPunct(tokens[cursor], ',')) return cursor
    cursor += 1
  }
}

/**
 * Whether a `function` or `class` keyword here declares rather than expresses.
 *
 * A declaration can only begin a statement, so the keyword counts when the
 * preceding token can end a statement (`;`, a value, `)`, `]`, `}`) — or when it
 * starts a line after something an expression could end with (automatic
 * semicolon insertion). `x = function f() {}` and `foo(function f() {})` are
 * expressions and do not count.
 * @param previous - the token before the keyword.
 * @returns true when the keyword begins a statement.
 */
function statementPosition(previous: Token | undefined): boolean {
  if (previous === undefined) return true
  if (previous.type === 'punct') {
    return previous.value === ';' || previous.value === ')' || previous.value === ']' || previous.value === '}' || previous.value === '++' || previous.value === '--'
  }
  if (previous.type === 'name') return !OPERAND_KEYWORDS.has(previous.value)
  return true
}

/**
 * Collect every name a source declares at its own top level.
 *
 * The first declaration of a name wins, so a bundle that declares the same name
 * twice reports the keyword it reached first. Malformed input ends the scan
 * early rather than throwing: this runs against third-party bytes at boot, and a
 * diagnostic must not be the thing that fails the deployment.
 * @param source - JavaScript text of one classic script.
 * @returns declared name → declaration keyword, in source order.
 */
export function topLevelDeclarations(source: string): Map<string, DeclarationKeyword> {
  const tokens = tokenize(source)
  const declarations = new Map<string, DeclarationKeyword>()
  const record = (name: string, keyword: DeclarationKeyword): void => {
    if (RESERVED.has(name) || declarations.has(name)) return
    declarations.set(name, keyword)
  }

  let curly = 0
  let paren = 0
  let bracket = 0
  let index = 0
  while (index < tokens.length) {
    const token = tokens[index]!
    if (token.type === 'punct') {
      if (token.value === '{') curly += 1
      else if (token.value === '}') curly = Math.max(0, curly - 1)
      else if (token.value === '(') paren += 1
      else if (token.value === ')') paren = Math.max(0, paren - 1)
      else if (token.value === '[') bracket += 1
      else if (token.value === ']') bracket = Math.max(0, bracket - 1)
      index += 1
      continue
    }
    if (token.type === 'name' && curly === 0 && paren === 0 && bracket === 0) {
      if (token.value === 'function' || token.value === 'class') {
        if (statementPosition(tokens[index - 1])) {
          const nameIndex = isPunct(tokens[index + 1], '*') ? index + 2 : index + 1
          const name = tokens[nameIndex]
          if (name !== undefined && name.type === 'name') record(name.value, token.value)
        }
        index += 1
        continue
      }
      if (token.value === 'var' || token.value === 'let' || token.value === 'const') {
        const next = tokens[index + 1]
        // `let` is an ordinary identifier in sloppy mode: only a pattern start makes this a declaration.
        if (next !== undefined && (next.type === 'name' || isPunct(next, '{') || isPunct(next, '['))) {
          index = parseVariableDeclaration(tokens, index, token.value, record)
          continue
        }
      }
    }
    index += 1
  }
  return declarations
}
