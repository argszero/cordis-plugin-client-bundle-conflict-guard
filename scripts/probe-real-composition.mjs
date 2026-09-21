/**
 * End-to-end probe: the real `ClientModuleRegistry`, the real plugin.
 *
 * This is the composition the plugin actually runs against — the registry
 * resolves its own package table from loader entries, reads the bundles, orders
 * the graph, partitions it into combo batches and exposes `graph()` /
 * `clientPath(id)` — except that the *loader* is a stub, because a loader tree
 * with file-backed entries is the harness's own boot machinery and not this
 * plugin's seam. Everything the plugin touches (`clientModules.graph()`,
 * `clientModules.clientPath(id)`, `onGraphChanged`, `webserver/index-inject`) is
 * the registry's real implementation over real bytes on disk.
 *
 * Run: node scripts/probe-real-composition.mjs
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { Config, apply } from '../lib/index.js'

const root = mkdtempSync(join(tmpdir(), 'cbg-probe-'))
const failures = []

/** One synthetic package: a manifest with `dsh.client`, and its client bundle. */
function package_(id, source) {
  const directory = join(root, 'node_modules', ...id.split('/'))
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: id,
    version: '1.0.0',
    type: 'module',
    exports: { './client': './lib/client.js', './host': './lib/host.js' },
    dsh: { client: { platform: 'web' } },
  }, null, 2))
  writeFileSync(join(directory, 'lib', 'client.js'), source)
  writeFileSync(join(directory, 'lib', 'host.js'), 'export const name = "stub"\n')
  return { id, directory }
}

const packages = [
  // A bundle that scopes itself the way the project's preset does: contributes nothing.
  package_('@probe/wrapped', 'window.__ModuleLoader__.load({ id: "@probe/wrapped", factory: (require) => { const hidden = 1; return {} } })\n'),
  // Two bundles that register from their own top level and share a lexical name.
  package_('@probe/bare-a', 'const makeWidget = 1\nwindow.__ModuleLoader__.load({ id: "@probe/bare-a", factory: () => ({}) })\n'),
  package_('@probe/bare-b', 'class makeWidget {}\nwindow.__ModuleLoader__.load({ id: "@probe/bare-b", factory: () => ({}) })\n'),
]

/** The loader surface the registry reads: entries, and specifier resolution. */
const entries = packages.map(entry => ({
  options: { name: entry.id },
  fiber: {},
  disabled: false,
  parent: { tree: { ctx: { baseUrl: pathToFileURL(join(root, 'index.js')).href } } },
}))
const loader = {
  entries: () => entries,
  internal: {
    version: 'v2',
    resolveSync: (_baseUrl, { specifier }) => {
      const entry = packages.find(candidate => candidate.id === specifier)
      if (entry === undefined) throw new Error(`probe: cannot resolve ${specifier}`)
      return { url: pathToFileURL(join(entry.directory, 'lib', 'host.js')).href }
    },
  },
}

const lines = []
const record = level => (...args) => lines.push(`${level}: ${args.join(' ')}`)
const ctx = new Context()
ctx.logger = { warn: record('warn'), info: record('info'), debug: record('debug'), error: record('error') }
ctx.provide('loader', loader)

const registry = new ClientModuleRegistry(ctx)
console.log('--- real registry graph ---')
console.log('entries      :', registry.graph().entries.map(entry => entry.id).join(', '))
console.log('batches      :', registry.graph().batches.map(batch => `${batch.phase}[${batch.entries.join(',')}]`).join(' '))
for (const entry of registry.graph().entries) console.log(`clientPath(${entry.id}) = ${registry.clientPath(entry.id)}`)

// Mount the guard on the same context: it now reads the registry's own graph.
apply(ctx, Config({}))

// Serve the page once: the registry's real boot-injection handler and the guard's
// served-graph vantage both run on the same event.
ctx.emit('webserver/index-inject', [])

console.log('--- plugin output ---')
for (const line of lines) console.log(line)

const check = (label, condition) => {
  console.log(`${condition ? 'ok  ' : 'FAIL'} ${label}`)
  if (!condition) failures.push(label)
}
check('the registry composed three bundles', registry.graph().entries.length === 3)
check('the wrapped bundle contributes no declaration', lines.some(line => line.includes('3 client bundles declare 2 top-level names')))
check('the collision is reported as fatal and names both packages', lines.some(line => line.includes('warn: ') && line.includes('"makeWidget"') && line.includes('@probe/bare-a (const)') && line.includes('@probe/bare-b (class)')))
check('the summary line states the served composition', lines.some(line => line.includes('boot composition — 3 client bundles')))
check('the non-fatal case is not reported as fatal', !lines.some(line => line.includes('"hidden"')))

rmSync(root, { recursive: true, force: true })
if (failures.length > 0) {
  console.error(`\n${String(failures.length)} probe expectation(s) failed`)
  process.exit(1)
}
console.log('\nall probe expectations hold')
