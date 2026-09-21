/**
 * Line probe: run the *published* artifact against every dsh line this package
 * claims, and against the lines it claims to exclude.
 *
 * The peer range in package.json is a claim about the harness versions this
 * plugin works on, and a range is easy to get wrong in a way nothing catches
 * locally: the publisher's install tree already contains whatever the range was
 * written against, so a range that silently excludes a whole line (or admits one
 * whose public API moved) looks fine from inside the repository. The only honest
 * evidence is to install each line's `@deepseek-ai/dsh-client-modules` next to
 * the *published* tarball and drive the real `ClientModuleRegistry` through the
 * plugin.
 *
 * For each line this script:
 *   1. installs `@argszero/cordis-plugin-client-bundle-conflict-guard@<version>`
 *      and `@deepseek-ai/dsh-client-modules@<line>` into a fresh directory;
 *   2. asserts the installed line is the requested one (a probe that silently
 *      tested the newest version would prove nothing);
 *   3. writes three synthetic npm-shaped client packages on disk — one that wraps
 *      itself in the official closure factory, two bare ones that share a lexical
 *      declaration — and runs the real registry plus the plugin over them;
 *   4. asserts the plugin's log answers: the wrapped bundle contributes nothing,
 *      the collision is named with both packages and both declaration kinds, the
 *      summary line counts the composition, and the non-fatal case is not called
 *      fatal.
 *
 * Included lines must pass all four checks; excluded lines must fail to install
 * at all (that is what "not supported" means for a peer dependency).
 *
 * Run: node scripts/probe-lines.mjs [--with <version>]... [--without <version>]...
 */

import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const published = `${manifest.name}@${manifest.version}`

/** Lines the peer range is meant to admit, per the README and the patch header. */
const included = ['0.1.2-rc.1', '0.1.3-alpha.2', '0.1.5-rc.2', '0.1.6-alpha.2']
/** Lines that must stay out: earlier than the seam the plugin reads. */
const excluded = ['0.1.1-rc.2', '0.1.2-alpha.5']

const argv = process.argv.slice(2)
const flag = name => argv.reduce((found, value, index) => (value === name ? [...found, argv[index + 1]] : found), [])
for (const version of flag('--with')) included.push(version)
for (const version of flag('--without')) excluded.push(version)

/**
 * Driver executed *inside* the installed tree, so `@deepseek-ai/cordis`,
 * `@deepseek-ai/dsh-client-modules` and the plugin all resolve to that tree's
 * copies — the composition under test is the line's, not this repository's.
 */
const driver = String.raw`
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import { ClientModuleRegistry } from '@deepseek-ai/dsh-client-modules'
import { Config, apply } from '@argszero/cordis-plugin-client-bundle-conflict-guard'

const root = mkdtempSync(join(tmpdir(), 'cbg-line-'))
const makePackage = (id, source) => {
  const directory = join(root, 'node_modules', ...id.split('/'))
  mkdirSync(join(directory, 'lib'), { recursive: true })
  writeFileSync(join(directory, 'package.json'), JSON.stringify({
    name: id, version: '1.0.0', type: 'module',
    exports: { './client': './lib/client.js', './host': './lib/host.js' },
    dsh: { client: { platform: 'web' } },
  }))
  writeFileSync(join(directory, 'lib', 'client.js'), source)
  writeFileSync(join(directory, 'lib', 'host.js'), 'export const name = "stub"\n')
  return { id, directory }
}

const packages = [
  makePackage('@probe/wrapped', 'window.__ModuleLoader__.load({ id: "@probe/wrapped", factory: (require) => { const hidden = 1; return {} } })\n'),
  makePackage('@probe/bare-a', 'const makeWidget = 1\nwindow.__ModuleLoader__.load({ id: "@probe/bare-a", factory: () => ({}) })\n'),
  makePackage('@probe/bare-b', 'class makeWidget {}\nwindow.__ModuleLoader__.load({ id: "@probe/bare-b", factory: () => ({}) })\n'),
]

const entries = packages.map(entry => ({
  options: { name: entry.id }, fiber: {}, disabled: false,
  parent: { tree: { ctx: { baseUrl: pathToFileURL(join(root, 'index.js')).href } } },
}))
const loader = {
  entries: () => entries,
  internal: { version: 'v2', resolveSync: (_base, { specifier }) => {
    const entry = packages.find(candidate => candidate.id === specifier)
    if (entry === undefined) throw new Error('probe: cannot resolve ' + specifier)
    return { url: pathToFileURL(join(entry.directory, 'lib', 'host.js')).href }
  } },
}

const lines = []
const record = level => (...args) => lines.push(level + ': ' + args.join(' '))
const ctx = new Context()
ctx.logger = { warn: record('warn'), info: record('info'), debug: record('debug'), error: record('error') }
ctx.provide('loader', loader)
// The registry registers its own bundle route through the web server (the static
// inject list carries 'webServer' on the older lines, where the prefix route is
// unconditional). A real deployment has a web server; this harness stands in for
// one so the probe exercises the line's composition logic, not its routing.
ctx.provide('webServer', { register: () => {}, routes: new Map() })

const registry = new ClientModuleRegistry(ctx)
const graph = registry.graph()
const paths = graph.entries.map(entry => registry.clientPath(entry.id))
apply(ctx, Config({}))
ctx.emit('webserver/index-inject', [])
rmSync(root, { recursive: true, force: true })

console.log(JSON.stringify({
  entries: graph.entries.length,
  batches: graph.batches.length,
  pathsResolved: paths.filter(path => typeof path === 'string' && path.endsWith('client.js')).length,
  lines,
}))
`

