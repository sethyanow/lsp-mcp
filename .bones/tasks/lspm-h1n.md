---
id: lspm-h1n
title: R8a — discovery pipeline + built-in defaults source
status: open
type: task
priority: 1
parent: lspm-cnq
---



## Context

Fourth task in Phase 1 sub-epic `lspm-cnq`, parent epic `lspm-y5n`. Predecessors: `lspm-z4z` closed R4 (multi-candidate router + `via?` / `manifests?` params), `lspm-177` closed R2 (12 built-in manifests at repo-root `manifests/`, dormant until a loader lands).

R8 (sub-epic SC: "Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision; conflict logged to stderr") has three structural seams. Per CLAUDE.md one-cohesion-seam-per-task, R8 is decomposed into three sequential tasks:

- **R8a (this task):** Discovery pipeline architecture + built-in defaults source + `LSP_MCP_CONFIG` refactor into the pipeline + `sourceKind` tag on `ManifestEntry` + integration wire-up in `src/index.ts`. End-to-end outcome: zero-env startup loads 12 built-in defaults and serves queries.
- **R8b (follow-up):** `LSP_MCP_MANIFESTS_DIR` env var source added to the pipeline.
- **R8c (follow-up):** `$CLAUDE_PLUGIN_ROOT` plugin-tree glob source added to the pipeline (scans plugin subtree for `lsp-manifest.json`).

R8a closes the observable gap: the runtime currently logs "no config file ... starting with zero manifests" when no `LSP_MCP_CONFIG` is set; after R8a, 12 defaults activate automatically. R8b/R8c are additive (more sources), not architectural changes. The sub-epic's layered-discovery SC bullet stays unchecked until all three land.

## Starting state (verified on branch `dev`)

- `src/config.ts:31` defines `resolveManifests(configPath): PluginManifest[]` — reads a single file (`LSP_MCP_CONFIG`), logs a stderr notice + returns `[]` when absent.
- `src/index.ts:22` imports `resolveManifests`; `src/index.ts:35` calls it; `src/index.ts:46-49` maps `PluginManifest[]` → `ManifestEntry[]`.
- `src/router.ts:10-13` defines `ManifestEntry = { manifest: PluginManifest; server: LspServer }` — no `sourceKind` field.
- `ManifestEntry` construction sites beyond `src/index.ts:46`: three test helpers — `src/tests/router.test.ts:7` `entriesFrom`, `src/tests/mcp-server.test.ts:10` `entriesFrom`, `src/tests/e2e.test.ts:11` `entriesFrom`. All three return `ManifestEntry[]` and will need the new field added.
- `manifests/` at repo root with 12 schema-conformant JSON files (lspm-177). Test battery at `src/tests/manifests-library.test.ts` enforces filename=name and bare-cmd invariants on that directory.
- `src/tests/config.test.ts` tests `resolveManifests` (2 tests). Must migrate or delete as part of `resolveManifests` removal.
- Build: `bun build ./src/index.ts --outdir ./dist --target node --format cjs --sourcemap=linked`. Output is CJS — `__dirname` is available at runtime in both source and bundled forms. `import.meta.url` is not used anywhere in src/ (the two `fileURLToPath` imports in `router.ts:1` and `lsp-server.ts:4` are for URI→path conversion on incoming LSP requests, unrelated to module location).
- Tests baseline: 112 green across 6 suites.

## Requirements

Advances sub-epic `lspm-cnq` SC:

> `Layered manifest discovery: built-in defaults dir + $CLAUDE_PLUGIN_ROOT glob + LSP_MCP_CONFIG file + LSP_MCP_MANIFESTS_DIR all merge; later source wins on name collision; conflict logged to stderr.`

R8a delivers the merge pipeline + sources 1 and 3 (built-in defaults + `LSP_MCP_CONFIG`). R8b and R8c add sources 4 and 2 respectively. SC bullet closes when all three tasks close.

## Design

### Module layout

New file: `src/discover.ts`. Public surface:

