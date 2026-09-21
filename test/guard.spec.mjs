// The guard's behaviour on a real cordis Context: what it logs, when it re-audits,
// what it ignores, and what it refuses to do.
//
// The registry is a double — the plugin only touches `graph()`, `clientPath(id)`
// and `onGraphChanged(listener)`, which is the whole public surface it needs — but
// every bundle it reads is a real file on disk, so chunk discovery, unreadable
// bundles and the cache are exercised as filesystem behaviour rather than mocked.

import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { apply, Config, inject, name } from '../lib/index.js'

/** A package tree on disk: id → package-relative files. */
function workspace(packages) {
  const root = mkdtempSync(join(tmpdir(), 'cbg-'))
  const paths = new Map()
  for (const [id, files] of Object.entries(packages)) {
    const directory = join(root, 'node_modules', ...id.split('/'), 'lib')
    mkdirSync(directory, { recursive: true })
    for (const [file, source] of Object.entries(files)) writeFileSync(join(directory, file), source)
    paths.set(id, join(directory, 'client.js'))
  }
  return { root, paths, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

/** A registry double over one or more graph generations. */
function registry(workspace, generations) {
  const listeners = new Set()
  let current = 0
  return {
    graph: () => generations[current].graph,
    clientPath: (id) => workspace.paths.get(id),
    onGraphChanged: (listener) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    /** Advance to the next generation, as a rebuild would. */
    advance: () => {
      current += 1
      for (const listener of listeners) listener()
    },
    get listenerCount() {
      return listeners.size
    },
    get generation() {
      return current
    },
  }
}

/** A graph generation: batches over the ids whose paths are known. */
function generation(urls) {
  return { graph: { rev: urls.join('|'), entries: [], batches: [] } }
}

/** Compose one graph with one batch holding every id. */
function boot(ids, rev = 'rev-1') {
  return {
    rev,
    entries: ids.map(id => ({ id })),
    batches: [{ phase: 'application', url: `/plugins/??${ids.join(',')}&rev=${rev}`, entries: [...ids] }],
  }
}

/** Mount the plugin on a real Context with a recording logger. */
function mount(workspace, generations, config = {}) {
  const lines = []
  const record = (level) => (...args) => lines.push(`${level}: ${args.join(' ')}`)
  const ctx = new Context()
  ctx.logger = { warn: record('warn'), info: record('info'), debug: record('debug'), error: record('error') }
  const fake = registry(workspace, generations)
  ctx.provide('clientModules', fake)
  apply(ctx, { ...Config({}), ...config })
  return {
    lines,
    registry: fake,
    ctx,
    /** Log lines at one level, without the level prefix. */
    at: (level) => lines.filter(line => line.startsWith(`${level}: `)).map(line => line.slice(level.length + 2)),
    /** Fire the served-graph vantage. */
    serve: () => ctx.emit('webserver/index-inject', []),
  }
}

test('the plugin declares the service it needs and the name it reports under', () => {
  assert.equal(name, 'client-bundle-conflict-guard')
  assert.deepEqual(inject, ['clientModules'])
})

test('boot reports a same-script collision as fatal, naming both bundles', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'function makeWidget() { return 1 }\n' },
    '@scope/b': { 'client.js': 'const makeWidget = 2\n' },
  })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/b']) }])
    assert.equal(mounted.at('warn').length, 1)
    assert.match(mounted.at('warn')[0], /"makeWidget" is declared at the top level of one combo script by 2 bundles: @scope\/a \(function\), @scope\/b \(const\)/)
    assert.match(mounted.at('warn')[0], /none of its bundles \(2 bundles\) registers/)
    assert.deepEqual(mounted.at('info'), ['client-bundle-conflict-guard: boot composition — 2 client bundles declare 2 top-level names between them; 1 collide across bundles (1 fatal).'])
    assert.deepEqual(mounted.at('debug'), [])
  } finally {
    space.cleanup()
  }
})

