// The registration-key contract: what each bundle file registers under, whether
// that is the key its row requires, and that this guard reads it out of the real
// bytes rather than guessing.
//
// The consequences quoted in these messages are not paraphrase. The last test
// reads them out of the *installed* `@deepseek-ai/dsh-client-modules` artifact, so
// a harness release that rewords the loader fails here instead of leaving the
// guard quoting a sentence no line emits. The registration objects the tests feed
// the reader are copied from published bundles, line breaks and tabs included —
// `@deepseek-ai/dsh-client-ui-chat` writes its `id` on its own tab-indented line.

import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import {
  analyzeRegistrations, decodeStringLiteral, describeRegistrationFinding,
  expectedKey, stripClientSuffix, summarizeRegistrations, unverifiableFiles,
} from '../lib/registration.js'

/** One bundle file as the analyzer takes it. */
function file(id, source, { kind = 'entry', path } = {}) {
  const name = path ?? (kind === 'entry' ? `/packages/${id}/lib/client.js` : `/packages/${id}/lib/client.chunk.js`)
  return { id, path: name, kind, source }
}

/** The registration a real bundle carries, in the published multiline shape. */
function registration(id, { chunk, quote = '"' } = {}) {
  const field = chunk === undefined ? '' : `\tchunk: ${quote}${chunk}${quote},\n`
  return `window.__ModuleLoader__.load({\n\tid: ${quote}${id}${quote},\n${field}\tfactory: (require) => {\n\t\treturn {}\n\t}\n})\n`
}

const auditOf = (...bundles) => analyzeRegistrations(bundles)

test('stripClientSuffix mirrors the harness rule the module table applies', () => {
  assert.equal(stripClientSuffix('@scope/pkg'), '@scope/pkg')
  assert.equal(stripClientSuffix('@scope/pkg/client'), '@scope/pkg')
  // Only the trailing subpath is stripped, and only once.
  assert.equal(stripClientSuffix('@scope/client/client'), '@scope/client')
  assert.equal(stripClientSuffix('@scope/pkg/client/deep'), '@scope/pkg/client/deep')
  assert.equal(stripClientSuffix('client'), 'client')
})

test('a string literal decodes both quote styles and the escapes a build can emit', () => {
  assert.equal(decodeStringLiteral('"@scope/pkg"'), '@scope/pkg')
  assert.equal(decodeStringLiteral("'@scope/pkg'"), '@scope/pkg')
  assert.equal(decodeStringLiteral('"a\\u002fb"'), 'a/b')
  assert.equal(decodeStringLiteral('"a\\u{2f}b"'), 'a/b')
  assert.equal(decodeStringLiteral('"a\\x2fb"'), 'a/b')
  assert.equal(decodeStringLiteral('"a\\"b"'), 'a"b')
  assert.equal(decodeStringLiteral('"a\\\\b"'), 'a\\b')
  assert.equal(decodeStringLiteral('"a\\/b"'), 'a/b')
  // Unterminated, empty and non-string literals are unreadable rather than guessed.
  assert.equal(decodeStringLiteral('"unterminated'), undefined)
  assert.equal(decodeStringLiteral('"'), undefined)
  assert.equal(decodeStringLiteral('`template`'), undefined)
  assert.equal(decodeStringLiteral('42'), undefined)
})

test('the expected key is the row id, plus the file name for a chunk', () => {
  assert.equal(expectedKey('@scope/pkg', 'entry', '/packages/@scope/pkg/lib/client.js'), '@scope/pkg')
  assert.equal(expectedKey('@scope/pkg', 'chunk', '/packages/@scope/pkg/lib/client.widget.js'), '@scope/pkg/client.widget.js')
  // A Windows path names the same chunk as a POSIX one.
  assert.equal(expectedKey('@scope/pkg', 'chunk', 'C:\\pkg\\lib\\client.widget.js'.replace(/\\/g, '/')), '@scope/pkg/client.widget.js')
})

test('a bundle that registers its own row is clean, tabs and line breaks included', () => {
  const audit = auditOf(file('@scope/pkg', registration('@scope/pkg')))
  assert.deepEqual(audit.findings, [])
  assert.deepEqual(audit.files[0].keys, ['@scope/pkg'])
  assert.equal(audit.files[0].expected, '@scope/pkg')
  assert.equal(audit.files[0].opaque, 0)
  assert.equal(audit.files[0].unparsed, false)
})

test('the `<pkg>/client` subpath a bundle may spell still satisfies its row', () => {
  const audit = auditOf(file('@scope/pkg', registration('@scope/pkg/client')))
  assert.deepEqual(audit.findings, [])
  assert.deepEqual(audit.files[0].keys, ['@scope/pkg'])
})