```ts
// signatures, not implementation

export type SourceKind = "builtin" | "plugin-tree" | "config-file" | "manifests-dir";

export interface DiscoveredManifest {
    manifest: PluginManifest;
    sourceKind: SourceKind;
    sourcePath?: string;   // file or dir that produced this manifest; used in stderr conflict logs
}

/** Source 1 — <root>/manifests/*.json relative to __dirname. Alphabetical order. */
export function discoverBuiltinManifests(): DiscoveredManifest[];

/** Source 3 — LSP_MCP_CONFIG single-file array loader (successor to resolveManifests). */
export function discoverConfigFileManifests(configPath: string): DiscoveredManifest[];

/**
 * Top-level entry point. Runs each source in priority order; merges with
 * later-wins-on-name-collision and stderr conflict logging. Stable registration
 * order across platforms.
 *
 * R8a inputs: configPath only. R8b adds manifestsDir. R8c adds claudePluginRoot.
 */
export function discoverManifests(opts: { configPath: string }): DiscoveredManifest[];
```

### Priority order (later wins on name collision)

1. `builtin` — lowest priority; always loaded if `manifests/` exists
2. `plugin-tree` — R8c; not wired in R8a
3. `config-file` (`LSP_MCP_CONFIG`) — preserves existing user behavior
4. `manifests-dir` (`LSP_MCP_MANIFESTS_DIR`) — R8b; not wired in R8a

R8a emits `[builtin, config-file]`. R8b/R8c insert their sources at slots 4 and 2.

### Built-in defaults path resolution

```ts
// In src/discover.ts
const BUILTIN_DIR = path.resolve(__dirname, '../manifests');
```

Resolution across environments:

| Context | `__dirname` | `../manifests` resolves to |
|---|---|---|
| Source under ts-jest (tests) | `<root>/src` | `<root>/manifests` ✓ |
| Bundled `dist/index.js` (local) | `<root>/dist` | `<root>/manifests` ✓ |
| CC marketplace cache | `${CLAUDE_PLUGIN_ROOT}/dist` | `${CLAUDE_PLUGIN_ROOT}/manifests` ✓ |

Notes:
- `__dirname` in a `bun build --format cjs` bundle refers to the bundle's own directory at runtime (per bun's CJS emission). Not the original source file.
- `process.cwd()` is NOT safe — CC invokes the server from arbitrary working dirs.
- `fileURLToPath(import.meta.url)` (the pattern named in `lspm-cnq` Key Considerations) is ESM-specific. We compile/bundle to CJS; `__dirname` is the right choice. Correcting the parent-epic note is a no-op here — documenting the correction in this task's Key Considerations is sufficient.

### Deterministic iteration order

Every source loader sorts its output alphabetically by filename (or by manifest `name` where applicable) BEFORE returning. `readdirSync` order is FS-dependent (macOS APFS ≠ Linux ext4 ≠ Windows NTFS) — relying on it makes primary selection flaky across platforms. Per `lspm-177` Failure Catalog: starpls + bazel-lsp both declare `starlark`; alphabetical ordering makes `bazel-lsp` register before `starpls` deterministically → `bazel-lsp` becomes primary on every platform.

### `sourceKind` on `ManifestEntry`

Update `src/router.ts:10-13`:

```ts
// current
export interface ManifestEntry {
    manifest: PluginManifest;
    server: LspServer;
}

// after
export interface ManifestEntry {
    manifest: PluginManifest;
    server: LspServer;
    sourceKind: SourceKind;  // threaded from DiscoveredManifest
}
```

Update `src/index.ts:46-49`:

```ts
// after
const discovered = discoverManifests({ configPath });
const entries: ManifestEntry[] = discovered.map((d) => ({
    manifest: d.manifest,
    server: new LspServer(d.manifest, workspaceRoot, pluginsDir),
    sourceKind: d.sourceKind,
}));
```

Update the three `entriesFrom(servers)` helpers in `router.test.ts`, `mcp-server.test.ts`, `e2e.test.ts` to assign a sensible default (`"config-file"` or `"builtin"` — pick one for consistency across fixtures).

### Merge + dedup + stderr conflict log

```ts
// shape sketch
function mergeDiscoveryPipeline(sources: DiscoveredManifest[][]): DiscoveredManifest[] {
    const byName = new Map<string, DiscoveredManifest>();   // preserves insertion order
    for (const batch of sources) {                           // batches in priority order, low → high
        for (const discovered of batch) {
            const prior = byName.get(discovered.manifest.name);
            if (prior) {
                process.stderr.write(
                    `[lsp-mcp] manifest "${discovered.manifest.name}" from ${discovered.sourceKind} ` +
                    `(${discovered.sourcePath ?? '?'}) overrides prior ${prior.sourceKind} ` +
                    `(${prior.sourcePath ?? '?'}).\n`
                );
            }
            byName.set(discovered.manifest.name, discovered);  // later wins; preserves registration slot
        }
    }
    return Array.from(byName.values());
}
```