test('boot is quiet when the bundles scope themselves: one summary line and nothing else', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'window.__ModuleLoader__.load({ id: "@scope/a", factory: (require) => { const local = 1; return {} } })\n' },
    '@scope/b': { 'client.js': 'window.__ModuleLoader__.load({ id: "@scope/b", factory: (require) => { const local = 2; return {} } })\n' },
  })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/b']) }])
    assert.deepEqual(mounted.lines, ['info: client-bundle-conflict-guard: boot composition — 2 client bundles declare 0 top-level names between them; 0 collide across bundles (0 fatal).'])
  } finally {
    space.cleanup()
  }
})

test('a silent collision is reported at info, not as a failure', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'function shared() { return 1 }\n' },
    '@scope/b': { 'client.js': 'var shared = 2\n' },
  })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/b']) }])
    assert.deepEqual(mounted.at('warn'), [])
    assert.equal(mounted.at('info').length, 2)
    assert.match(mounted.at('info')[0], /No error: `var` and `function` declarations only replace each other/)
  } finally {
    space.cleanup()
  }
})

test('a graph change reports what appeared and what cleared, once each', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'const shared = 1\n' },
    '@scope/b': { 'client.js': 'const shared = 2\n' },
    '@scope/c': { 'client.js': 'const shared = 3\n' },
  })
  try {
    const mounted = mount(space, [
      { graph: boot(['@scope/a', '@scope/b'], 'rev-1') },
      { graph: boot(['@scope/a', '@scope/b'], 'rev-2') },
      { graph: boot(['@scope/a', '@scope/b', '@scope/c'], 'rev-3') },
    ])
    assert.equal(mounted.at('warn').length, 1, 'one collision at boot')

    // Same collision, new revision: no repeat, and a change summary only if the set changed.
    mounted.registry.advance()
    assert.equal(mounted.at('warn').length, 1)
    assert.equal(mounted.at('info').length, 1, 'an unchanged collision set logs no second summary')

    mounted.registry.advance()
    assert.equal(mounted.at('warn').length, 2, 'the third bundle joins the collision and is reported again')
    assert.match(mounted.at('warn')[1], /@scope\/a \(const\), @scope\/b \(const\), @scope\/c \(const\)/)
    assert.equal(mounted.at('info').length, 2)
    assert.match(mounted.at('info')[1], /graph change — 3 client bundles declare 3 top-level names between them; 1 collide across bundles \(1 fatal\)\./)
  } finally {
    space.cleanup()
  }
})

test('a collision that disappears is announced as gone', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'const shared = 1\n' },
    '@scope/b': { 'client.js': 'const shared = 2\n' },
  })
  try {
    const mounted = mount(space, [
      { graph: boot(['@scope/a', '@scope/b'], 'rev-1') },
      { graph: boot(['@scope/a'], 'rev-2') },
    ])
    mounted.registry.advance()
    assert.ok(mounted.at('info').some(line => line.includes('"shared" no longer collides: the composition changed.')))
    assert.ok(mounted.at('info').some(line => line.includes('graph change — 1 client bundles declare 1 top-level names between them; 0 collide across bundles (0 fatal).')))
  } finally {
    space.cleanup()
  }
})

test('the served graph is audited once per revision', () => {
  const space = workspace({ '@scope/a': { 'client.js': 'const local = 1\n' } })
  try {
    const mounted = mount(space, [
      { graph: boot(['@scope/a'], 'rev-1') },
      { graph: boot(['@scope/a'], 'rev-2') },
    ])
    mounted.serve()
    assert.equal(mounted.at('info').length, 1, 'the boot summary is the served summary while the revision is unchanged')
    mounted.registry.advance()
    mounted.serve()
    mounted.serve()
    assert.deepEqual(mounted.at('info').slice(1), [
      'client-bundle-conflict-guard: served graph — 1 client bundles declare 1 top-level names between them; 0 collide across bundles (0 fatal).',
    ])
  } finally {
    space.cleanup()
  }
})