test('a chunk registers the chunk key its own file name derives', () => {
  const clean = auditOf(file('@scope/pkg', registration('@scope/pkg', { chunk: 'client.chunk.js' }), { kind: 'chunk' }))
  assert.deepEqual(clean.findings, [])
  assert.deepEqual(clean.files[0].keys, ['@scope/pkg/client.chunk.js'])

  const wrong = auditOf(file('@scope/pkg', registration('@scope/pkg', { chunk: 'client.other.js' }), { kind: 'chunk' }))
  assert.equal(wrong.findings.length, 1)
  assert.equal(wrong.findings[0].severity, 'unregistered')
  assert.equal(wrong.findings[0].key, '@scope/pkg/client.chunk.js')
})

test('single-quoted registrations are read the same way', () => {
  const audit = auditOf(file('@scope/pkg', registration('@scope/pkg', { quote: "'" })))
  assert.deepEqual(audit.findings, [])
  assert.deepEqual(audit.files[0].keys, ['@scope/pkg'])
})

test('only the registration object\'s own level holds the key', () => {
  const source = 'window.__ModuleLoader__.load({ options: { id: "@scope/other" }, id: "@scope/pkg", factory: () => ({}) })\n'
  const audit = auditOf(file('@scope/pkg', source))
  assert.deepEqual(audit.files[0].keys, ['@scope/pkg'])
  assert.deepEqual(audit.findings, [])
})

test('the factory closure is skipped by depth, so a nested declaration is not the key', () => {
  const source = 'window.__ModuleLoader__.load({ id: "@scope/pkg", factory: (require) => { const nested = { id: "not/the/key" }; return nested } })\n'
  const audit = auditOf(file('@scope/pkg', source))
  assert.deepEqual(audit.files[0].keys, ['@scope/pkg'])
})

test('a bundle registering another package\'s key is reported, never silently accepted', () => {
  const audit = auditOf(file('@scope/pkg', registration('@scope/renamed-away')))
  assert.equal(audit.findings.length, 1)
  assert.equal(audit.findings[0].severity, 'unregistered')
  assert.equal(audit.findings[0].key, '@scope/pkg')
  assert.equal(audit.findings[0].files[0].keys[0], '@scope/renamed-away')
})

test('a bundle that never registers is reported: the row it belongs to stays empty', () => {
  const audit = auditOf(file('@scope/pkg', 'const local = 1\n'))
  assert.equal(audit.findings.length, 1)
  assert.equal(audit.findings[0].severity, 'unregistered')
  assert.deepEqual(audit.findings[0].files[0].keys, [])
})

test('two bundles claiming one key collide, and both are named', () => {
  const audit = auditOf(
    file('@scope/a', registration('@scope/shared')),
    file('@scope/b', registration('@scope/shared')),
  )
  const duplicate = audit.findings.filter(finding => finding.severity === 'duplicate')
  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].key, '@scope/shared')
  assert.deepEqual(duplicate[0].files.map(entry => entry.id), ['@scope/a', '@scope/b'])
  // Both rows are also unfulfilled: neither registered the key its row waits for.
  assert.equal(audit.findings.filter(finding => finding.severity === 'unregistered').length, 2)
})

test('one file registering the same key twice is a collision by itself', () => {
  const source = registration('@scope/pkg') + registration('@scope/pkg')
  const audit = auditOf(file('@scope/pkg', source))
  const duplicate = audit.findings.filter(finding => finding.severity === 'duplicate')
  assert.equal(duplicate.length, 1)
  assert.equal(duplicate[0].key, '@scope/pkg')
  assert.deepEqual(duplicate[0].files.map(entry => entry.id), ['@scope/pkg'])
  // The row is filled, so the only violation is the collision itself.
  assert.equal(audit.findings.length, 1)
  const line = describeRegistrationFinding(duplicate[0])
  assert.match(line, /"@scope\/pkg" registers the key "@scope\/pkg" 2 times in one bundle/)
  assert.match(line, /duplicate factory registration for "@scope\/pkg"/)
})

test('a computed id is unverifiable, not a defect', () => {
  const audit = auditOf(file('@scope/pkg', 'window.__ModuleLoader__.load({ id: packageName, factory: () => ({}) })\n'))
  assert.deepEqual(audit.findings, [])
  assert.equal(audit.files[0].opaque, 1)
  assert.equal(audit.files[0].keys.length, 0)
  assert.deepEqual(unverifiableFiles(audit).map(entry => entry.id), ['@scope/pkg'])
})

