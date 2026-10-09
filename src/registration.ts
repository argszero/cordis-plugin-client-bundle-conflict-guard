/**
 * Registration-key contract: the key each client bundle file registers under, and
 * whether that key is the one its graph row requires.
 *
 * A client plugin reaches the browser as a bundle that calls
 * `window.__ModuleLoader__.load({ id, factory })` — the project's own preset emits
 * exactly that call (`packages/client/tsdown.client.ts`, `banner`/`footer`), and
 * `ClientBundleRegistration.id` documents the field as "the registration key;
 * must match the graph row being executed". The browser module system keys its
 * factories by the id it is given: `ClientModuleSystem.register()`
 * (`packages/client/modules/src/client/system.ts`) normalizes it with
 * `stripClientSuffix` and, for a package-local chunk, appends `/<chunk file>`,
 * then rejects the key if it is already taken. The loader's `arrive(row)` waits
 * for the row id — the package name — to appear in that table.
 *
 * Two mismatches therefore end the same way: silently, with the plugin's entire
 * browser half absent and nothing in the host log to attribute it to.
 *
 * - **A bundle that registers a different key** never satisfies its row.
 *   `arrive()` records `loaded without registering "<pkg>" via
 *   __ModuleLoader__.load` and falls back to the same bundle's one-resource URL,
 *   which repeats the miss. This is the reported shape of a package renamed
 *   without its bundle id (`dsh-vision-web` shipping `id: "dsh-vision"`).
 * - **Two bundles that register the same key** collide in `register()`, which
 *   throws `client-modules: duplicate factory registration for "<id>" (bundle
 *   executed twice without invalidate?)`. A batch is one classic script that
 *   registers its bundles in sequence, and the loader documents the consequence
 *   itself: "a parse error registered nothing, or a runtime throw stopped it
 *   after registering others".
 *
 * Both are invisible from the host: the composition succeeds, the graph is
 * coherent, every file is served. Only the page knows, and it knows as an
 * unattributed console line.
 *
 * This module reads the keys out of the bundle bytes, so it needs no browser and
 * no host state beyond the composed graph. What it deliberately is not, again: a
 * fix. The registration id comes from the bundle's own build, and this guard only
 * names the file whose key the composition will not accept.
 *
 * @module @argszero/cordis-plugin-client-bundle-conflict-guard/registration
 */

import type { BundleSource } from './analyze.js'
import { tokenize } from './scan.js'
import type { Token } from './scan.js'

/**
 * The harness's own id normalization — `stripClientSuffix`
 * (`packages/client/modules/src/client/manifest.ts`): a bundle that registers
 * under `<pkg>/client` (the exports subpath an external bundle may spell) still
 * satisfies its `<pkg>` row. Mirrored here as a pure function so this plugin
 * needs no runtime import from the harness; `scripts/probe-lines.mjs` is what
 * keeps the mirror honest, because it drives the *published* artifact against
 * real registry lines.
 * @param specifier - the registration id as the bundle spells it.
 * @returns the id with a trailing `/client` removed.
 */
export function stripClientSuffix(specifier: string): string {
  return specifier.endsWith('/client') ? specifier.slice(0, -'/client'.length) : specifier
}

/** One registration read out of a bundle file. */
export interface RegistrationClaim {
  /** Literal id the file passes to `load()`. */
  readonly declared: string
  /** Literal `chunk` field, when the registration carries one. */
  readonly chunk: string | undefined
  /** The module-table key this registration produces: `stripClientSuffix(declared)` plus `/<chunk>`. */
  readonly key: string
}

/** One bundle file, as the registration contract sees it. */
export interface RegistrationFile {
  /** Owning graph entry id (package name). */
  readonly id: string
  /** Absolute path of the file. */
  readonly path: string
  /** `entry` is the package's `client.js`; `chunk` is an adjacent package-local chunk. */
  readonly kind: 'entry' | 'chunk'
  /**
   * The module-table key this file must produce — the row id for an entry, the
   * row id plus the file name for a chunk. Anything else leaves the row unfilled.
   */
  readonly expected: string
  /** Keys this file registers, in source order (readable literals only). */
  readonly keys: readonly string[]
  /** `load()` calls found whose registration id could not be read as a literal. */
  readonly opaque: number
  /**
   * True when the source contains `__ModuleLoader__.load` yet no call site
   * tokenized — a computed property, an unusual spelling, or text inside a
   * comment. Reported as unverifiable rather than as a defect: this guard does
   * not claim a bundle is broken because it could not read it.
   */
  readonly unparsed: boolean
}

