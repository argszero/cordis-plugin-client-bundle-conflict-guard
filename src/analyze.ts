/**
 * Composition analysis: which client bundles declare the same name at their top
 * level, which script carries them, and what the collision does at runtime.
 *
 * The input is the composed boot graph the host already serves as
 * `window.__DSH_BOOT__` plus the bytes of each bundle file, so this module holds
 * no filesystem or service knowledge of its own; the plugin supplies both. The
 * graph is what makes the report exact rather than guesswork: `batches` is the
 * registry's own description of the initial combo scripts
 * (`packages/client/modules/src/index.ts`: `graphRow`/`buildBatch`, one combo
 * URL per script, `entries` in execution order), so a same-script collision is
 * read off the composition instead of being inferred from a byte budget.
 *
 * Severity follows the declaration kind, measured in `node:vm` against one
 * realm with one classic script per `runInContext` (all cases verified; the
 * table lives in the README):
 *
 * - a lexical declaration (`let`, `const`, `class`) conflicts with **any** other
 *   declaration of the same name — `function` and `var` included, in either
 *   order, and across script elements as much as within one;
 * - `function` and `var` declarations only replace each other, silently.
 *
 * @module @argszero/cordis-plugin-client-bundle-conflict-guard/analyze
 */

import type { DeclarationKeyword } from './scan.js'
import { isLexical, topLevelDeclarations } from './scan.js'

/** One bundle file as read from disk. */
export interface BundleSource {
  /** Graph entry id (package name) the file belongs to. */
  readonly id: string
  /** Absolute path of the file. */
  readonly path: string
  /** `entry` is the package's `client.js`; `chunk` is an adjacent package-local chunk. */
  readonly kind: 'entry' | 'chunk'
  /** Source text of the file. */
  readonly source: string
}

/** Structural view of one composed graph entry. */
export interface GraphEntryView {
  /** Entry name == package name. */
  readonly id: string
}

/** Structural view of one initial combo script. */
export interface GraphBatchView {
  /** `bootstrap` scripts are parser-blocking; `application` scripts are preloaded. */
  readonly phase: string
  /** Combo endpoint carrying every entry of this script. */
  readonly url: string
  /** Entry ids the script registers, in execution order. */
  readonly entries: readonly string[]
}

/** Structural view of the composed graph; the real `WebBootGraph` satisfies it. */
export interface GraphView {
  /** Composed entries in module-graph order. */
  readonly entries: readonly GraphEntryView[]
  /** Initial combo scripts; every entry belongs to exactly one. */
  readonly batches: readonly GraphBatchView[]
}

/** How a collision resolves. */
export type CollisionSeverity =
  /** Two bundles of one combo script declare the name and at least one is lexical: the script is a SyntaxError. */
  | 'batch-fatal'
  /** Separately loaded scripts declare the name and at least one is lexical: the script that instantiates second is a SyntaxError. */
  | 'script-fatal'
  /** Every declaration is `function` or `var`: no error, the later declaration replaces the earlier one. */
  | 'silent'

/** One bundle's declaration of a colliding name. */
export interface DeclarationSite {
  /** Owning graph entry id. */
  readonly id: string
  /** File that declares it. */
  readonly path: string
  /** Entry bundle or adjacent chunk. */
  readonly kind: 'entry' | 'chunk'
  /** The keyword the file declares it with. */
  readonly keyword: DeclarationKeyword
  /** Combo script carrying the file, or undefined when the file is its own script. */
  readonly script: string | undefined
}

/** One name declared at the top level by more than one bundle. */
export interface Collision {
  /** The declared name. */
  readonly name: string
  /** What happens when the declaring scripts meet. */
  readonly severity: CollisionSeverity
  /** Every declaring bundle, in composition order. */
  readonly sites: readonly DeclarationSite[]
  /** For `batch-fatal`: how many bundles the failing script would have registered. */
  readonly scriptBundles: number | undefined
}

/** One examined bundle file. */
export interface ScannedBundle {
  /** Owning graph entry id. */
  readonly id: string
  /** File that was scanned. */
  readonly path: string
  /** Entry bundle or adjacent chunk. */
  readonly kind: 'entry' | 'chunk'
  /** How many distinct names the file declares at its top level. */
  readonly declarations: number
  /** Combo script carrying the file, or undefined when the file is its own script. */
  readonly script: string | undefined
}

/** The audit of one composition. */
export interface CompositionAudit {
  /** Every file examined, in composition order. */
  readonly bundles: readonly ScannedBundle[]
  /** Collisions, most severe first. */
  readonly collisions: readonly Collision[]
}

/** Severity order used to sort a report. */
const SEVERITY_RANK: Readonly<Record<CollisionSeverity, number>> = {
  'batch-fatal': 0,
  'script-fatal': 1,
  silent: 2,
}

/** Last path segment, for a message that names the file rather than its directory. */
function baseName(path: string): string {
  const cut = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'))
  return cut === -1 ? path : path.slice(cut + 1)
}

/**
 * How a bundle is named in a report: its package id, plus the chunk file when
 * the file is not the package entry.
 * @param site - the declaring bundle.
 * @returns a name that identifies the file within its package.
 */
export function siteLabel(site: DeclarationSite): string {
  return site.kind === 'entry' ? site.id : `${site.id}/${baseName(site.path)}`
}

