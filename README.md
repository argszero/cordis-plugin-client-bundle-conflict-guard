# @argszero/cordis-plugin-client-bundle-conflict-guard

Names the client-bundle collisions that the dsh Web host cannot see.

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
| `mode` | `report` | `report` logs findings; `error` additionally fails this plugin's fiber when the boot audit finds a **fatal** collision, for a deployment that wants an unusable client bundle to stop the boot audit rather than appear in it. |
| `chunks` | `true` | Also scan the package-local `client.<name>.js` chunks the same loader appends as their own scripts. A chunk is only loaded when a bundle requires it, so chunk findings name the file rather than a batch. |

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

The guard re-audits when the graph changes and when a page is served, and reports
each collision once — a reload is not a new finding, and a collision that
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
over three synthetic bundles — 9 checks per line, and the two lines the range
must keep out (`0.1.1-rc.2`, `0.1.2-alpha.5`) are asserted to fail the install.
A range is the one claim in this package that no local test can validate, because
the publisher's own install tree already contains the version it was written
against.

## Development

```sh
npm install
npm test              # unit tests + the packaging guard (runs tsc first)
npm run probe         # end-to-end: the real ClientModuleRegistry over real bundles on disk
npm run probe:lines   # the published artifact against every claimed dsh line
```

`npm run probe:lines` installs from the registry, so it only exercises versions
that are published.

## Source

Written for discussion [#7290](https://github.com/deepseek-ai/deepseek-harness/discussions/7290)
("客户端插件 bundle 被拼接成一个脚本 —— 同名顶层声明会让两个插件静默串包").

## License

MIT