Router's first-registered-wins primary logic is preserved because Map iteration order = insertion order, and `set()` on an existing key keeps the original slot.

### Behavior on malformed / missing built-in defaults

A malformed shipped file is a bug, but must not brick startup. `discoverBuiltinManifests` logs to stderr and skips the file on Zod failure or JSON parse failure.

**Directory-absent case:** if `manifests/` does not exist at the resolved path (bundler drift, corrupted install, tree relocation), `discoverBuiltinManifests` returns `[]` after emitting a single stderr warning. The server starts with whatever other sources provide; it does NOT throw. `existsSync(BUILTIN_DIR)` before `readdirSync`.

**Config-file (user-authored) policy — locked:** preserve current `resolveManifests` `process.exit(1)` on JSON parse / Zod validation failure. User config correctness is the user's responsibility; hard-exit with a clear message is the expected behavior. Do NOT soft-skip — that would silently degrade a typo'd config and confuse the user. The asymmetry with built-in soft-skip is intentional: shipped bugs are ours, config bugs are theirs.

### Observability log

Add one stderr line at startup enumerating loaded sources + count:

```
[lsp-mcp] loaded N manifests (builtin: X, config-file: Y)
```

Permanent improvement, not a debug flag. Gives users a one-line confirmation of what got loaded without needing R5's `list_languages` tool.

## Implementation

### Step 1 — RED: built-in defaults loader

File: `src/tests/discover.test.ts` (new). First test: `describe('discoverBuiltinManifests')` with `it('loads the 12 manifests lspm-177 shipped, each tagged sourceKind:"builtin"')`. Assertions: returns 12 entries; each `sourceKind === "builtin"`; names match `CANONICAL` (same list used in `manifests-library.test.ts`); order is alphabetical by `manifest.name`.

Imports: `import { discoverBuiltinManifests } from '../discover';`. 

Run: `bun run test -- --testPathPattern=discover` → expect module-not-found failure.

### Step 2 — GREEN: implement `discoverBuiltinManifests`