/** The combo script carrying an entry file, if the graph places it in one. */
function scriptIdentity(id: string, kind: 'entry' | 'chunk', batches: ReadonlyMap<string, GraphBatchView>): string | undefined {
  return kind === 'entry' ? batches.get(id)?.url : undefined
}

/**
 * Audit one composition.
 *
 * A chunk is its own script (the loader appends one `<script>` element per
 * packaged file), so a chunk's script identity is the file itself; an entry's is
 * its combo batch. Two declaring files share a script only when they are entries
 * of the same batch.
 * @param graph - the composed boot graph.
 * @param bundles - the bundle files to scan, in composition order.
 * @returns the collisions and the per-file scan result.
 */
export function analyzeComposition(graph: GraphView, bundles: readonly BundleSource[]): CompositionAudit {
  const batches = new Map<string, GraphBatchView>()
  for (const batch of graph.batches) {
    for (const id of batch.entries) batches.set(id, batch)
  }

  const declarations = new Map<string, DeclarationSite[]>()
  const scanned: ScannedBundle[] = []
  for (const bundle of bundles) {
    const script = scriptIdentity(bundle.id, bundle.kind, batches)
    const declared = topLevelDeclarations(bundle.source)
    scanned.push({
      id: bundle.id,
      path: bundle.path,
      kind: bundle.kind,
      declarations: declared.size,
      script,
    })
    for (const [name, keyword] of declared) {
      const sites = declarations.get(name) ?? []
      sites.push({ id: bundle.id, path: bundle.path, kind: bundle.kind, keyword, script })
      declarations.set(name, sites)
    }
  }

  const collisions: Collision[] = []
  for (const [name, sites] of declarations) {
    if (sites.length < 2) continue
    const lexical = sites.some(site => isLexical(site.keyword))
    const shared = sharedScript(sites)
    const severity: CollisionSeverity = lexical ? (shared === undefined ? 'script-fatal' : 'batch-fatal') : 'silent'
    collisions.push({
      name,
      severity,
      sites,
      scriptBundles: severity === 'batch-fatal' && shared !== undefined ? batchSize(graph, shared) : undefined,
    })
  }
  collisions.sort((left, right) => SEVERITY_RANK[left.severity] - SEVERITY_RANK[right.severity] || (left.name < right.name ? -1 : left.name > right.name ? 1 : 0))
  return { bundles: scanned, collisions }
}

/** The identity of the first script two declaring bundles share, if any. */
function sharedScript(sites: readonly DeclarationSite[]): string | undefined {
  const seen = new Map<string, number>()
  for (const site of sites) {
    const identity = site.script ?? `file:${site.path}`
    const count = seen.get(identity) ?? 0
    if (count === 1) return identity
    seen.set(identity, count + 1)
  }
  return undefined
}

/** How many entries the script with this identity registers. */
function batchSize(graph: GraphView, identity: string): number {
  for (const batch of graph.batches) if (batch.url === identity) return batch.entries.length
  return 0
}

/** The `(keyword)` list of declaring bundles, e.g. `@scope/a (const), @scope/b (function)`. */
function sitesText(sites: readonly DeclarationSite[]): string {
  return sites.map(site => `${siteLabel(site)} (${site.keyword})`).join(', ')
}

/**
 * Describe one collision as a single log line.
 * @param collision - the collision to describe.
 * @returns a self-contained sentence naming the name, the declaring bundles and the consequence.
 */
export function describeCollision(collision: Collision): string {
  const where = sitesText(collision.sites)
  const count = collision.sites.length
  if (collision.severity === 'batch-fatal') {
    const bundles = collision.scriptBundles === undefined ? '' : ` (${String(collision.scriptBundles)} bundles)`
    return `"${collision.name}" is declared at the top level of one combo script by ${String(count)} bundles: ${where}. `
      + `A lexical declaration conflicts with any other declaration of the same name, so that script is a SyntaxError and none of its bundles${bundles} registers. `
      + `Wrap each bundle body in a scope, or rename the declaration.`
  }
  if (collision.severity === 'script-fatal') {
    return `"${collision.name}" is declared at the top level of ${String(count)} separately loaded scripts: ${where}. `
      + 'A lexical declaration conflicts with any other declaration of the same name across scripts in the same realm, '
      + 'so whichever of them instantiates second is a SyntaxError and never runs — bundles load as `async` classic scripts, so load order decides which. '
      + 'Wrap each bundle body in a scope, or rename the declaration.'
  }
  return `"${collision.name}" is declared at the top level of ${String(count)} separately loaded scripts: ${where}. `
    + 'No error: `var` and `function` declarations only replace each other, so the page keeps whichever declaration ran last — which load order decides. '
    + 'The bundles are sharing one global name.'
}

/**
 * Summarize one audit as a single log line.
 * @param audit - the audit to summarize.
 * @returns counts of files, declarations and collisions.
 */
export function summarizeAudit(audit: CompositionAudit): string {
  const declarations = audit.bundles.reduce((total, bundle) => total + bundle.declarations, 0)
  const fatal = audit.collisions.filter(collision => collision.severity !== 'silent').length
  return `${String(audit.bundles.length)} client bundles declare ${String(declarations)} top-level names between them; `
    + `${String(audit.collisions.length)} collide across bundles (${String(fatal)} fatal).`
}
