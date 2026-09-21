// The analysis contract: which bundles collide, how severe the collision is,
// and that the severity model matches the realm it describes.
//
// The severity model is not a guess about JavaScript: every class asserted here
// is measured in `node:vm`, where each `runInContext` is one classic script in
// one realm — the same relationship two `<script>` elements have in the page.

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { createContext, runInContext } from 'node:vm'
import { analyzeComposition, describeCollision, summarizeAudit } from '../lib/analyze.js'

const entry = (id, source, kind = 'entry') => ({ id, path: `/packages/${id}/${kind === 'entry' ? 'client.js' : 'client.chunk.js'}`, kind, source })

const graph = (batches, entries) => ({
  entries: entries.map(id => ({ id })),
  batches,
})

const batch = (url, entries, phase = 'application') => ({ phase, url, entries })

const collisionsOf = (audit) => Object.fromEntries(audit.collisions.map(collision => [collision.name, collision]))

test('two bundles of one combo script that share a lexical declaration are batch-fatal', () => {
  const source = graph(
    [batch('/plugins/??@scope/a/client.js,@scope/b/client.js&rev=abc', ['@scope/a', '@scope/b'])],
    ['@scope/a', '@scope/b'],
  )
  const audit = analyzeComposition(source, [
    entry('@scope/a', 'const shared = 1\n'),
    entry('@scope/b', 'const shared = 2\n'),
  ])
  assert.deepEqual(audit.collisions.map(collision => [collision.name, collision.severity, collision.scriptBundles]), [['shared', 'batch-fatal', 2]])
})

test('a lexical declaration against a function in one script is still batch-fatal', () => {
  const source = graph([batch('/plugins/??a,b&rev=abc', ['a', 'b'])], ['a', 'b'])
  const audit = analyzeComposition(source, [entry('a', 'function shared() {}\n'), entry('b', 'const shared = 1\n')])
  assert.equal(audit.collisions[0].severity, 'batch-fatal')
})

test('function and var declarations in one script only replace each other: silent', () => {
  const source = graph([batch('/plugins/??a,b&rev=abc', ['a', 'b'])], ['a', 'b'])
  const audit = analyzeComposition(source, [entry('a', 'function shared() { return 1 }\nvar other = 1\n'), entry('b', 'function shared() { return 2 }\nvar other = 2\n')])
  assert.deepEqual(audit.collisions.map(collision => [collision.name, collision.severity, collision.scriptBundles]), [
    ['other', 'silent', undefined],
    ['shared', 'silent', undefined],
  ])
})

test('colliding bundles in different combo scripts are script-fatal', () => {
  const source = graph([batch('/plugins/??@scope/a&rev=abc', ['@scope/a']), batch('/plugins/??@scope/b&rev=abc', ['@scope/b'])], ['@scope/a', '@scope/b'])
  const audit = analyzeComposition(source, [entry('@scope/a', 'class Shared {}\n'), entry('@scope/b', 'var Shared = 1\n')])
  assert.deepEqual(audit.collisions.map(collision => [collision.name, collision.severity]), [['Shared', 'script-fatal']])
})

test('a bundle that redeclares its own name is its own defect, not a composition collision', () => {
  const source = graph([batch('/plugins/??@scope/a,@scope/b&rev=abc', ['@scope/a', '@scope/b'])], ['@scope/a', '@scope/b'])
  const audit = analyzeComposition(source, [entry('@scope/a', 'var own = 1\nconst own = 2\n'), entry('@scope/b', 'const distinct = 1\n')])
  assert.deepEqual(audit.collisions, [])
  assert.equal(audit.bundles[0].declarations, 1)
})

test('a chunk is its own script, and collides with an entry across scripts', () => {
  const source = graph([batch('/plugins/??@scope/a/client.js&rev=abc', ['@scope/a'])], ['@scope/a'])
  const audit = analyzeComposition(source, [
    entry('@scope/a', 'function shared() {}\n'),
    entry('@scope/a', 'const shared = 1\n', 'chunk'),
  ])
  assert.deepEqual(audit.collisions.map(collision => [collision.name, collision.severity, collision.sites.length]), [['shared', 'script-fatal', 2]])
})

test('a name declared by three bundles reports all of them', () => {
  const source = graph([batch('/plugins/??a,b,c&rev=abc', ['a', 'b', 'c'])], ['a', 'b', 'c'])
  const audit = analyzeComposition(source, [entry('a', 'function dup() {}\n'), entry('b', 'function dup() {}\n'), entry('c', 'const dup = 1\n')])
  assert.equal(audit.collisions.length, 1)
  assert.equal(audit.collisions[0].severity, 'batch-fatal')
  assert.deepEqual(audit.collisions[0].sites.map(site => site.keyword), ['function', 'function', 'const'])
})

test('every collision site is reported with its file and script identity', () => {
  const source = graph([batch('/plugins/??a,b&rev=abc', ['a', 'b'])], ['a', 'b'])
  const audit = analyzeComposition(source, [entry('a', 'const shared = 1\n'), entry('a', 'const shared = 2\n', 'chunk'), entry('b', 'let other = 1\n')])
  const shared = collisionsOf(audit).shared
  assert.equal(shared.sites[0].script, '/plugins/??a,b&rev=abc')
  assert.equal(shared.sites[1].script, undefined)
  assert.equal(shared.sites[1].kind, 'chunk')
})