Create `src/discover.ts`. Export `SourceKind`, `DiscoveredManifest`, `discoverBuiltinManifests`. Use `path.resolve(__dirname, '../manifests')`, guard with `existsSync(dir)` → if absent, emit one stderr warning and return `[]` (directory-absent case from Design § "Behavior on malformed / missing built-in defaults"). Otherwise read with `readdirSync(dir, { withFileTypes: true })`, filter `isFile() && name.endsWith('.json')`, sort alphabetically, Zod `safeParse` each via `PluginManifestSchema`, attach `sourceKind: "builtin"` + `sourcePath: <full file path>`. Invalid file → stderr log + skip (don't throw).

Run filtered test → 12 entries, green.

### Step 3 — RED: config-file source loader

Extend `discover.test.ts`. New `describe('discoverConfigFileManifests')`. Tests:
1. Missing file → returns `[]` + stderr notice (preserves current `resolveManifests` behavior).
2. Valid file → returns entries with `sourceKind: "config-file"` + `sourcePath: <configPath>`.

Run → expect function-not-defined failure.

### Step 4 — GREEN: port loader (preserve hard-exit policy)

Port `loadManifests` + `resolveManifests` logic from `src/config.ts` into `src/discover.ts:discoverConfigFileManifests`. Attach `sourceKind: "config-file"` + `sourcePath: configPath`. **Keep hard-exit** (`process.exit(1)`) on JSON parse failure and Zod schema failure for user-authored config — matches current behavior, locked by Design § "Behavior on malformed / missing built-in defaults". Delete `src/config.ts` AND `src/tests/config.test.ts` — port the 2 existing config tests into `discover.test.ts` if still relevant (test 1 "missing file" is already covered by Step 3 test 1; test 2 "valid file" is already covered by Step 3 test 2 — both can be dropped without coverage loss).

Run discovery tests → green.

### Step 5 — RED: merge pipeline test

Extend `discover.test.ts`. Test: `discoverManifests({ configPath })` where `configPath` points at a fixture containing a manifest named `pyright` (colliding with builtin). Expected: final list has pyright from `config-file` source (wins); stderr receives a line matching `/"pyright" from config-file .* overrides prior builtin/`.

Also test: unique config-file entries (e.g., a custom `my-lsp` manifest) appear alongside builtins with no conflict log.

Also test: zero-config-file case (missing `configPath`) returns exactly the 12 builtins, all tagged `builtin`.

**Primary-stability-across-collision test** (from Failure Catalog + Key Considerations): construct `new Router(entriesFrom(discoverManifests({ configPath })))` where `configPath` overrides `bazel-lsp` with a new version of the same manifest (same `langIds: ["starlark", ...]`). Assert `router.primaryForLang("starlark")?.manifest.name === "bazel-lsp"` — Map-insertion-order preservation means the overridden entry keeps `bazel-lsp`'s registration slot (it was first in the alphabetical built-in sort), so the primary remains `bazel-lsp` not `starpls`. This locks down the invariant that `Map.set` on an existing key does not reshuffle slots.

Run → expect `discoverManifests` undefined.

### Step 6 — GREEN: `discoverManifests` + merge

Implement `discoverManifests(opts)`: call `discoverBuiltinManifests()`, then `discoverConfigFileManifests(opts.configPath)`, then `mergeDiscoveryPipeline([builtins, configFile])`. Merge preserves insertion order; later-wins overrides registration slot; stderr conflict log per collision.

Run merge tests → green. Run full discovery suite → green.

### Step 7 — RED: `sourceKind` on `ManifestEntry`

Extend `src/tests/router.test.ts`: add a test constructing a Router from entries carrying explicit `sourceKind` values, asserting `router.entries[i].sourceKind` round-trips. Type-check will fail because `ManifestEntry` doesn't have the field.

Run `bun run typecheck` → expect type error.

### Step 8 — GREEN: extend `ManifestEntry` + migrate test helpers

Update `src/router.ts:10-13` to add `sourceKind: SourceKind`. Import `SourceKind` from `./discover.js`.

Update the three `entriesFrom(servers: LspServer[]): ManifestEntry[]` helpers (`router.test.ts:7`, `mcp-server.test.ts:10`, `e2e.test.ts:11`) to attach `sourceKind: "builtin"` (or `"config-file"` — pick one consistently) on each synthesized entry. 

Update `src/index.ts:46-49` to pass `sourceKind` from `DiscoveredManifest`.

Run typecheck → clean. Run full test suite → green.

### Step 9 — Integration: switch `src/index.ts` to `discoverManifests`

Replace `resolveManifests` import with `discoverManifests`. `src/index.ts:35` becomes:

```ts
const discovered = discoverManifests({ configPath });
```

Followed by the existing capability-warning loop (mapped over `discovered[].manifest`) and the new entry construction (Step 8 pattern).

Add the observability stderr line after discovery:

```ts
const countsBySource = discovered.reduce((acc, d) => {
    acc[d.sourceKind] = (acc[d.sourceKind] ?? 0) + 1;
    return acc;
}, {} as Record<string, number>);
process.stderr.write(
    `[lsp-mcp] loaded ${discovered.length} manifests (` +
    Object.entries(countsBySource).map(([k, v]) => `${k}: ${v}`).join(', ') +
    `)\n`
);
```

### Step 10 — Smoke test: zero-env 12-default load

Commands:

```bash
bun run build 2>&1 | tail -5
echo '' | node dist/index.js 2>&1 | head -10
```

Expected on stdin-closed startup:
- No `no config file ... starting with zero manifests` warning (that loader is gone).
- `[lsp-mcp] loaded 12 manifests (builtin: 12)` observability line.
- May include capability-warning stderr lines from `src/index.ts:37-44` if any manifest has `capabilities.implementations.stringPrefilter: false` (none of the 12 set this — expect zero such warnings).
- Clean shutdown on stdin close.

Record the full output snippet in `bn log lspm-h1n`.

### Step 11 — Full suite + typecheck + build

```bash
bun run test > /tmp/lspm-h1n-test.log 2>&1; tail -15 /tmp/lspm-h1n-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 112 baseline + new discovery tests (est. 5-7) = ~117-119 green. Typecheck clean. Build produces `dist/index.js`.

### Step 12 — Commit + push

```bash
git add src/discover.ts src/router.ts src/index.ts src/tests/discover.test.ts \
    src/tests/router.test.ts src/tests/mcp-server.test.ts src/tests/e2e.test.ts \
    .bones/
# config.ts removed:
git rm src/config.ts src/tests/config.test.ts 2>/dev/null || true
git commit -m "lspm-h1n: R8a discovery pipeline + built-in defaults"
git push
```

Commit body enumerates: sources wired (builtin + config-file), `sourceKind` added to `ManifestEntry`, malformed-policy decision, observability line, config.ts removed. Deferred items: R8b (LSP_MCP_MANIFESTS_DIR), R8c ($CLAUDE_PLUGIN_ROOT plugin-tree glob).

### Step 13 — Create follow-up tasks

After commit lands:

```bash
bn create "R8b — LSP_MCP_MANIFESTS_DIR source" --type=task --priority=1
bn create "R8c — \$CLAUDE_PLUGIN_ROOT plugin-tree glob source" --type=task --priority=1
bn dep <R8b> --blocks lspm-cnq
bn dep <R8c> --blocks lspm-cnq
```

Both new tasks block `lspm-cnq` (sub-epic). Layered-discovery SC bullet stays unchecked until all three land.

## Success Criteria

- [ ] `src/discover.ts` exists with exports: `SourceKind` (type), `DiscoveredManifest` (interface), `discoverBuiltinManifests()`, `discoverConfigFileManifests(configPath)`, `discoverManifests(opts)`, `mergeDiscoveryPipeline(sources)`.
- [ ] `src/router.ts:ManifestEntry` has `sourceKind: SourceKind` field; the three test helpers (`router.test.ts:7`, `mcp-server.test.ts:10`, `e2e.test.ts:11`) attach `sourceKind` consistently.
- [ ] `src/config.ts` and `src/tests/config.test.ts` deleted (or `config.ts` reduced to pure re-export of `discover.ts` if kept for back-compat — prefer deletion per CLAUDE.md).
- [ ] `src/index.ts` calls `discoverManifests({ configPath })` instead of `resolveManifests(configPath)`; builds `ManifestEntry[]` with `sourceKind` propagated; emits the `[lsp-mcp] loaded N manifests (...)` observability line at startup.
- [ ] Built-in defaults loader: `path.resolve(__dirname, '../manifests')`, `withFileTypes` + `.json` filter + alphabetical `.sort()` + Zod `safeParse` + skip-on-invalid.
- [ ] Config-file loader: behavior preserved — empty-array + stderr notice when file absent; `process.exit(1)` on JSON parse or Zod schema failure (matches current `resolveManifests` behavior; locked per Design decision).
- [ ] Built-in loader: `existsSync(BUILTIN_DIR)` guard returns `[]` with one stderr warning when `manifests/` directory is absent.
- [ ] Merge function: later source wins on name collision; stderr line format `[lsp-mcp] manifest "<name>" from <sourceKind> (<path>) overrides prior <sourceKind> (<path>).`.
- [ ] Map-based dedup preserves registration slot → Router's first-registered-wins primary logic still produces `bazel-lsp` as the `starlark` primary (alphabetical order guarantees this across platforms).
- [ ] Zero-env smoke test: `echo '' | node dist/index.js` prints the observability line confirming 12 builtin manifests; no "zero manifests" warning.
- [ ] New discovery tests cover: 12-builtin load, alphabetical order, sourceKind propagation, missing config-file fallback, valid config-file load, name-collision override with stderr log, unique config-file additions, primary-stability across collision (bazel-lsp/starpls invariant).
- [ ] `bun run test` green (baseline 112 + new discovery tests; final count logged to `bn log lspm-h1n`).
- [ ] `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`.
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit message references `lspm-h1n`, enumerates out-of-scope R8b (LSP_MCP_MANIFESTS_DIR) / R8c (plugin-tree glob), notes malformed-default policy decision.
- [ ] Follow-up R8b + R8c tasks created post-commit, both blocking `lspm-cnq`.

## Anti-Patterns

- **NO R8b/R8c work.** `LSP_MCP_MANIFESTS_DIR` env var and `$CLAUDE_PLUGIN_ROOT` plugin-tree glob are deferred follow-ups. Wiring a source here "just in case" creates dead code and expands scope.
- **NO changing manifest JSON content.** `lspm-177`'s 12 files are the R2 contract. R8a reads them, doesn't edit them.
- **NO silent name-collision.** Every cross-source name override must write a stderr line naming both sources and their paths. Missing the log is a correctness bug, not a nice-to-have.
- **NO throwing on malformed built-in.** Built-in defaults are shipped data; a bad file is a ship-side bug, but the server must start with the rest. Log + skip + continue.
- **NO `fileURLToPath(import.meta.url)`.** Bundle format is CJS; `__dirname` is the right choice. The parent-epic note naming `import.meta.url` is ESM-flavored and does not apply to this build.
- **NO PATH probe logic (R3).** R3 determines binary availability; R8a delivers manifest data for a probe to consume. Stay in the data layer.
- **NO test fixtures written into `manifests/`.** Tests use `mkdtempSync` or in-memory fixtures. The real `manifests/` directory stays as-is — adversarial test 6 (bare-cmd) and test 4 (filename=name) will fail if a temp file leaks in.
- **NO `resolveManifests` back-compat shim.** CLAUDE.md bans backwards-compat hacks. If something imports it, fix the importer.
- **NO swallowing of existing malformed-config behavior.** Current `resolveManifests` `process.exit(1)`s on invalid user config. Deciding to switch to soft-skip is a user-facing change and must be called out in the commit message + Key Considerations. Default: preserve hard-exit for user-authored config (see Key Considerations below).

## Key Considerations

- **`__dirname` vs `import.meta.url` — CJS is canonical here.** `package.json` has no `"type": "module"` field; `tsconfig.json` compiles to CJS via `module: "node16"` (CJS by default without `"type":"module"`); `bun build --format cjs` emits CJS; ts-jest runs CJS. `__dirname` is always defined, everywhere. `import.meta.url` is unavailable in CJS runtime. The parent-epic Key Consideration named `fileURLToPath(import.meta.url)` — this is a typo/ESM-bias. R8a corrects to `__dirname`. Updating the parent epic's note is out of scope for this task (Seth-level decision).
- **Malformed built-in vs malformed user config — different policies.** A malformed shipped file is a bug that CI should catch before release, but if one slips through, the server must still start with the other 11. A malformed user config is user error — hard-exit with a clear message is correct (current `resolveManifests` behavior). R8a preserves the asymmetry. If SRE or implementation finds a reason to unify (e.g., user confusion at cryptic exit), surface before changing.
- **Deterministic registration = stable primary.** Router's `_buildLangMap` picks primary as the first entry registered for each langId. Our `.sort()` on filenames + the priority ordering `[builtin, config-file]` mean that across platforms, starpls + bazel-lsp both register with `builtin` source; alphabetical → `bazel-lsp` first → `bazel-lsp` primary for `starlark`. If a user configures a `config-file` entry also named `bazel-lsp`, it overrides (same name), preserving the slot. If a user configures a `config-file` entry named `my-bazel-lsp` with `langIds: ["starlark"]`, it joins as a second candidate and bazel-lsp stays primary. Covered in tests.
- **Map iteration order is insertion order in JS.** Required for the "later wins but keeps registration slot" invariant. Relied on by V8, SpiderMonkey, JavaScriptCore, Node ≥ ES2015. Not portable to environments older than ES2015, which we don't support anyway.
- **Test helper sourceKind choice.** Using `"builtin"` for test fixtures is defensible (tests are verifying router behavior, not discovery); using `"config-file"` avoids any implicit "these are shipped defaults" connotation. Pick one; document in the first helper's comment.
- **Observability line vs list_languages.** The startup `[lsp-mcp] loaded N manifests (...)` line is a terminal-side confirmation. R5's `list_languages` MCP tool is the agent-side surface. Complementary, not redundant.
- **`LSP_MCP_ROOT` and `LSP_MCP_PLUGINS_DIR` untouched.** Those env vars (workspace root + plugin asset dir) are distinct from manifest discovery. Don't change their semantics. `LspServer` construction still passes them through.
- **`lspm-cnq` Key Considerations note — correction needed.** Sub-epic says "via `fileURLToPath(import.meta.url)`". R8a's implementation uses `__dirname` and documents the correction in this task's Key Considerations. If the sub-epic text gets edited (user call), fine; R8a does not edit it.
- **Malformed built-in manifest in CI.** The manifests-library test battery (lspm-177) should catch broken built-ins at commit time. But a file that's valid JSON + valid schema but semantically wrong (unreachable binary, wrong cmd) isn't caught until runtime. R3 (PATH probe) is the next layer of defense.

## Failure Catalog (pre-SRE, expect adversarial-planning to extend)

**Built-in defaults source — read-time failures**
- Assumption: `manifests/` exists and contains only well-formed JSON files.
- Betrayal: A future dev commits a malformed JSON file (trailing comma, typo). Runtime hits it.
- Consequence: Server aborts loading, user loses all 12 defaults.
- Mitigation: Soft-skip (stderr log, continue with remaining files). `manifests-library.test.ts` catches this at commit time; runtime skip is a secondary line of defense.

**Merge function — same-name collision across non-adjacent sources**
- Assumption: Sources run in priority order, each source produces at most one entry per name (already deduped internally).
- Betrayal: A user with both `LSP_MCP_CONFIG` and `LSP_MCP_MANIFESTS_DIR` (R8b) registers the same manifest name in both. Expected outcome: last-source (manifests-dir) wins over config-file, which wins over builtin.
- Consequence: Only relevant once R8b lands. In R8a, the only collision surface is builtin vs config-file. Test covers it.
- Mitigation: Merge pipeline is source-order-agnostic — same `byName.set` logic handles N-way collisions. Scales to R8b/R8c without refactoring.

**Map-based dedup — registration slot preservation**
- Assumption: `Map.set` on an existing key preserves the key's original insertion position.
- Betrayal: If a future runtime ever stopped honoring insertion order (not happening in V8/JSC/Node, but worth naming), Router's primary selection would shift across sources.
- Consequence: `bazel-lsp` vs `starpls` primary could flip when a user adds a `config-file` override.
- Mitigation: Test asserts primary stability across a collision scenario. If it ever fails, we've hit a runtime bug; a workaround is to rebuild a fresh Map preserving intended order.

## Dependencies

- **Blocks:** `lspm-cnq` (Phase 1 sub-epic).
- **Blocked by:** none. Unlocked — `lspm-177` closed.
- **Unlocks:** R8b (LSP_MCP_MANIFESTS_DIR source), R8c ($CLAUDE_PLUGIN_ROOT plugin-tree glob), R3 (PATH probe has the full default set to probe), R5/R6/R7 (all require a loaded manifest set post-discovery).

## Log

- [2026-04-18T08:50:33Z] [Seth] Scoped via writing-plans post-lspm-177 close (2026-04-18). User picked R8 (layered manifest discovery) over R3/R9/R5+R6 at checkpoint. Decomposed R8 into three sequential tasks per CLAUDE.md 'one cohesion seam per task': R8a (this) = pipeline + built-in defaults + sourceKind + LSP_MCP_CONFIG refactor + index.ts wire-up; R8b = LSP_MCP_MANIFESTS_DIR source (follow-up); R8c = CLAUDE_PLUGIN_ROOT plugin-tree glob (follow-up). Sub-epic layered-discovery SC bullet unchecked until all three land. Codebase-verified starting state: resolveManifests at config.ts:31 used only by index.ts:35 + config.test.ts; three test helpers construct ManifestEntry (router/mcp-server/e2e test files) needing sourceKind migration. Correction noted: lspm-cnq Key Consideration says 'fileURLToPath(import.meta.url)' but build format is CJS — R8a uses __dirname. Decision deferred to implementation: malformed-policy for user config (hard-exit vs soft-skip) — recommend preserving current hard-exit. Ready for fresh-session SRE.
- [2026-04-18T09:31:10Z] [Seth] SRE fresh-session review (2026-04-18): spot-checked 8 skeleton claims against codebase — all verified (config.ts:31 resolveManifests, index.ts:22/35/46-49, router.ts:10-13 ManifestEntry, three entriesFrom at router/mcp-server/e2e test files, 12 manifests at repo root, 2 config.test.ts tests, CJS build via bun --format cjs + package.json has no type:module, fileURLToPath only used for URI conversion not module location). Applied all 10 SRE categories. Three gap-fills added (no redesigns): (1) Step 4 malformed-policy 'deferred to implementation' resolved — locked to preserve hard-exit for user config (matches current behavior, skeleton's own recommendation); (2) Step 2 made directory-absent case explicit — existsSync guard returns [] with stderr warning when manifests/ missing; (3) primary-stability-across-collision test added to Step 5 — asserts bazel-lsp stays primary for starlark when config-file overrides bazel-lsp entry, locks Map.set-preserves-slot invariant named in Failure Catalog + Key Considerations. SC updated with two new checkboxes. No anti-pattern or design choice changes. Ready for adversarial-planning (Step 1a).