/** What a registration finding means for the page. */
export type RegistrationSeverity =
  /** The key the file registers is not the one its row requires: the row never materializes. */
  | 'unregistered'
  /** More than one bundle registers one key: `register()` throws for the later one. */
  | 'duplicate'

/** One registration-contract violation. */
export interface RegistrationFinding {
  /** What happens at runtime. */
  readonly severity: RegistrationSeverity
  /** The module-table key the finding is about. */
  readonly key: string
  /** Every file involved, in composition order. */
  readonly files: readonly RegistrationFile[]
}

/** The registration audit of one composition. */
export interface RegistrationAudit {
  /** Every file examined, in composition order. */
  readonly files: readonly RegistrationFile[]
  /** Violations, `duplicate` first. */
  readonly findings: readonly RegistrationFinding[]
}

/** Severity order used to sort a report. */
const SEVERITY_RANK: Readonly<Record<RegistrationSeverity, number>> = {
  duplicate: 0,
  unregistered: 1,
}

/** Last path segment, for the chunk key and for naming a file in a report. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/** Whether a token is the given punctuator. */
function isPunct(token: Token | undefined, value: string): boolean {
  return token !== undefined && token.type === 'punct' && token.value === value
}

/**
 * Decode one string-literal token.
 *
 * The tokenizer keeps literals verbatim, so the text still carries its quotes
 * and escapes. Ids are package names and arrive from `JSON.stringify`, but a
 * third-party build may use single quotes, so both forms are decoded; a literal
 * the tokenizer could not close returns undefined, and the caller records an
 * unreadable registration instead of guessing one.
 * @param literal - the token's verbatim text.
 * @returns the decoded string, or undefined when the literal is not a closed string.
 */