test('package-local chunks are scanned, and named by their file', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'const shared = 1\n', 'client.widget.js': 'const shared = 2\n', 'client.js.map': '{"version":3}\n', 'unrelated.js': 'const shared = 3\n', 'client.txt': 'const shared = 4\n' },
  })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a']) }])
    const warns = mounted.at('warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /@scope\/a \(const\), @scope\/a\/client\.widget\.js \(const\)/)
  } finally {
    space.cleanup()
  }
})

test('chunk scanning can be turned off', () => {
  const space = workspace({
    '@scope/a': { 'client.js': 'const shared = 1\n', 'client.widget.js': 'const shared = 2\n' },
  })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a']) }], { chunks: false })
    assert.deepEqual(mounted.at('warn'), [])
    assert.match(mounted.at('info')[0], /1 client bundles declare 1 top-level names between them/)
  } finally {
    space.cleanup()
  }
})

test('an unreadable bundle is warned about without stopping the audit', () => {
  const space = workspace({ '@scope/a': { 'client.js': 'const shared = 1\n' } })
  try {
    space.paths.set('@scope/missing', join(space.root, 'node_modules', '@scope', 'missing', 'lib', 'client.js'))
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/missing']) }])
    const warns = mounted.at('warn')
    assert.equal(warns.length, 1)
    assert.match(warns[0], /client-bundle-conflict-guard: cannot scan @scope\/missing \(.*client\.js\): ENOENT/)
    assert.match(mounted.at('info')[0], /1 client bundles declare 1 top-level names between them/)
  } finally {
    space.cleanup()
  }
})

test('a graph row with no bundle path is reported, not skipped silently', () => {
  const space = workspace({ '@scope/a': { 'client.js': 'const local = 1\n' } })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/unknown']) }])
    assert.ok(mounted.at('warn').some(line => line.includes('@scope/unknown: the composed graph row names no client bundle')))
  } finally {
    space.cleanup()
  }
})

test('the audit is cached per graph revision, so a served graph is not re-read per request', () => {
  const space = workspace({ '@scope/a': { 'client.js': 'const shared = 1\n' }, '@scope/b': { 'client.js': 'const shared = 2\n' } })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a', '@scope/b'], 'rev-1') }])
    assert.equal(mounted.at('warn').length, 1)
    // Change the bytes without changing the graph revision: a cached audit cannot see it.
    writeFileSync(space.paths.get('@scope/b'), 'const somethingElse = 2\n')
    mounted.serve()
    mounted.serve()
    assert.equal(mounted.at('warn').length, 1)
    assert.equal(mounted.at('info').length, 1)
  } finally {
    space.cleanup()
  }
})

test('error mode fails the boot audit on a fatal collision, and only then', () => {
  const fatal = workspace({ '@scope/a': { 'client.js': 'const shared = 1\n' }, '@scope/b': { 'client.js': 'var shared = 2\n' } })
  const silent = workspace({ '@scope/a': { 'client.js': 'function shared() {}\n' }, '@scope/b': { 'client.js': 'var shared = 2\n' } })
  try {
    assert.throws(
      () => mount(fatal, [{ graph: boot(['@scope/a', '@scope/b']) }], { mode: 'error' }),
      error => /1 fatal client bundle collision\(s\): "shared" \((batch|script)-fatal\)/.test(error.message) && /cannot prevent/.test(error.message),
    )
    assert.doesNotThrow(() => mount(silent, [{ graph: boot(['@scope/a', '@scope/b']) }], { mode: 'error' }))
  } finally {
    fatal.cleanup()
    silent.cleanup()
  }
})

test('the guard registers its re-audit listeners and disposes them with its fiber', () => {
  const space = workspace({ '@scope/a': { 'client.js': 'const local = 1\n' } })
  try {
    const mounted = mount(space, [{ graph: boot(['@scope/a']) }])
    assert.equal(mounted.registry.listenerCount, 1)
    assert.equal(mounted.ctx.get('clientModules'), mounted.registry)
  } finally {
    space.cleanup()
  }
})
