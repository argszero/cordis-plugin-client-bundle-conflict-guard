# @argszero/cordis-plugin-client-bundle-conflict-guard

Names the two composition failures the dsh Web host cannot see: client-bundle
collisions, and client bundles that never register the row they were served for.

The host serves every mounted client plugin from **one same-origin classic script
per combo batch**: `packages/client/modules/src/index.ts` builds each batch with
`buildComboScript`, which concatenates `prepareSource(resource).source` for every
bundle in the batch with nothing between them, and the page loads each combo URL
through a plain `<script async src>`. Concatenation does not give the bundles a
shared scope — it exposes them to the page's *only* scope:

| one bundle declares | the other declares the same name with | what the page gets |
| --- | --- | --- |
| `var`, `function` | `var`, `function` | one silently replaces the other; both bundles keep running against the survivor |
| `let`, `const`, `class` | anything | `SyntaxError` for the whole script — **every** bundle in that batch fails to register |
| `class` | `class` | `SyntaxError` for the whole script |

Nothing checks the shape. The project's own client preset wraps each bundle body
in the closure factory the contract asks for (`packages/client/tsdown.client.ts`
emits `window.__ModuleLoader__.load({ id, factory: (require) => {` … `return
module.exports; } });`), and such a bundle declares nothing at the top level — but
a bundle that calls `load()` from its own top level is legal JavaScript, passes
every build, load and registration check, and keeps every declaration it makes.
When two such bundles meet, the only symptom is an unattributed `SyntaxError` in
the browser console ("Identifier 'x' has already been declared") that names
neither the identifier's bundle nor the batch.

This plugin is the composition-time half of the answer: it reads the composed
graph the host is already serving, extracts the top-level declarations of every
bundle, intersects them across the bundles that share a script, and logs the
colliding **packages and identifiers** in the host log at boot.

## The second contract: the registration key