/** Run a command, returning stdout (trimmed) or throwing with the captured output. */
function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: 'utf8', env: { ...process.env, npm_config_yes: 'true' } })
  if (result.status !== 0) throw new Error(`${command} ${args.join(' ')} failed:\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  return (result.stdout ?? '').trim()
}

const failures = []

/** Install one line next to the published plugin and report what it did. */
function probe(version, expect) {
  const workdir = mkdtempSync(join(tmpdir(), 'cbg-probe-line-'))
  writeFileSync(join(workdir, 'package.json'), JSON.stringify({ name: 'line-probe', private: true, type: 'module' }))
  let installed
  try {
    installed = run('npm', ['install', published, `@deepseek-ai/dsh-client-modules@${version}`, '--no-audit', '--no-fund'], workdir)
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true })
    const detail = String(error.message).split('\n').slice(0, 3).join(' ')
    if (expect === 'excluded') {
      console.log(`ok   ${version} is excluded — the install refuses it (${detail})`)
      return
    }
    failures.push(version)
    console.log(`FAIL ${version} could not be installed: ${detail}`)
    return
  }

  const resolved = JSON.parse(readFileSync(join(workdir, 'node_modules', '@deepseek-ai', 'dsh-client-modules', 'package.json'), 'utf8')).version
  const pluginVersion = JSON.parse(readFileSync(join(workdir, 'node_modules', '@argszero', 'cordis-plugin-client-bundle-conflict-guard', 'package.json'), 'utf8')).version
  writeFileSync(join(workdir, 'driver.mjs'), driver)

  let report
  try {
    report = JSON.parse(run(process.execPath, ['driver.mjs'], workdir))
  } catch (error) {
    rmSync(workdir, { recursive: true, force: true })
    if (expect === 'excluded') {
      console.log(`ok   ${version} is excluded — the plugin cannot run on it (${String(error.message).split('\n')[0]})`)
      return
    }
    failures.push(version)
    console.log(`FAIL ${version} crashed the driver: ${String(error.message).split('\n').slice(0, 4).join(' ')}`)
    return
  }
  rmSync(workdir, { recursive: true, force: true })

  const checks = []
  if (expect === 'excluded') {
    // Reaching this point means the line installed *and* ran: the range admits it.
    failures.push(version)
    console.log(`FAIL ${version} is claimed excluded but installed as ${resolved} and ran (plugin ${pluginVersion})`)
    return
  }
  checks.push(['the install resolved the requested line', resolved === version, resolved])
  checks.push(['the published plugin is the one under test', pluginVersion === manifest.version, pluginVersion])
  checks.push(['the registry composed three bundles', report.entries === 3, report.entries])
  checks.push(['every bundle resolved to real bytes', report.pathsResolved === 3, report.pathsResolved])
  checks.push(['the closure-factory bundle contributes no declaration', report.lines.some(line => line.includes('3 client bundles declare 2 top-level names')), true])
  checks.push(['the collision is named with both packages and both kinds', report.lines.some(line => line.includes('"makeWidget"') && line.includes('@probe/bare-a (const)') && line.includes('@probe/bare-b (class)')), true])
  checks.push(['the fatal consequence is stated', report.lines.some(line => line.includes('SyntaxError')), true])
  checks.push(['the non-fatal name is not reported', !report.lines.some(line => line.includes('"hidden"')), true])
  checks.push(['the summary line counts the composition', report.lines.some(line => line.includes('boot composition — 3 client bundles')), true])

  const broken = checks.filter(([, ok]) => !ok)
  if (broken.length > 0) failures.push(version)
  console.log(`${broken.length === 0 ? 'ok  ' : 'FAIL'} ${version} — ${checks.length - broken.length}/${checks.length} checks (plugin ${pluginVersion}, registry ${resolved})`)
  for (const [label, ok, actual] of broken) console.log(`       ${label} (got ${JSON.stringify(actual)})`)
}

console.log(`line probe: ${published}\n`)
for (const version of excluded) probe(version, 'excluded')
for (const version of included) probe(version, 'included')

if (failures.length > 0) {
  console.error(`\n${failures.length} line(s) failed: ${failures.join(', ')}`)
  process.exit(1)
}
console.log(`\nall ${included.length} claimed line(s) pass; ${excluded.length} excluded line(s) stay out`)
