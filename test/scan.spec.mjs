// The scanner's contract, case by case. Every case here is a shape that reaches
// composition in practice: the official closure-factory bundle (which must
// declare nothing), a self-registering bare bundle (which declares everything),
// and the JavaScript constructs that a token-level scanner has to get right
// before its silence about the first is worth anything.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { isLexical, topLevelDeclarations } from '../lib/scan.js'

/** Declarations as a plain object, for readable assertions. */
const declared = (source) => Object.fromEntries(topLevelDeclarations(source))

/** The official bundle shape: `window.__ModuleLoader__.load({ id, factory: (require) => { …body… } })`. */
const wrapped = (id, body) => `window.__ModuleLoader__.load({
	id: "${id}",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
${body}
		return module.exports;
	}
});
`

test('the official closure-factory shape declares nothing at the top level', () => {
  const source = wrapped('@scope/pkg', '\t\tfunction isNullable(value) { return value === null }\n\t\tconst helper = 1\n\t\tclass Box {}')
  assert.deepEqual(declared(source), {})
})

test('the shipped first-party artifact declares nothing at the top level', () => {
  // A real published bundle from the same line this plugin targets, scanned
  // rather than a copy of it: the negative control that decides whether the
  // guard is usable at all.
  const here = dirname(fileURLToPath(import.meta.url))
  const artifact = join(here, '..', 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'lib', 'client.js')
  const source = readFileSync(artifact, 'utf8')
  assert.ok(source.includes('window.__ModuleLoader__.load('), 'the artifact is a script that registers itself')
  assert.ok(source.length > 20_000, 'the artifact is a real bundle, not a stub')
  assert.deepEqual([...topLevelDeclarations(source)], [])
})

test('a bare bundle declares what it defines', () => {
  const source = `function makeWidget() { return 1 }
const shared = require('x')
let counter = 0
class Widget {}
var legacy = true
window.__ModuleLoader__.load({ id: 'pkg', factory: makeWidget() })
`
  assert.deepEqual(declared(source), {
    makeWidget: 'function',
    shared: 'const',
    counter: 'let',
    Widget: 'class',
    legacy: 'var',
  })
})

test('an IIFE-wrapped bundle declares nothing: the shape that fixes a collision', () => {
  const source = `(function () {
  function makeWidget() { return 1 }
  const shared = 1
  window.__ModuleLoader__.load({ id: 'pkg', factory: makeWidget() })
})()
`
  assert.deepEqual(declared(source), {})
})

test('declarations nested in a function, a block or a call are not script-level', () => {
  const source = `function outer() { const inner = 1; class Inner {}; var nested = 2 }
if (cond) { let blockScoped = 1; const alsoBlock = 2; class AlsoBlock {} }
register({ function_: 1 })
for (let index = 0; index < 3; index += 1) { const inLoop = 1 }
const arrow = () => { var inArrow = 1 }
const call = function named() { return 1 }
`
  assert.deepEqual(declared(source), { outer: 'function', arrow: 'const', call: 'const' })
})

test('text inside comments, strings, templates and regular expressions declares nothing', () => {
  const source = `// const commented = 1
/* class Commented {}
   function commentedFunction() {} */
const text = "const inString = 1"
const other = 'let alsoInString = 2'
const tpl = \`class InTemplate {}\`
const nested = \`outer ${'${'} \`inner \${"const deep = 1"}\` }\`
const pattern = /const inRegex = [0-9]+/
const division = total / count
const afterCall = divide(1, 2)
`
  assert.deepEqual(declared(source), {
    text: 'const',
    other: 'const',
    tpl: 'const',
    nested: 'const',
    pattern: 'const',
    division: 'const',
    afterCall: 'const',
  })
})

test('destructuring covers names, renames, defaults, rest and computed keys', () => {
  const source = `const { plain, renamed: local, nested: { deep }, defaulted = 1, ...rest } = source
let [first, , third = 3, [deeper], ...tail] = list
var { ['computed']: computedValue, "quoted": quotedValue } = source
const { [key]: dynamicKey } = source
const { shorthand } = source
`
  assert.deepEqual(declared(source), {
    plain: 'const',
    local: 'const',
    deep: 'const',
    defaulted: 'const',
    rest: 'const',
    first: 'let',
    third: 'let',
    deeper: 'let',
    tail: 'let',
    computedValue: 'var',
    quotedValue: 'var',
    dynamicKey: 'const',
    shorthand: 'const',
  })
})

test('a declaration continues across a line break, and a statement after it is still seen', () => {
  const source = `const config = require('@scope/config')
function afterAsi() {}
const value =
	function onNextLine() {}
class AfterValue {}
`
  assert.deepEqual(declared(source), { config: 'const', afterAsi: 'function', value: 'const', AfterValue: 'class' })
})

test('keywords used as expressions are not declarations', () => {
  const source = `const assigned = function named() { return 1 }
call(function alsoNamed() { return 1 })
const cls = class Named {}
const list = [function insideArray() {}]
const object = { method: function insideObject() {} }
paired = 1, function expressionInList() {}
`
  assert.deepEqual(declared(source), { assigned: 'const', cls: 'const', list: 'const', object: 'const' })
})

test('a sloppy declaration in a statement head is attributed, one after a label is not', () => {
  // `if (cond) function f() {}` is Annex B and does reach the global environment,
  // so it is reported. After a label the keyword reads as an expression position
  // and is not: the documented limit, and a function-class collision either way.
  const source = `if (cond) function afterParen() {}
label: function afterLabel() {}
if (cond) var inBlockOfIf = 1
`
  assert.deepEqual(declared(source), { afterParen: 'function', inBlockOfIf: 'var' })
})

test('`let` used as an ordinary identifier declares nothing', () => {
  const source = `let = 5
let.foo = 1
let[0] = 2
const afterLet = 1
`
  assert.deepEqual(declared(source), { afterLet: 'const' })
})

test('malformed input ends the scan instead of throwing', () => {
  const openings = [
    'const unterminated = "abc',
    'const template = `abc ${',
    'function unclosed() {',
    'const { a, b: } = source',
    'const [ = list',
    '})(',
  ]
  for (const source of openings) {
    assert.doesNotThrow(() => topLevelDeclarations(source), `scan of ${JSON.stringify(source)} must not throw`)
  }
  assert.deepEqual(declared('const plain = 1\n'), { plain: 'const' })
})

test('the first declaration of a name in one file wins', () => {
  assert.deepEqual(declared('var same = 1\nconst same = 2\n'), { same: 'var' })
})

test('reserved words are never reported as declarations', () => {
  assert.deepEqual(declared('function if() {}\nclass return {}\n'), {})
})

test('isLexical names the fatal keyword class', () => {
  for (const keyword of ['let', 'const', 'class']) assert.equal(isLexical(keyword), true, keyword)
  for (const keyword of ['function', 'var']) assert.equal(isLexical(keyword), false, keyword)
})