Concatenation is not the only way a client plugin loses its browser half. The
browser module system keys its factories by one string — the `id` the bundle
passes to `window.__ModuleLoader__.load({ id, factory })`
(`ClientBundleRegistration.id` documents it as "the registration key; must match
the graph row being executed") — and `ClientModuleSystem.register()` normalizes
that id with `stripClientSuffix` (a trailing `/client` is dropped) and, for a
package-local chunk, appends the chunk's file name. The loader's `arrive(row)`
then waits for the **row id — the package name — to appear in that table**.

Two shapes therefore end the same way: the composition succeeds, the graph is
coherent, every file is served, and the plugin's entire browser half is simply
absent, with nothing in the host log to attribute it to.

| what the bundle does | what the module table does | what the page gets |
| --- | --- | --- |
| registers a key that is not its row id (e.g. a rename that updated the package name but not the `id`) | the row id never enters the table | the loader records `loaded without registering "<pkg>" via __ModuleLoader__.load` and falls back to the bundle's one-resource URL, which repeats the miss |
| two bundles register the same key | the later `register()` throws `client-modules: duplicate factory registration for "<id>" (bundle executed twice without invalidate?)` | one combo batch is a single classic script that registers its bundles in sequence, so that throw also **stops every later bundle of the same batch** from registering |
| never calls `load()` at all | the row id never enters the table | as the first row |

The guard reads the keys out of the bundle bytes and reports each one whose key
is not the key its row requires, plus each key more than one registration claims.
It reads the requirement off the file rather than off a second structure, so the
two cannot disagree.

## Install

```sh
npm install @argszero/cordis-plugin-client-bundle-conflict-guard
```

The package ships a bundle patch (`cordis.patch.yml`), so mounting it is one row
in the configuration:

```yaml
- insert:
    - id: client-bundle-conflict-guard
      name: '@argszero/cordis-plugin-client-bundle-conflict-guard'
```

If the patch document you are editing already has rows, add the same `insert`
entry instead of a second document.

## Configuration

| key | default | meaning |
| --- | --- | --- |
| `mode` | `report` | `report` logs findings; `error` additionally fails this plugin's fiber when the boot audit finds a **fatal** collision — `let`/`const`/`class` against any other declaration of the same name — for a deployment that wants an unusable client bundle to stop the boot audit rather than appear in it. Registration-contract violations are **never** fatal here: they cost one plugin its browser half, which is exactly the kind of finding a boot-time audit exists to report rather than to fail on. |
| `chunks` | `true` | Also scan the package-local `client.<name>.js` chunks the same loader appends as their own scripts. A chunk is only loaded when a bundle requires it, so chunk findings name the file rather than a batch. |

The registration audit has no switch: it reads the same files the collision scan
already reads, and a registration miss has no other symptom to catch.

## What it logs

A collision, naming both bundles, the declaration kind each used, and the
consequence:

```
warn: client-bundle-conflict-guard: "makeWidget" is declared at the top level of one
combo script by 2 bundles: @acme/plugin-a (const), @acme/plugin-b (class). A lexical
declaration conflicts with any other declaration of the same name, so that script is a
SyntaxError and none of its bundles (3 bundles) registers. Wrap each bundle body in a
scope, or rename the declaration.
```

and a summary of the composition, once per boot revision:

```
info: client-bundle-conflict-guard: boot composition — 3 client bundles declare 2
top-level names between them; 1 collide across bundles (1 fatal).
```

A bundle whose registration does not satisfy its row — and the coverage of the
registration audit itself, on its own line, so a clean collision count is never
mistaken for a full audit:

```
warn: client-bundle-conflict-guard: "@acme/plugin-a" registers the key
"@acme/plugin-renamed" but its graph row requires "@acme/plugin-a". The loader waits
for "@acme/plugin-a" to enter the module table, never sees it, and records `loaded
without registering "@acme/plugin-a" via __ModuleLoader__.load`: the plugin's entire
browser half is absent, with no host-side failure. Fix the id this bundle passes to
__ModuleLoader__.load.

info: client-bundle-conflict-guard: boot composition — 3 client bundle files declare
3 registration keys; 1 violate the contract.
```

The guard re-audits when the graph changes and when a page is served, and reports
each violation once — a reload is not a new finding, and a violation that
disappears is reported as cleared.

## Honest boundary

**It names the collision; it cannot prevent it.** A same-script collision it
reports has already broken that script by the time the page loads — this guard
runs on the host, after composition, with no reach into the browser and no write
path into the bundle bytes. Giving a bundle a scope is the composer's decision
(and, for the composer, must be **line-neutral**: the graph's section offsets are
accumulated by counting newlines, so a wrapper that shifts lines desynchronises
the served source map). Report mode therefore does not change the served bytes at
all; what it changes is that the failure is attributed in the host log instead of
guessed at from the browser console.

The registration audit has its own boundary, and it is stated in the same spirit:

- **Literal ids only, and the unreadable is disclosed rather than accused.** Keys
  are read from `load({ id: "<literal>" })` call sites. A computed id, or a bundle
  whose only mention of the loader is text rather than a call, cannot be judged:
  such a file is counted as *unreadable* in the summary line and never reported as
  a violation. A `0 violate the contract` line with a disclosure next to it means
  exactly that — nothing the guard could not read is being called clean.
- **The registration key is not the row id, by design.** A package-local chunk
  legitimately registers `<pkg>/<chunk file>`, and a bundle may spell its id with
  the `/client` subpath; both are accepted, because the module table normalizes
  them. The guard mirrors that normalization rather than inventing a stricter one.
- **Same-graph scope.** A violation is judged against the composition the guard
  was given. Two plugins that would collide only when mounted together are
  reported when they are, which is the only moment the host can see them.
- **It cannot fix the id.** The registration id comes from the bundle's own build.
  This guard names the file whose key the composition will not accept; correcting
  it means fixing the package that emitted it.

## Requirements

- `@deepseek-ai/cordis` ^4.0.2
- `@deepseek-ai/dsh-client-modules` (the `clientModules` service)
- `@deepseek-ai/dsh-host-webserver` (optional: only the served-graph re-audit uses
  its `webserver/index-inject` event)

The peer range admits the `0.1.2-rc.1`, `0.1.3-alpha.2`, `0.1.5-rc.2` and
`0.1.6-alpha.2` lines, and that is measured rather than assumed: `npm run
probe:lines` installs **the published version of this package** next to each
line's `@deepseek-ai/dsh-client-modules` in a fresh directory, asserts the
installed line is the one requested, and drives the real `ClientModuleRegistry`
over four synthetic bundles — one wrapped in the official closure factory, two
bare ones sharing a lexical declaration, one registering a key other than its row
id — for **12 checks per line**, and the two lines the range must keep out
(`0.1.1-rc.2`, `0.1.2-alpha.5`) are asserted to fail the install. A range is the
one claim in this package that no local test can validate, because the publisher's
own install tree already contains the version it was written against.

`npm run probe:lines -- --package <tarball>` runs the same 12 checks against a
local artifact instead of the published one, which is how this evidence is
obtained before a publish; the harness lines still come from the registry.

## Development

```sh
npm install
npm test              # unit tests + the packaging guard (runs tsc first)
npm run probe         # end-to-end: the real ClientModuleRegistry over real bundles on disk
npm run probe:lines   # the published artifact against every claimed dsh line
```

`npm run probe:lines` installs from the registry, so it only exercises versions
that are published; `-- --package <tarball|directory>` swaps in a local artifact
for a pre-publish run.

## Source

Written for discussion [#7290](https://github.com/deepseek-ai/deepseek-harness/discussions/7290)
("客户端插件 bundle 被拼接成一个脚本 —— 同名顶层声明会让两个插件静默串包").

The registration-key face answers the follow-up question in
[#9295](https://github.com/deepseek-ai/deepseek-harness/discussions/9295): two
client plugins whose bundles each call `__ModuleLoader__.load` — can they
coexist, and what happens if they register the same id?

## License

MIT