test('files with no declarations are recorded as scanned and produce no collisions', () => {
  const source = graph([batch('/plugins/??a,b&rev=abc', ['a', 'b'])], ['a', 'b'])
  const audit = analyzeComposition(source, [entry('a', 'window.__ModuleLoader__.load({})\n'), entry('b', '// nothing\n')])
  assert.deepEqual(audit.collisions, [])
  assert.deepEqual(audit.bundles.map(bundle => bundle.declarations), [0, 0])
  assert.equal(summarizeAudit(audit), '2 client bundles declare 0 top-level names between them; 0 collide across bundles (0 fatal).')
})

test('collisions are ordered most severe first, then by name', () => {
  const source = graph([batch('/plugins/??a,b,c&rev=abc', ['a', 'b', 'c'])], ['a', 'b', 'c'])
  const audit = analyzeComposition(source, [
    entry('a', 'function shared() {}\nvar alone = 1\nconst zeta = 1\n'),
    entry('b', 'function shared() {}\nfunction alone() {}\nvar alpha = 1\n'),
    entry('c', 'const zeta = 2\nvar alpha = 2\n'),
  ])
  assert.deepEqual(audit.collisions.map(collision => `${collision.severity}:${collision.name}`), [
    'batch-fatal:zeta',
    'silent:alone',
    'silent:alpha',
    'silent:shared',
  ])
})

test('the severity model matches the realm it describes', () => {
  const script = { const: 'const shared = 1', let: 'let shared = 1', class: 'class shared {}', function: 'function shared() {}', var: 'var shared = 1' }
  const observe = (first, second) => {
    const context = createContext({})
    runInContext(script[first], context)
    try {
      runInContext(script[second], context)
      return 'ok'
    } catch (error) {
      return error.constructor.name
    }
  }
  // Same script: one parse, so every lexical pairing is fatal and function/var pairs are not.
  for (const lexical of ['const', 'let', 'class']) {
    for (const other of ['const', 'let', 'class', 'function', 'var']) {
      assert.equal(observe(lexical, other), 'SyntaxError', `${lexical} then ${other}`)
      assert.equal(observe(other, lexical), 'SyntaxError', `${other} then ${lexical}`)
    }
  }
  for (const first of ['function', 'var']) {
    for (const second of ['function', 'var']) assert.equal(observe(first, second), 'ok', `${first} then ${second}`)
  }
})

test('describeCollision states the name, the bundles and the consequence', () => {
  const source = graph([batch('/plugins/??@scope/a,@scope/b&rev=abc', ['@scope/a', '@scope/b'])], ['@scope/a', '@scope/b'])
  const audit = analyzeComposition(source, [entry('@scope/a', 'const shared = 1\n'), entry('@scope/b', 'function shared() {}\n')])
  const line = describeCollision(audit.collisions[0])
  assert.match(line, /"shared" is declared at the top level of one combo script by 2 bundles: @scope\/a \(const\), @scope\/b \(function\)\./)
  assert.match(line, /SyntaxError and none of its bundles \(2 bundles\) registers/)
  assert.match(line, /Wrap each bundle body in a scope, or rename the declaration\./)
})

test('describeCollision names the arrival-order consequence of a cross-script collision', () => {
  const source = graph([batch('/plugins/??@scope/a&rev=abc', ['@scope/a']), batch('/plugins/??@scope/b&rev=abc', ['@scope/b'])], ['@scope/a', '@scope/b'])
  const audit = analyzeComposition(source, [entry('@scope/a', 'const shared = 1\n'), entry('@scope/b', 'var shared = 1\n')])
  const line = describeCollision(audit.collisions[0])
  assert.match(line, /separately loaded scripts/)
  assert.match(line, /instantiates second is a SyntaxError and never runs/)
  assert.match(line, /async/)
})

test('describeCollision reports a silent collision as a shared name, not an error', () => {
  const source = graph([batch('/plugins/??@scope/a,@scope/b&rev=abc', ['@scope/a', '@scope/b'])], ['@scope/a', '@scope/b'])
  const audit = analyzeComposition(source, [entry('@scope/a', 'function shared() { return 1 }\n'), entry('@scope/b', 'var shared = 2\n')])
  const line = describeCollision(audit.collisions[0])
  assert.match(line, /No error: `var` and `function` declarations only replace each other/)
  assert.match(line, /The bundles are sharing one global name\./)
})

test('a chunk file is named by its file, an entry bundle by its package', () => {
  const source = graph([batch('/plugins/??@scope/a/client.js&rev=abc', ['@scope/a'])], ['@scope/a'])
  const audit = analyzeComposition(source, [
    entry('@scope/a', 'const shared = 1\n'),
    entry('@scope/a', 'const shared = 2\n', 'chunk'),
  ])
  const line = describeCollision(audit.collisions[0])
  assert.match(line, /@scope\/a \(const\), @scope\/a\/client\.chunk\.js \(const\)/)
})

test('summarizeAudit counts bundles, declarations and fatality', () => {
  const source = graph([batch('/plugins/??a,b&rev=abc', ['a', 'b'])], ['a', 'b'])
  const audit = analyzeComposition(source, [entry('a', 'const one = 1\nconst shared = 1\n'), entry('b', 'function shared() {}\n')])
  assert.equal(summarizeAudit(audit), '2 client bundles declare 3 top-level names between them; 1 collide across bundles (1 fatal).')
})

test('an entry the graph places in no batch is treated as its own script', () => {
  const audit = analyzeComposition(graph([], ['a', 'b']), [entry('a', 'const shared = 1\n'), entry('b', 'const shared = 2\n')])
  assert.equal(audit.collisions[0].severity, 'script-fatal')
  assert.equal(audit.bundles[0].script, undefined)
})
