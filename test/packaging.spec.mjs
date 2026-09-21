/**
 * Packaging guard: the published artifact must be installable by name.
 *
 * A plugin that imports a package it only declares in `devDependencies` builds,
 * tests and packs cleanly, and then fails for every consumer with
 * `ERR_MODULE_NOT_FOUND` — because the install tree of the *publisher* contains
 * that package anyway. The only assertion that catches it is a bidirectional one
 * over the bytes that ship:
 *
 *   - every bare specifier the built `lib/**\/*.js` imports must be declared as a
 *     runtime or peer dependency (devDependencies do not travel with the tarball);
 *   - every runtime dependency declared must actually be imported — a dependency
 *     that is not is a stale row that misleads the next reader.
 *
 * Both directions are asserted against the built artifact, so the test is
 * meaningful only after `npm run build` (`pretest` runs `tsc`). It fails loudly
 * rather than skipping when `lib/` is missing, because a silently-skipped
 * packaging check is the hole this file exists to close.
 */

import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const manifest = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))

/** Every file with one of the given extensions under a directory, recursively. */
function filesUnder(directory, extensions) {
  const found = []
  for (const name of readdirSync(directory)) {
    const path = join(directory, name)
    if (statSync(path).isDirectory()) found.push(...filesUnder(path, extensions))
    else if (extensions.some(extension => name.endsWith(extension))) found.push(path)
  }
  return found
}

/** Bare specifiers imported by a source text: `from 'x'`, `import 'x'`, `import('x')`. */
function specifiersOf(text) {
  const found = new Set()
  const patterns = [
    /\bfrom\s*['"]([^'"]+)['"]/g,
    /\bimport\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
    /^\s*import\s+['"]([^'"]+)['"]/gm,
    /\brequire\s*\(\s*['"]([^'"]+)['"]\s*\)/g,
  ]
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) found.add(match[1])
  }
  return found
}

/** Bare (non-relative, non-`node:`) specifiers, reduced to their package name. */
function barePackages(specifiers) {
  const found = new Set()
  for (const specifier of specifiers) {
    if (specifier.startsWith('.') || specifier.startsWith('/') || specifier.startsWith('node:')) continue
    const segments = specifier.split('/')
    found.add(specifier.startsWith('@') ? segments.slice(0, 2).join('/') : segments[0])
  }
  return found
}

const builtFiles = filesUnder(join(root, 'lib'), ['.js'])
const sourceFiles = filesUnder(join(root, 'src'), ['.ts'])

const builtPackages = barePackages(builtFiles.flatMap(path => [...specifiersOf(readFileSync(path, 'utf8'))]))
const sourcePackages = barePackages(sourceFiles.flatMap(path => [...specifiersOf(readFileSync(path, 'utf8'))]))

const runtimeDependencies = Object.keys(manifest.dependencies ?? {})
const peerDependencies = Object.keys(manifest.peerDependencies ?? {})

test('the build output is present, so this guard asserts over real bytes', () => {
  assert.ok(builtFiles.length > 0, 'lib/ has no built .js files — run `npm run build` first')
})

test('every package the built artifact imports at runtime is declared to install', () => {
  const declared = [...runtimeDependencies, ...peerDependencies]
  const missing = [...builtPackages].filter(name => !declared.includes(name))
  assert.deepEqual(missing, [], `the built artifact imports ${missing.join(', ')} but declares it only in devDependencies`)
})

test('every declared runtime dependency is actually imported', () => {
  const unused = runtimeDependencies.filter(name => !sourcePackages.has(name) && !builtPackages.has(name))
  assert.deepEqual(unused, [], `declared as a runtime dependency but never imported: ${unused.join(', ')}`)
})

test('every declared peer dependency is actually imported', () => {
  const unused = peerDependencies.filter(name => !sourcePackages.has(name) && !builtPackages.has(name))
  assert.deepEqual(unused, [], `declared as a peer dependency but never imported: ${unused.join(', ')}`)
})

test('the bundle patch the manifest points at exists and is included in the tarball', () => {
  const patch = manifest.dsh?.bundle?.patch
  assert.ok(patch, 'package.json declares no dsh.bundle.patch')
  assert.ok(statSync(join(root, patch)).isFile(), `${patch} does not exist`)
  const entry = patch.replace(/^\.\//, '')
  assert.ok(manifest.files.includes(entry), `${entry} is not listed in files[], so it would not ship`)
})