export function decodeStringLiteral(literal: string): string | undefined {
  const quote = literal[0]
  if (quote !== '"' && quote !== "'") return undefined
  if (literal.length < 2 || !literal.endsWith(quote)) return undefined
  const body = literal.slice(1, -1)
  if (!body.includes('\\')) return body
  return body.replace(
    /\\(?:u\{([0-9a-fA-F]+)\}|u([0-9a-fA-F]{4})|x([0-9a-fA-F]{2})|(\r\n|[\s\S]))/g,
    (_match, braced: string | undefined, uni: string | undefined, hex: string | undefined, escaped: string) => {
      if (braced !== undefined) return String.fromCodePoint(Number.parseInt(braced, 16))
      if (uni !== undefined) return String.fromCharCode(Number.parseInt(uni, 16))
      if (hex !== undefined) return String.fromCharCode(Number.parseInt(hex, 16))
      const named: Readonly<Record<string, string>> = { n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', 0: '\0' }
      if (escaped === '\n' || escaped === '\r\n' || escaped === '\u2028' || escaped === '\u2029') return ''
      return named[escaped] ?? escaped
    },
  )
}

/** Whether a `__ModuleLoader__.load(` call site starts at this token index. */
function startsLoadCall(tokens: readonly Token[], index: number): boolean {
  const head = tokens[index]
  if (head === undefined || head.type !== 'name' || head.value !== '__ModuleLoader__') return false
  if (!isPunct(tokens[index + 1], '.')) return false
  const method = tokens[index + 2]
  if (method === undefined || method.type !== 'name' || method.value !== 'load') return false
  return isPunct(tokens[index + 3], '(')
}

/**
 * Read the registration of one `load(` call site.
 *
 * Only the registration object's own level is searched, so a nested `id` inside
 * an options object is not mistaken for the key; the gigantic `factory` closure
 * is skipped by depth. A call whose `id` is not a closed string literal yields
 * undefined — the caller counts it as opaque.
 * @param tokens - the file's token stream.
 * @param open - index of the call's opening parenthesis.
 * @returns the claim, or undefined when the id is not a readable literal.
 */
function readLoadCall(tokens: readonly Token[], open: number): RegistrationClaim | undefined {
  if (!isPunct(tokens[open + 1], '{')) return undefined
  let depth = 0
  let declared: string | undefined
  let chunk: string | undefined
  for (let index = open + 1; index < tokens.length; index += 1) {
    const token = tokens[index]!
    if (token.type === 'punct') {
      if (token.value === '{' || token.value === '(' || token.value === '[') depth += 1
      else if (token.value === '}' || token.value === ')' || token.value === ']') {
        depth -= 1
        if (depth === 0) break
      }
      continue
    }
    // Depth 1 is the registration object's own level: `id`/`chunk` here belong to
    // the registration, one level deeper they belong to something it carries.
    if (depth !== 1 || token.type !== 'name') continue
    if (token.value !== 'id' && token.value !== 'chunk') continue
    if (!isPunct(tokens[index + 1], ':')) continue
    const value = tokens[index + 2]
    const text = value === undefined || value.type !== 'string' ? undefined : decodeStringLiteral(value.value)
    if (text === undefined) continue
    if (token.value === 'id') declared = text
    else chunk = text
  }
  if (declared === undefined) return undefined
  const owner = stripClientSuffix(declared)
  return { declared, chunk, key: chunk === undefined ? owner : `${owner}/${chunk}` }
}

/** Read every registration one file makes. */
function readFile(source: string): { claims: readonly RegistrationClaim[]; calls: number; opaque: number } {
  const tokens = tokenize(source)
  const claims: RegistrationClaim[] = []
  let calls = 0
  let opaque = 0
  for (let index = 0; index < tokens.length; index += 1) {
    if (!startsLoadCall(tokens, index)) continue
    calls += 1
    const claim = readLoadCall(tokens, index + 3)
    if (claim === undefined) opaque += 1
    else claims.push(claim)
  }
  return { claims, calls, opaque }
}

/**
 * The module-table key a file must produce (`ClientModuleSystem.register()`'s own
 * derivation: the owner id, plus the chunk file name for a package-local chunk).
 * @param id - owning graph entry id (the package name).
 * @param kind - entry bundle or adjacent chunk.
 * @param path - the file's path.
 * @returns the key the row waits for.
 */
export function expectedKey(id: string, kind: 'entry' | 'chunk', path: string): string {
  return kind === 'entry' ? id : `${id}/${baseName(path)}`
}

/**
 * Audit the registration contract of one composition.
 *
 * The graph is not an input: a bundle file already carries everything the check
 * needs (its owning row id, whether it is the entry or a chunk, and its own
 * bytes), and reading the requirement off the file rather than off a second
 * structure is what keeps the two from disagreeing.
 * @param bundles - the bundle files to inspect, in composition order.
 * @returns the per-file result and the violations.
 */
export function analyzeRegistrations(bundles: readonly BundleSource[]): RegistrationAudit {
  const files: RegistrationFile[] = []
  for (const bundle of bundles) {
    const { claims, calls, opaque } = readFile(bundle.source)
    files.push({
      id: bundle.id,
      path: bundle.path,
      kind: bundle.kind,
      expected: expectedKey(bundle.id, bundle.kind, bundle.path),
      keys: claims.map(claim => claim.key),
      opaque,
      unparsed: calls === 0 && bundle.source.includes('__ModuleLoader__.load'),
    })
  }

  const findings: RegistrationFinding[] = []
  // Duplicates first: two registrations claiming one key is a collision inside the
  // module table, and it is the failure that takes a whole batch down with it.
  // Registrations are counted, not files: `register()` throws on the second call for
  // a taken key whatever made it, so a single file that declares its key twice is
  // the "bundle executed twice" the loader's own message names.
  const byKey = new Map<string, RegistrationFile[]>()
  for (const file of files) {
    for (const key of file.keys) {
      const claiming = byKey.get(key) ?? []
      if (!claiming.includes(file)) claiming.push(file)
      byKey.set(key, claiming)
    }
  }
  for (const [key, claiming] of byKey) {
    if (registrationsOf(claiming, key) > 1) findings.push({ severity: 'duplicate', key, files: claiming })
  }
  for (const file of files) {
    if (file.keys.includes(file.expected)) continue
    // A file this guard could not read is disclosed, never accused.
    if (file.keys.length === 0 && (file.opaque > 0 || file.unparsed)) continue
    findings.push({ severity: 'unregistered', key: file.expected, files: [file] })
  }
  findings.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity]
    || (left.key < right.key ? -1 : left.key > right.key ? 1 : 0))
  return { files, findings }
}