test('a mention of the loader that never tokenizes is unverifiable, not a defect', () => {
  // A bundle whose only mention lives in a comment: this guard cannot claim it
  // never registers, because the text it would have to trust is a comment.
  const audit = auditOf(file('@scope/pkg', '// window.__ModuleLoader__.load({ id: "@scope/pkg" })\nconst local = 1\n'))
  assert.deepEqual(audit.findings, [])
  assert.equal(audit.files[0].unparsed, true)
  assert.deepEqual(unverifiableFiles(audit).map(entry => entry.id), ['@scope/pkg'])
})

test('a load call spelled inside a string is not a registration', () => {
  const source = 'const hint = "window.__ModuleLoader__.load({ id: \\"@scope/pkg\\" })"\nconst local = 1\n'
  const audit = auditOf(file('@scope/pkg', source))
  assert.deepEqual(audit.files[0].keys, [])
  assert.equal(audit.files[0].unparsed, true)
})

test('an unterminated id literal is unverifiable rather than half-read', () => {
  const audit = auditOf(file('@scope/pkg', 'window.__ModuleLoader__.load({ id: "@scope/pkg\nfactory: () => ({}) })\n'))
  assert.equal(audit.files[0].keys.length, 0)
  assert.equal(audit.files[0].opaque, 1)
  assert.deepEqual(audit.findings, [])
})

test('the report names the file, the key it declares and the key its row needs', () => {
  const audit = auditOf(file('@scope/pkg', registration('@scope/other'), { kind: 'chunk' }))
  const line = describeRegistrationFinding(audit.findings[0])
  assert.match(line, /"@scope\/pkg\/client\.chunk\.js" registers the key "@scope\/other"/)
  assert.match(line, /requires "@scope\/pkg\/client\.chunk\.js"/)
  assert.match(line, /loaded without registering "@scope\/pkg\/client\.chunk\.js" via __ModuleLoader__\.load/)
  assert.match(line, /browser half is absent, with no host-side failure/)
})

test('the missing-registration report and the duplicate report state their own consequence', () => {
  const missing = describeRegistrationFinding(auditOf(file('@scope/pkg', 'const local = 1\n')).findings[0])
  assert.match(missing, /never calls __ModuleLoader__\.load/)
  assert.match(missing, /Every client bundle must register its own row/)

  const duplicate = describeRegistrationFinding(auditOf(
    file('@scope/a', registration('@scope/shared')),
    file('@scope/b', registration('@scope/shared')),
  ).findings[0])
  assert.equal(duplicate.includes('2 client bundles register the key "@scope/shared": @scope/a, @scope/b.'), true)
  assert.match(duplicate, /duplicate factory registration for "@scope\/shared"/)
  assert.match(duplicate, /stops every later bundle of the same batch from registering/)
})

test('the summary counts files, registrations, violations and what it could not read', () => {
  assert.equal(
    summarizeRegistrations(auditOf(file('@scope/a', registration('@scope/a')))),
    '1 client bundle files declare 1 registration keys; 0 violate the contract.',
  )
  assert.equal(
    summarizeRegistrations(auditOf(
      file('@scope/a', registration('@scope/a')),
      file('@scope/b', registration('@scope/a')),
    )),
    '2 client bundle files declare 2 registration keys; 2 violate the contract.',
  )
  // A file the guard could not read is disclosed in the same line: a clean count
  // must never be mistaken for full coverage.
  assert.equal(
    summarizeRegistrations(auditOf(file('@scope/a', 'window.__ModuleLoader__.load({ id: computed, factory: () => ({}) })\n'))),
    '1 client bundle files declare 0 registration keys; 0 violate the contract; 1 could not be read and are unverified.',
  )
})

test('findings are ordered duplicates first', () => {
  const audit = auditOf(
    file('@scope/mismatch', registration('@scope/other')),
    file('@scope/a', registration('@scope/shared')),
    file('@scope/b', registration('@scope/shared')),
  )
  assert.equal(audit.findings[0].severity, 'duplicate')
  assert.equal(audit.findings[1].severity, 'unregistered')
})

test('the loader messages this guard quotes are the ones the harness ships', () => {
  const require = createRequire(import.meta.url)
  const client = join(dirname(require.resolve('@deepseek-ai/dsh-client-modules/package.json')), 'lib', 'client.js')
  const shipped = readFileSync(client, 'utf8')
  assert.ok(shipped.includes('loaded without registering "${id}" via __ModuleLoader__.load'), 'the miss the row reports')
  assert.ok(shipped.includes('client-modules: duplicate factory registration for "${registrationName}"'), 'the collision the table throws')
  assert.ok(shipped.includes('endsWith("/client")'), 'the normalization stripClientSuffix mirrors')
})
