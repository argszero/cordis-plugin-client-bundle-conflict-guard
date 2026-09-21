/**
 * Client bundle conflict guard.
 *
 * The Web host composes every mounted client plugin into a small number of
 * combo scripts and serves each as one same-origin **classic script**
 * (`packages/client/modules/src/index.ts`: `buildComboScript` concatenates
 * `prepareSource(resource).source` per bundle with nothing between them, and
 * `packages/client/modules/src/client/system.ts` loads each combo URL through a
 * plain `<script async src>` element). Concatenating bundles does not give them
 * a shared scope — it exposes them to the page's *only* scope. A top-level
 * `var`/`function` in two bundles silently replaces one with the other, and a
 * top-level `let`/`const`/`class` in two bundles is a `SyntaxError` for the
 * script that declares it second: when the collision is inside one combo script
 * the whole script fails to parse, so every client plugin in that batch never
 * registers, not just the colliding pair.
 *
 * Nothing checks the shape. The project's own client preset wraps each bundle
 * body in the closure factory the contract asks for
 * (`packages/client/tsdown.client.ts`: `banner: window.__ModuleLoader__.load({ id, factory: (require) => {`,
 * `footer: 'return module.exports; } });'`, matching
 * `ClientBundleRegistration.factory`: "Closure factory holding the whole bundle
 * body"), and such a bundle declares nothing at the top level — but a bundle
 * that registers itself by calling `load()` from its own top level is legal
 * JavaScript, passes every build, load and registration check, and keeps every
 * declaration it makes.
 *
 * This guard is the composition-time half of the answer. It reads the composed
 * graph the host is already serving — `ClientModuleRegistry.graph()`, whose
 * `batches` say exactly which bundles share one script, plus
 * `ClientModuleRegistry.clientPath(id)` for each bundle's bytes — extracts the
 * top-level declarations of every bundle (and, by default, of the package-local
 * chunks the same loader appends as their own scripts), and reports every name
 * that more than one of them declares, naming the bundles and stating what that
 * declaration kind does when they meet.
 *
 * What it deliberately is not: a fix. The composition is the only place that can
 * give a bundle a scope, and this guard runs on the host, after composition, with
 * no reach into the browser. It **names the collision, it cannot prevent it**;
 * a same-script collision it reports has already broken that script by the time
 * the page loads. Its value is that a failure that today appears only as an
 * opaque console `SyntaxError` in the browser ("Identifier 'x' has already been
 * declared", with no mention of which plugins were involved) becomes a named,
 * attributed line in the host's boot log.
 *
 * @module @argszero/cordis-plugin-client-bundle-conflict-guard
 */

import { readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { WebBootGraph } from '@deepseek-ai/dsh-client-modules'
// Type-only: carries the `webserver/index-inject` event used as the served-graph vantage.
import type {} from '@deepseek-ai/dsh-host-webserver'
import z from '@deepseek-ai/schemastery'
import { analyzeComposition, describeCollision, summarizeAudit } from './analyze.js'
import type { BundleSource, Collision, CompositionAudit } from './analyze.js'

/** Cordis plugin name. */
export const name = 'client-bundle-conflict-guard'

/** Required services: the composed Web client graph. */
export const inject = ['clientModules']

/** Plugin configuration. */
export interface Config {
  /**
   * `report` (the default) logs findings; `error` additionally fails this
   * plugin's fiber when the boot-time audit finds a collision that is fatal
   * (`let`, `const` or `class` against any other declaration of the same name),
   * for a deployment that wants an unusable client bundle to stop the boot
   * audit rather than appear in it.
   */
  mode?: 'report' | 'error'
  /**
   * Also scan the package-local chunks next to each bundle (default `true`).
   * Chunks are loaded through the same classic-script hook, so they share the
   * same global environment; a chunk is only loaded when a bundle requires it,
   * which is why chunk findings name the file rather than a batch.
   */
  chunks?: boolean
}

export const Config: z<Config> = z.object({
  mode: z.union([z.const('report'), z.const('error')]).default('report'),
  chunks: z.boolean().default(true),
})

/**
 * Package-local chunk file names — the same shape the registry's own chunk route
 * accepts (`packages/client/modules/src/index.ts`), so what this guard scans is
 * what the loader can be asked to load.
 */
const CLIENT_CHUNK = /^client\.[A-Za-z0-9][A-Za-z0-9._-]*\.js$/

/** A bundle file this guard could not read, and why. */
interface Problem {
  /** Entry id the file belongs to. */
  readonly id: string
  /** File that could not be read, empty when the graph named no path. */
  readonly path: string
  /** `entry` problems are anomalies worth a warning; `chunk` ones are debug-level. */
  readonly kind: 'entry' | 'chunk'
  /** Failure description. */
  readonly reason: string
}

/** Which vantage asked for a check. */
type Vantage = 'boot' | 'change' | 'serve'

/** Human name for a vantage, used in the summary line. */
const VANTAGE_LABEL: Readonly<Record<Vantage, string>> = {
  boot: 'boot composition',
  change: 'graph change',
  serve: 'served graph',
}

/** Message of an unknown thrown value. */
function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount the guard: audit the boot composition, then re-audit whenever the graph
 * changes or is served.
 *
 * The composition is read, never modified. Nothing here registers a client
 * plugin, patches a bundle or touches the browser.
 * @param ctx - host context.
 * @param config - plugin configuration.
 */
export function apply(ctx: Context, config: Config): void {
  const mode = config.mode ?? 'report'
  const includeChunks = config.chunks !== false
  /** The last audit, keyed by the graph revision it describes. */
  let cached: { readonly rev: string; readonly audit: CompositionAudit } | undefined
  /** Revision the composition summary was last announced for, whichever vantage announced it. */
  let announcedRev: string | undefined
  /** Collisions already reported: name → the sentence that was logged for it. */
  const reported = new Map<string, string>()

  /** Read one bundle file, recording the failure instead of throwing. */
  const readBundle = (id: string, path: string, kind: 'entry' | 'chunk', problems: Problem[]): BundleSource | undefined => {
    try {
      return { id, path, kind, source: readFileSync(path, 'utf8') }
    } catch (error) {
      problems.push({ id, path, kind, reason: reasonOf(error) })
      return undefined
    }
  }

  /** Package-local chunk files of one bundle, in a stable order. */
  const chunkPaths = (id: string, entryPath: string, problems: Problem[]): string[] => {
    let names: string[]
    try {
      names = readdirSync(dirname(entryPath))
    } catch (error) {
      problems.push({ id, path: dirname(entryPath), kind: 'chunk', reason: reasonOf(error) })
      return []
    }
    const entry = basename(entryPath)
    return names.filter(name => name !== entry && CLIENT_CHUNK.test(name)).sort().map(name => join(dirname(entryPath), name))
  }

  /** Every bundle file of one entry: the bundle itself, then its chunks. */
  const filesOf = (graph: WebBootGraph, id: string, problems: Problem[]): BundleSource[] => {
    const path = ctx.clientModules.clientPath(id)
    if (path === undefined) {
      problems.push({ id, path: '', kind: 'entry', reason: 'the composed graph row names no client bundle (the package declares dsh.client but its bundle path is unknown)' })
      return []
    }
    const files: BundleSource[] = []
    const entry = readBundle(id, path, 'entry', problems)
    if (entry !== undefined) files.push(entry)
    if (!includeChunks) return files
    for (const chunk of chunkPaths(id, path, problems)) {
      const file = readBundle(id, chunk, 'chunk', problems)
      if (file !== undefined) files.push(file)
    }
    return files
  }

  /** Audit one graph, reading bundle bytes only for it. */
  const scan = (graph: WebBootGraph): CompositionAudit => {
    const problems: Problem[] = []
    const bundles: BundleSource[] = []
    for (const entry of graph.entries) bundles.push(...filesOf(graph, entry.id, problems))
    for (const problem of problems) {
      const detail = `${problem.id}${problem.path === '' ? '' : ` (${problem.path})`}: ${problem.reason}`
      if (problem.kind === 'entry') ctx.logger.warn(`client-bundle-conflict-guard: cannot scan ${detail}`)
      else ctx.logger.debug(`client-bundle-conflict-guard: cannot scan chunk of ${detail}`)
    }
    return analyzeComposition(graph, bundles)
  }

  /** The audit of the graph as it stands, reused while the graph revision is unchanged. */
  const audit = (): { readonly rev: string; readonly audit: CompositionAudit } => {
    const graph = ctx.clientModules.graph()
    if (cached === undefined || cached.rev !== graph.rev) cached = { rev: graph.rev, audit: scan(graph) }
    return cached
  }

  /** Report one collision at the level its consequence deserves. */
  const report = (collision: Collision): void => {
    const line = `client-bundle-conflict-guard: ${describeCollision(collision)}`
    if (collision.severity === 'silent') ctx.logger.info(line)
    else ctx.logger.warn(line)
  }

  /** Audit the graph and log what changed since the last check. */
  const check = (vantage: Vantage): void => {
    const { rev, audit: result } = audit()
    const appeared: Collision[] = []
    const seen = new Set<string>()
    for (const collision of result.collisions) {
      const sentence = describeCollision(collision)
      seen.add(collision.name)
      if (reported.get(collision.name) === sentence) continue
      reported.set(collision.name, sentence)
      appeared.push(collision)
      report(collision)
    }
    const cleared: string[] = []
    for (const name of [...reported.keys()]) {
      if (seen.has(name)) continue
      reported.delete(name)
      cleared.push(name)
    }
    for (const name of cleared) ctx.logger.info(`client-bundle-conflict-guard: "${name}" no longer collides: the composition changed.`)
    // The boot line always states what the composition holds; a change states it
    // only when the finding changed; the served graph states it once per revision,
    // so a page reload is not a new report.
    const announce = vantage === 'boot'
      || (vantage === 'change' && (appeared.length > 0 || cleared.length > 0))
      || (vantage === 'serve' && announcedRev !== rev)
    if (announce) {
      ctx.logger.info(`client-bundle-conflict-guard: ${VANTAGE_LABEL[vantage]} — ${summarizeAudit(result)}`)
      announcedRev = rev
    }
    if (mode === 'error' && vantage === 'boot') {
      const fatal = result.collisions.filter(collision => collision.severity !== 'silent')
      if (fatal.length > 0) {
        const names = fatal.map(collision => `"${collision.name}" (${collision.severity})`).join(', ')
        throw new Error(`client-bundle-conflict-guard: ${String(fatal.length)} fatal client bundle collision(s): ${names}. The composition still concatenates these bundles; this guard reports, it cannot prevent.`)
      }
    }
  }

  check('boot')
  ctx.effect(() => ctx.clientModules.onGraphChanged(() => { check('change') }), 'client-bundle-conflict-guard: graph change re-audit')
  ctx.on('webserver/index-inject', () => { check('serve') })
}