/** Files whose registration this guard could not fully read. */
export function unverifiableFiles(audit: RegistrationAudit): readonly RegistrationFile[] {
  return audit.files.filter(file => file.opaque > 0 || file.unparsed)
}

/** `"<pkg>"` or `"<pkg>/client.thing.js"` — the label a file is reported under. */
function fileLabel(file: RegistrationFile): string {
  return file.kind === 'entry' ? file.id : `${file.id}/${baseName(file.path)}`
}

/**
 * How many registrations of `key` these files make. A file that declares the key
 * twice has two, which is what makes it a collision on its own.
 * @param files - the files claiming the key.
 * @param key - the module-table key.
 * @returns the number of `load()` registrations claiming that key.
 */
function registrationsOf(files: readonly RegistrationFile[], key: string): number {
  return files.reduce((total, file) => total + file.keys.filter(claimed => claimed === key).length, 0)
}

/** A file list for a report, most specific first, without repeating a label. */
function filesText(files: readonly RegistrationFile[]): string {
  const labels = [...new Set(files.map(fileLabel))]
  return labels.join(', ')
}

/**
 * Describe one registration violation as a single log line.
 * @param finding - the violation.
 * @returns a self-contained sentence naming the file, the key and the consequence.
 */
export function describeRegistrationFinding(finding: RegistrationFinding): string {
  if (finding.severity === 'duplicate') {
    const labels = new Set(finding.files.map(fileLabel))
    const count = registrationsOf(finding.files, finding.key)
    const head = labels.size === 1
      ? `"${filesText(finding.files)}" registers the key "${finding.key}" ${String(count)} times in one bundle. `
      : `${String(labels.size)} client bundles register the key "${finding.key}": ${filesText(finding.files)}. `
    return head
      + `The browser module table keys its factories by that id and rejects the later registration with `
      + `\`client-modules: duplicate factory registration for "${finding.key}" (bundle executed twice without invalidate?)\`. `
      + 'One combo batch is a single classic script that registers its bundles in sequence, so that throw also stops every later bundle of the same batch from registering. '
      + 'Give each plugin its own package name as the registration id.'
  }
  const file = finding.files[0]!
  if (file.keys.length === 0) {
    return `"${fileLabel(file)}" never calls __ModuleLoader__.load, so its graph row "${finding.key}" never enters the module table. `
      + `The loader records \`loaded without registering "${finding.key}" via __ModuleLoader__.load\` and falls back to this bundle's one-resource URL, which repeats the miss: `
      + `the plugin's entire browser half is absent, with no host-side failure. Every client bundle must register its own row.`
  }
  const keys = file.keys.map(key => `"${key}"`).join(', ')
  return `"${fileLabel(file)}" registers the key ${keys} but its graph row requires "${finding.key}". `
    + `The loader waits for "${finding.key}" to enter the module table, never sees it, and records \`loaded without registering "${finding.key}" via __ModuleLoader__.load\`: `
    + `the plugin's entire browser half is absent, with no host-side failure. Fix the id this bundle passes to __ModuleLoader__.load.`
}

/**
 * Summarize one registration audit as a single log line.
 * @param audit - the audit to summarize.
 * @returns counts of files, readable registrations, violations and unreadable files.
 */
export function summarizeRegistrations(audit: RegistrationAudit): string {
  const registrations = audit.files.reduce((total, file) => total + file.keys.length, 0)
  const unreadable = unverifiableFiles(audit).length
  const tail = unreadable === 0 ? '' : `; ${String(unreadable)} could not be read and are unverified`
  return `${String(audit.files.length)} client bundle files declare ${String(registrations)} registration keys; `
    + `${String(audit.findings.length)} violate the contract${tail}.`
}
