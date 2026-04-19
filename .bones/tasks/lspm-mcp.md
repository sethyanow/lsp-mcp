---
id: lspm-mcp
title: R8c — $CLAUDE_PLUGIN_ROOT plugin-tree glob source
status: active
type: task
priority: 1
owner: claude-r8c
parent: lspm-cnq
---






## Context

Third and final R8 task. R8a (`lspm-h1n`) closed with the discovery pipeline + built-in defaults + `LSP_MCP_CONFIG`. R8b (`lspm-kgj`) closed with `LSP_MCP_MANIFESTS_DIR` + shared `discoverFromJsonDir` helper + `resolveManifestsDirEnv`. R8c adds the 2nd-priority slot: `$CLAUDE_PLUGIN_ROOT` plugin-tree auto-discovery globbing for `**/lsp-manifest.json`.

Sub-epic SC (`lspm-cnq`): "Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision; conflict logged to stderr." **R8c closes this bullet.**

## Starting state (verified on branch `dev`, post-`lspm-kgj`)

- `src/discover.ts` (189 lines) exports: `SourceKind` (includes `'plugin-tree'` already), `DiscoveredManifest`, `discoverBuiltinManifests`, `discoverConfigFileManifests`, `discoverManifestsDir`, `discoverManifests({configPath, manifestsDir?})`, `mergeDiscoveryPipeline`, `resolveManifestsDirEnv`. Private helper `discoverFromJsonDir(dir, sourceKind)` wraps FS+parse+validate.
- `src/index.ts` reads 4 env vars — `LSP_MCP_CONFIG`, `LSP_MCP_MANIFESTS_DIR`, `LSP_MCP_ROOT`, `LSP_MCP_PLUGINS_DIR`. R8c adds `CLAUDE_PLUGIN_ROOT` as the 5th. Note: that env var is set by Claude Code, not chosen by lsp-mcp.
- `src/tests/discover.test.ts` (659 lines) has 31 tests. Reusable helpers: `writeConfigFixture`, `mkManifest`, `mkDiscovered`.
- Tests baseline: 142 green across 6 suites.
- `package.json`: `minimatch` is available but **not needed** for R8c — we're matching an exact filename, not a glob pattern.
- Node 20.12+ (`@types/node: ^22.18.12`): `readdirSync(dir, { recursive: true, withFileTypes: true })` returns `Dirent` with a `parentPath` field — sufficient for recursive traversal without a glob library. Empirically verified via `node -e`.

## Requirements

Advances sub-epic `lspm-cnq` SC "Layered manifest discovery ... `$CLAUDE_PLUGIN_ROOT` glob ... all merge". **R8c closes the bullet** — after R8c lands, all four sources are wired.

## Design

### New export: `discoverPluginTreeManifests`

```ts
// Public — invoked by discoverManifests when opts.pluginTreeRoot is provided.
export function discoverPluginTreeManifests(root: string): DiscoveredManifest[];
```

Recursively scans `root` for files named exactly `lsp-manifest.json`. Each match is parsed as `PluginManifest`, tagged `sourceKind: 'plugin-tree'`, and includes `sourcePath: <full file path>`. Results sorted alphabetically by `sourcePath` for deterministic ordering.

Implementation uses Node's built-in `readdirSync(root, { recursive: true, withFileTypes: true })` + `.isFile()` + `e.name === 'lsp-manifest.json'` filter. No glob library.

Soft-skip policy (match `discoverFromJsonDir` exactly):
- `root` absent → stderr notice + `[]`
- `root` is a file, not a dir → stderr notice + `[]`
- `readdirSync` throws (EACCES, loop, etc.) → stderr notice + `[]`

### Scope — walk to cache root, per-plugin latest-version filter

**Locked 2026-04-19, refined 2026-04-19 SRE.** R8c walks from `$CLAUDE_PLUGIN_ROOT` up to Claude Code's plugin cache root (3 levels = `../../..`) to find all toolkit-family plugins regardless of marketplace. CC's cache layout is `<cache>/<marketplace>/<plugin>/<version>/<contents>` — empirically verified (probe ran in SRE), undocumented by Anthropic per `claude-code-guide` lookup. `lsp-manifest.json` is the **cross-plugin discovery contract** for the toolkit family (fork wrappers, chunkhound, pyright-mcp, any future LSP-providing plugin).

When a plugin has multiple versions installed simultaneously (CC keeps old hash/semver dirs around), the walker picks the newest **per plugin**: parse `^\d+\.\d+\.\d+` as semver and numeric-compare descending; fall back to mtime descending for hash-named dirs. Stale versions never contribute manifests — filtered at discovery, not at merge.

Implementation:

```ts
// resolvePluginTreeEnv normalizes CLAUDE_PLUGIN_ROOT to the cache root.
// Walk 3 levels: <mkt>/<plug>/<ver>/ layout is stable enough for MVP glue.
// Scan root = path.resolve(raw, '../../..').
```

**Undocumented-layout coupling accepted.** The `claude-code-guide` agent confirmed (2026-04-19) that CC's plugin cache layout, active-version selection, and sibling-discovery APIs are all undocumented implementation details. If CC reshuffles the layout in a future release, R8c's walker breaks visibly (no manifests discovered, plugin-tree count drops to 0, stderr notice on missing root) — one-walker fix, one-test update. Not an existential risk for toolkit glue. Documented as a known coupling; no escape hatch added in Phase 1.

Seam contract (Phase 1 → Phase 2) holds — fork wrappers ship as sibling plugins with `lsp-manifest.json` at their plugin root. `using-lsp-mcp` skill will document the convention for plugin authors.

### New export: `resolvePluginTreeEnv`

Analogue to `resolveManifestsDirEnv`, but walks up 3 levels to the cache root:

```ts
export function resolvePluginTreeEnv(raw: string | undefined): string | undefined;
```

- `undefined` → `undefined`
- `""` (empty string) → `undefined` (guards against `path.resolve('', '../../..')` → cwd's grandparent)
- absolute path → `path.resolve(raw, '../../..')` (walks to cache root)
- relative path → `path.resolve(cwd, raw, '../../..')`

Doc comment references `CLAUDE_PLUGIN_ROOT` by name and notes the 3-level walk is deliberate for cross-marketplace sibling discovery.

### Version picker: `pickLatestVersion`

Internal helper (not exported). Given a list of version-dir entries for one plugin, return the newest.

```ts
interface VersionDir { name: string; fullPath: string; mtimeMs: number; }
function pickLatestVersion(versions: VersionDir[]): VersionDir | null;
```

Sort order (descending, first wins):
1. If both compare-pair entries match `/^(\d+)\.(\d+)\.(\d+)/`, compare major.minor.patch numerically.
2. If only one parses as semver, semver wins over hash.
3. If neither parses, mtime-desc decides.
4. **Tie-break (adversarial):** when the chosen comparator returns 0 (equal semver, equal mtime), fall back to `name` alphabetical ascending. Guarantees second-run idempotency even when filesystem mtime granularity ties two hash dirs.

Returns `null` only for empty input. Pre-release suffixes (`-beta.1`, etc.) are not supported — CC's observed version names are plain semver or opaque hashes, so the regex consumes `^\d+\.\d+\.\d+` and ignores trailing noise.

### Extraction candidates (REFACTOR-phase decisions)

Potential extractions surface during Cycles 2/4/6:

1. **`parseManifestFile(full: string, sourceKind: SourceKind): DiscoveredManifest | null`** — extracted from `discoverFromJsonDir`'s per-file read+parse+validate loop. `discoverPluginTreeManifests` runs the same loop on every `lsp-manifest.json` it finds. REFACTOR-phase decision in Cycle 2 after walker GREEN. Likely extract this time because the walker now has three nested loops above it — keeping parse inline compounds vertical indent.

2. **`resolveDirEnv(raw: string | undefined, parentWalk?: string): string | undefined`** — shared resolver; `resolveManifestsDirEnv` passes no parentWalk, `resolvePluginTreeEnv` passes `'../../..'`. REFACTOR-phase decision in Cycle 4. Alternative: keep separate because their doc comments name different env vars for grep-ability.

Both are ASSESSMENTS, not mandates. Document findings either way.

### Extended `discoverManifests` signature

```ts
export function discoverManifests(opts: {
    configPath: string;
    pluginTreeRoot?: string;   // R8c — CLAUDE_PLUGIN_ROOT
    manifestsDir?: string;
}): DiscoveredManifest[];
```

Merge order: `[builtins, pluginTree, configFile, manifestsDir]`. Plugin-tree slots at priority 2 — overrides built-ins, is overridden by config-file and manifests-dir. Map-insertion-order slot preservation continues to hold through the 4-batch merge.

R8a single-arg form `{ configPath }` and R8b 2-arg form `{ configPath, manifestsDir }` both continue to work — `pluginTreeRoot` is optional.

### `src/index.ts` env var wiring

Add to `main()` before the `discoverManifests` call:

```ts
const pluginTreeRoot = resolvePluginTreeEnv(process.env.CLAUDE_PLUGIN_ROOT);
```

Update the discover call:

```ts
const discovered = discoverManifests({ configPath, pluginTreeRoot, manifestsDir });
```

Doc comment extended to list 5 env vars. `CLAUDE_PLUGIN_ROOT` description notes: "Set by Claude Code when the plugin is installed; absent in bare (non-CC) invocations. When set, R8c scans this root for `lsp-manifest.json` files."

### Observability

Existing `countsBySource` reduce handles any number of source kinds. With all four active, the startup line renders:

```
[lsp-mcp] loaded M manifests (builtin: X, plugin-tree: Y, config-file: Z, manifests-dir: W)
```

Source-kind iteration order is insertion order = discovery order → natural priority order in the log.

## Implementation

### Step 0 — Design locked (SRE probe recorded 2026-04-19)

Cache layout was verified in SRE via local probe of `~/.claude/plugins/cache/`:

```
<cache>/<marketplace>/<plugin>/<version>/<contents>
```

- `lsp-mcp/lsp-mcp/<hash>/` — single-plugin marketplace, hash-versioned
- `pyright-marketplace/pyright-mcp/0.1.0/` — different marketplace, semver-versioned
- `claude-plugins-official/<plugin>/<hash>/` — multi-plugin marketplace
- `agent-deck/agent-deck/<hash>/` had two hash subdirs simultaneously — drives the latest-version filter requirement

`$CLAUDE_PLUGIN_ROOT/../../..` resolves to the cache root; scan scope **locked to 3 levels**. No runtime probe in the walker. Undocumented-layout coupling accepted per user call — MVP glue, not platform infrastructure.

### Step 1 — RED: pluginTreeRoot-absent test

Extend `src/tests/discover.test.ts`. Add `describe('discoverPluginTreeManifests')`. First test: `discoverPluginTreeManifests('/nonexistent-lsp-mcp-r8c-${Date.now()}')` returns `[]` + stderr notice matching `/plugin-tree.*(skipping|missing)/i`. Import `discoverPluginTreeManifests` from `'../discover'`.

Run: `bun run test -- --testPathPattern=discover` → expect TS2305 "has no exported member 'discoverPluginTreeManifests'".

### Step 2 — GREEN: minimal discoverPluginTreeManifests

In `src/discover.ts`, add:

```ts
export function discoverPluginTreeManifests(root: string): DiscoveredManifest[] {
    if (!existsSync(root)) {
        process.stderr.write(
            `[lsp-mcp] plugin-tree source: dir missing at ${root} — skipping\n`
        );
        return [];
    }
    return []; // minimal — Step 4 adds walker
}
```

Run → Step 1 test passes.

### Step 3 — RED: walker on CC-shaped fixture (multi-marketplace, multi-version)

Extend `discover.test.ts`. New test inside `describe('discoverPluginTreeManifests')`:

Build a fixture mimicking `<cache>/<mkt>/<plug>/<ver>/<contents>`:
- `mkdtempSync` cache root
- `<cache>/mkt-a/plug-a/1.0.0/lsp-manifest.json` (name `'plug-a-v1'`, cmd `['v1']`)
- `<cache>/mkt-a/plug-a/2.0.0/lsp-manifest.json` (name `'plug-a-v2'`, cmd `['v2']`) — SHOULD WIN over v1
- `<cache>/mkt-a/plug-b/abc123hash/lsp-manifest.json` (name `'plug-b-hash'`)
- `<cache>/mkt-b/plug-c/0.1.0/nested/deep/lsp-manifest.json` (name `'plug-c-deep'`) — nested-depth match
- `<cache>/mkt-b/plug-c/0.1.0/other.json` decoy (wrong filename)
- Call `discoverPluginTreeManifests(cacheRoot)`

Assertions:
- `length === 3` (v1 filtered out by latest-version pick; decoy filtered by filename)
- names include `'plug-a-v2'`, `'plug-b-hash'`, `'plug-c-deep'`
- `'plug-a-v1'` NOT in names
- entry for `plug-a-v2` has `server.cmd[0] === 'v2'`
- all entries `sourceKind === 'plugin-tree'`
- results sorted by `sourcePath` alphabetically

Run → expect failure (minimal returns `[]`).

### Step 4 — GREEN + REFACTOR: implement cache-walker (per-layer try/catch)

Flesh out with **per-layer try/catch** (adversarial finding — single outer try/catch would drop all siblings on one bad subdir):

1. **Entry guard:** `statSync(cacheRoot).isDirectory()` inside try/catch (soft-skip → stderr + `[]`). If cacheRoot vanishes mid-operation, ENOENT here.
2. **Layer 1 (marketplaces):** try/catch around `readdirSync(cacheRoot, {withFileTypes:true})`. On failure → stderr + `[]`. Filter `e.isDirectory()`.
3. **Layer 2 (plugins):** for each marketplace, try/catch around `readdirSync(mktDir, ...)`. On failure → stderr notice naming the marketplace, continue to next marketplace. Filter `e.isDirectory()`.
4. **Layer 3 (versions):** for each plugin, try/catch around `readdirSync(plugDir, ...)` + per-version-dir `statSync(fullPath).mtimeMs`. On failure → stderr notice naming the plugin, continue. Collect `VersionDir[]`, call `pickLatestVersion(versions)` → winning version or `null` (skip if null).
5. **Layer 4 (winner recursive):** for the winning version only, try/catch around `readdirSync(winner.fullPath, {recursive:true, withFileTypes:true})`. On failure (EACCES mid-walk, symlink loop, version dir deleted) → stderr notice, skip this plugin, continue. Filter `e.isFile() && e.name === 'lsp-manifest.json'`, collect full paths.
6. **Per-file parse:** read + `JSON.parse` + `PluginManifestSchema.safeParse`. Soft-skip on failure (R8b pattern): stderr one line, continue. Push `{manifest, sourceKind:'plugin-tree', sourcePath}`.
7. Outer sort by `sourcePath` ascending before return.

Stderr wording: `[lsp-mcp] plugin-tree: <layer> at <path> unreadable — skipping` where `<layer>` is one of `cache root`, `marketplace`, `plugin`, `version scan`.

**REFACTOR-phase assessment (mandatory):** the read+parse+validate tail is now duplicated verbatim between `discoverFromJsonDir` and `discoverPluginTreeManifests`. Extract `parseManifestFile(full, sourceKind)` if both:
- (a) duplication is ≥8 lines,
- (b) stderr wording and schema semantics are genuinely identical.

Document either decision. Also assess extracting `pickLatestVersion` and/or a layer-walker helper if the walker body still reads as four nested loops — a named helper flattens intent.

Run full suite → 142 baseline + Step 1 + Step 3 = 144 green. No R8a/R8b regressions.

### Step 5 — RED: `resolvePluginTreeEnv` 4-case matrix (with 3-level parent walk)

Extend `discover.test.ts`. New `describe('resolvePluginTreeEnv')` with 4 tests:

- `undefined` → `undefined`
- `''` → `undefined`
- absolute path `/foo/cache/mkt/plug/ver` → `/foo/cache` (walks `../../..`)
- relative path `'mkt/plug/ver'` → `path.resolve(process.cwd(), 'mkt/plug/ver', '../../..')` = cwd

Import `resolvePluginTreeEnv`.

Run → expect TS2305.

### Step 6 — GREEN + REFACTOR: implement `resolvePluginTreeEnv`

```ts
export function resolvePluginTreeEnv(raw: string | undefined): string | undefined {
    return raw && raw.length > 0 ? path.resolve(raw, '../../..') : undefined;
}
```

Doc comment: name `CLAUDE_PLUGIN_ROOT`, note 3-level walk targets CC's cache root (`<cache>/<mkt>/<plug>/<ver>/` layout), note layout is undocumented but observed and stable enough for MVP.

**REFACTOR-phase assessment:** extracting a shared `resolveDirEnv(raw, parentWalk?)` saves ~1 line per caller but loses env-var-specific doc comments. Skip unless a third caller appears. Document the decision.

Run → 8 tests for resolvers total (4 R8b + 4 R8c).

### Step 7 — RED: four-way collision merge test

Extend `discover.test.ts`. New test inside `describe('discoverManifests')`:

- Built-in `pyright` exists (shipped, name `'pyright'`)
- Plugin-tree fixture: `mkdtempSync` cacheRoot; write `<cacheRoot>/mkt/fork/1.0.0/lsp-manifest.json` with `name: 'pyright'`, cmd `['tree-pyright']` (CC-shaped layout required)
- Config-file fixture via `writeConfigFixture`: `pyright` version 88, cmd `['config-pyright']`
- Manifests-dir fixture: `<mDir>/pyright.json` cmd `['dir-pyright']` + `<mDir>/bazel-lsp.json` cmd `['dir-bazel']`
- Call `discoverManifests({ configPath, pluginTreeRoot: cacheRoot, manifestsDir: mDir })`

Assertions:
- Final `pyright`: `sourceKind === 'manifests-dir'`, `server.cmd[0] === 'dir-pyright'`
- Three chained override stderr lines:
  - `/"pyright" from plugin-tree .* overrides prior builtin/`
  - `/"pyright" from config-file .* overrides prior plugin-tree/`
  - `/"pyright" from manifests-dir .* overrides prior config-file/`
- `bazel-lsp` final `sourceKind === 'manifests-dir'`; `bazel-lsp` index < `starpls` index in result (slot preservation through 4-batch chain)

Run → expect `TS2353 'pluginTreeRoot' does not exist in type ...`.

### Step 8 — GREEN: extend `discoverManifests` opts

Update signature to include `pluginTreeRoot?: string`. In body:

```ts
const builtins = discoverBuiltinManifests();
const pluginTree = opts.pluginTreeRoot ? discoverPluginTreeManifests(opts.pluginTreeRoot) : [];
const configFile = discoverConfigFileManifests(opts.configPath);
const manifestsDir = opts.manifestsDir ? discoverManifestsDir(opts.manifestsDir) : [];
return mergeDiscoveryPipeline([builtins, pluginTree, configFile, manifestsDir]);
```

R8a single-arg + R8b 2-arg forms both still pass — the 2nd and 4th batches become `[]` when omitted.

Run test suite → all green.

### Step 9 — Integration: wire `CLAUDE_PLUGIN_ROOT` in `src/index.ts`

Update doc comment to list 5 env vars (add `CLAUDE_PLUGIN_ROOT`). Add env parse:

```ts
const pluginTreeRoot = resolvePluginTreeEnv(process.env.CLAUDE_PLUGIN_ROOT);
```

Update the `discoverManifests` call. `bun run typecheck` clean, `bun run test` green.

### Step 10 — Smoke tests

Write `/tmp/lspm-mcp-smoke.sh` following R8b pattern — build, mktemp, smoke passes with `grep -q` assertions, cleanup. Fixture root must be CC-shaped (`<root>/mkt/plug/ver/<contents>`):

- **Smoke 1 (add):** fork manifest with new name `'fork-pyright'` at `<root>/mkt-x/fork/1.0.0/lsp-manifest.json`. Set `CLAUDE_PLUGIN_ROOT=<root>/mkt-x/fork/1.0.0` (synthetic — resolver walks `../../..` to `<root>`). Assert `plugin-tree: 1` in stderr + `loaded 13 manifests`.
- **Smoke 2 (override):** same layout, manifest named `'pyright'`. Assert `"pyright" from plugin-tree ... overrides prior builtin`.

Run `bash /tmp/lspm-mcp-smoke.sh`. Record both stderr outputs in `bn log lspm-mcp`.

### Step 11 — Adversarial battery for `discoverPluginTreeManifests`

Add `describe('discoverPluginTreeManifests — adversarial')`. Patterns:

- **Empty cache root**: root exists, zero marketplace/plugin/version dirs → `[]`
- **Cache root has a file at marketplace-level**: non-dir entry at layer 1 → skipped, other marketplaces still walked
- **Type boundary**: root points at a file, not dir → soft-skip stderr "not a directory" → `[]`
- **Deep nesting inside version dir**: `lsp-manifest.json` at depth 5+ below version root → still found
- **Semantically hostile: dir named `lsp-manifest.json`** under a version → filtered by `isFile()`
- **Semantically hostile: invalid JSON** → soft-skip per-file + stderr, other manifests unaffected
- **Semantically hostile: non-matching filenames** (`plugin-manifest.json`, `lsp-manifest.txt`) → filtered
- **Latest-version filter — mixed semver**: plugin has `1.0.0`, `1.0.1`, `0.9.9` → only `1.0.1` contributes manifests
- **Latest-version filter — mixed semver + hash**: plugin has `1.0.0` + `abc123hash` → semver wins regardless of mtime
- **Latest-version filter — all hash**: plugin has two hash dirs, distinct mtimes → newer mtime wins
- **Latest-version filter — mtime tie**: two hash dirs with identical `mtimeMs` (`utimesSync` to force) → alphabetically-first name wins (deterministic tie-break)
- **Per-layer EACCES soft-skip**: marketplace-A dir has perms stripped, marketplace-B unaffected → stderr notice names marketplace-A, marketplace-B's manifests still discovered
- **Version dir vanishes mid-walk**: fixture sets up winning version, test harness renames it before inner recursive scan fires (via a spy/hook or by deleting after layer-3 pick) → per-plugin soft-skip, other plugins unaffected. If unit-level injection is awkward, skip and rely on the try/catch code-path being present + stderr spy — document the gap.
- **Second-run idempotency**
- **Plugin dir with zero version subdirs** → plugin skipped cleanly, no crash
- **Self-referential**: `pluginTreeRoot` points inside lsp-mcp's own repo (so `manifests/` with per-LSP `<name>.json` sits under it) → filename convention prevents any match, still `[]`

Each adversarial test: RED → verify expected failure mode → confirm GREEN. Apply Three-Question Framework to each GREEN per the stress-test skill.

### Step 12 — Full verification

```bash
bun run test > /tmp/lspm-mcp-test.log 2>&1 && tail -15 /tmp/lspm-mcp-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 142 baseline + ~15 new (R8c core + adversarial) = ~157 green. Typecheck clean. Build produces bundled `dist/index.js`.

### Step 13 — SC flip in parent sub-epic

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision; conflict logged to stderr." from `[ ]` to `[x]` — R8c closes the bullet.
- Do NOT flip the `bun run test` SC or the zero-env-var smoke SC unless those criteria are fully satisfied — other R tasks (PATH probe, list_languages, set_primary, dynamic schemas, using-lsp-mcp skill) remain open and contribute to those bullets.

### Step 14 — Commit + push

```bash
git add src/discover.ts src/index.ts src/tests/discover.test.ts dist/index.js dist/index.js.map .bones/
git commit -m "lspm-mcp: R8c CLAUDE_PLUGIN_ROOT plugin-tree source — closes R8 layered discovery"
git push
```

Commit body: enumerate new `discoverPluginTreeManifests`, `resolvePluginTreeEnv`, extended `discoverManifests` opts, 4-way merge order, env var wiring, parent sub-epic SC flipped. Note that R8 (all three sub-tasks) is now complete.

Do NOT create follow-up tasks. Sub-epic `lspm-cnq` still has other open SC (PATH probe, list_languages, set_primary, dynamic schemas, using-lsp-mcp skill) — those are separate tasks owned elsewhere.

## Success Criteria

- [ ] `src/discover.ts` exports `discoverPluginTreeManifests(cacheRoot: string): DiscoveredManifest[]`
- [ ] `src/discover.ts` exports `resolvePluginTreeEnv(raw: string | undefined): string | undefined` with empty-string-as-unset semantics; resolves via `path.resolve(raw, '../../..')` to CC's cache root (3-level walk locked)
- [ ] Walker treats `cacheRoot` as `<cache>/<mkt>/<plug>/<ver>/<contents>`: iterates marketplaces, then plugins, then version-dirs; per plugin picks newest version via `pickLatestVersion` (semver-desc, mtime-desc fallback, semver beats hash on mixed input); scans only the winning version recursively for `lsp-manifest.json`
- [ ] `pickLatestVersion` helper implemented: `^(\d+)\.(\d+)\.(\d+)` semver parse + numeric compare desc; non-semver falls back to `mtimeMs` desc; semver entries win over hash entries when mixed
- [ ] Filter is `e.isFile() && e.name === 'lsp-manifest.json'`; no glob library dep
- [ ] Results tagged `sourceKind: 'plugin-tree'` with `sourcePath: <full file path>`; final output sorted alphabetically by sourcePath
- [ ] Soft-skip policy: cacheRoot absent, cacheRoot is file, readdir error at any layer all produce stderr + `[]` (never throw); per-file parse errors soft-skip individually with stderr
- [ ] `discoverManifests` signature accepts optional `pluginTreeRoot?: string`; merge order `[builtins, pluginTree, configFile, manifestsDir]`
- [ ] R8a single-arg + R8b 2-arg opts forms continue to work; 142 baseline tests stay green
- [ ] `src/index.ts` reads `CLAUDE_PLUGIN_ROOT` via `resolvePluginTreeEnv`; passes `pluginTreeRoot` into `discoverManifests`
- [ ] `src/index.ts` doc comment lists all 5 env vars with descriptions; `CLAUDE_PLUGIN_ROOT` notes "set by Claude Code; 3-level walk to cache root is undocumented-CC-layout coupling accepted for MVP"
- [ ] Observability line renders `plugin-tree: N` when source active
- [ ] Four-way collision merge test verifies: builtin → plugin-tree → config-file → manifests-dir chain override; three stderr chain lines; bazel-lsp slot preservation through 4-batch chain; plugin-tree fixture uses CC-shaped `<cache>/mkt/plug/ver/` layout
- [ ] Adversarial battery covers: empty cache root, non-dir marketplace entry skipped, type boundary (cacheRoot is a file), deep nesting in winning version, dir-named-lsp-manifest.json, invalid JSON, non-matching filename, latest-version mixed-semver, latest-version mixed-semver+hash, latest-version all-hash (mtime), **mtime-tie name tie-break** (two hash dirs with equal mtime → alphabetically-first name wins), **per-layer EACCES soft-skip** (unreadable marketplace-A doesn't kill discovery of plugins in marketplace-B), **version dir vanishes mid-walk** (ENOENT during winner recursive scan soft-skips the plugin only), zero-version-dirs plugin, second-run idempotent, self-ref to lsp-mcp repo
- [ ] Walker emits stderr with component-specific wording at each layer: `cache root`, `marketplace`, `plugin`, `version scan` — test at least one layer's message shape
- [ ] Smoke 1 (add): synthetic CC-shaped tree; `CLAUDE_PLUGIN_ROOT=$tmpdir/mkt/plug/ver` → stderr contains `plugin-tree: 1` + `loaded 13 manifests`
- [ ] Smoke 2 (override): same layout, manifest named `pyright` → stderr contains `"pyright" from plugin-tree ... overrides prior builtin`
- [ ] `bun run test` green; `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`
- [ ] Sub-epic `lspm-cnq` SC "Layered manifest discovery ..." flipped `[ ]` → `[x]` — R8c closes the bullet
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit notes R8 layered discovery complete (R8a/R8b/R8c delivered)

## Anti-Patterns

- **NO glob library dependency.** Node's built-in `readdirSync` + exact filename match is sufficient. Pulling in minimatch/globby for this is scope creep.
- **NO naive-recursive walk across the entire cache.** Using `readdirSync({recursive:true})` on `cacheRoot` directly would pick up manifests from stale versions. Walk structured (mkt → plug → version-pick → recursive-within-winner) — otherwise the latest-version filter is bypassed and collision noise returns.
- **NO reading `lsp-manifest.json` as a dir entry.** Filter `e.isFile()` — a subdirectory named `lsp-manifest.json` must be skipped cleanly.
- **NO confusing builtins with plugin-tree entries.** The `manifests/` dir contains `<manifestname>.json`, not `lsp-manifest.json` — the naming convention is distinct by design.
- **NO breaking R8a/R8b signatures.** `pluginTreeRoot` is optional. Existing callers unchanged.
- **NO hard-exit on malformed plugin-tree manifest.** Match R8b's soft-skip-with-stderr policy. Plugin trees are bulk sources; single bad file should skip, not crash.
- **NO removing R8a/R8b fixture helpers.** `writeConfigFixture`, `mkManifest`, `mkDiscovered` are reused by R8c tests.
- **NO changing merge order to put plugin-tree above config-file.** The sub-epic SC locks the order: builtins → plugin-tree → config-file → manifests-dir. User-authored config files and user-pointed dirs both outrank plugin-tree auto-discovery.
- **NO adding a semver library.** `^\d+\.\d+\.\d+` regex + numeric compare is enough for CC's observed version-dir names. Pre-release suffixes, build metadata, and v-prefixes are out of scope — document the limitation if we hit one.
- **NO platform-grade claims about sibling discovery.** This is MVP glue against an undocumented CC cache shape. Don't build escape hatches or registry abstractions preemptively; fix the walker if CC changes layout.
- **NO mandatory extraction of `parseManifestFile` or `resolveDirEnv`.** Both are REFACTOR-phase ASSESSMENTS. Extract only if the structural case is genuine; document the call either way.

## Key Considerations

- **Undocumented-layout coupling (locked 2026-04-19).** Anthropic's docs don't specify CC's cache shape, active-version selection, or any sibling-discovery API (confirmed via `claude-code-guide`). R8c's walker depends on the observed layout `<cache>/<marketplace>/<plugin>/<version>/<contents>` and the locked assumption that `$CLAUDE_PLUGIN_ROOT/../../..` is the cache root. If CC reshuffles this in a future release: walker yields zero plugin-tree manifests, stderr emits "no matching layout" notice, one patch in `discover.ts` restores function. Accepted MVP trade-off — no escape hatch, no abstraction layer. Fix on breakage.
- **Latest-version per plugin.** The walker picks one version dir per `<marketplace>/<plugin>` pair; stale installs never contribute manifests. Semver parseable (`^\d+\.\d+\.\d+`) wins numerically; hash-only dirs sort by mtime; mixed semver+hash resolves semver-first. This is the intended fix for the `agent-deck/agent-deck/{hash1,hash2}` duplicate-install pattern observed in the cache.
- **Self-reference hazard.** When `$CLAUDE_PLUGIN_ROOT` points inside lsp-mcp's own repo during dev (so `../../..` may resolve outside the cache), the walker either finds no `lsp-manifest.json` files (builtin `manifests/` holds `<name>.json`, not the contract filename) or scans an unrelated tree and emits stderr. Either is safe; adversarial test pins it.
- **Depth limit.** `readdirSync({recursive:true})` inside the winning version dir has no cap. Fork wrappers with huge `node_modules` trees could slow startup. Node 20+ detects symlink cycles per docs. Not a correctness concern for MVP; document if it surfaces.
- **Windows path separators.** `path.join(e.parentPath, e.name)` handles `/` vs `\`. Tests assert on suffix `lsp-manifest.json`, not path shape.
- **Empty-string env var.** Matches `resolveManifestsDirEnv` — `""` treated as unset to prevent `path.resolve('', '../../..')` from landing at `cwd/../../..`.
- **`$CLAUDE_PLUGIN_ROOT` vs `LSP_MCP_ROOT` separation.** `LSP_MCP_ROOT` is the LSP workspace root (passed to each `LspServer`). `CLAUDE_PLUGIN_ROOT` is consumed for plugin-tree discovery. Don't conflate.
- **`parseManifestFile` extraction trigger.** Walker's read+parse+validate tail is now 100% duplicated with `discoverFromJsonDir`'s tail (≥8 lines). Likely extract during Cycle 4 REFACTOR; document the call either way.
- **`resolveDirEnv` extraction trigger.** Two resolvers now differ only in parent-walk arg (`undefined` vs `'../../..'`). Shared helper saves 2-3 lines but loses env-var-specific doc comments. Lean toward keep-separate; document decision.

## Failure Catalog (post-SRE 2026-04-19)

### `discoverPluginTreeManifests` walker

**Encoding Boundaries: UTF-8 BOM in `lsp-manifest.json`**
- Assumption: users author clean UTF-8 JSON.
- Betrayal: Windows-authored fork ships `lsp-manifest.json` with BOM prefix.
- Consequence: `JSON.parse` throws; manifest skipped.
- Mitigation: per-file try/catch around parse (same as R8b) → stderr + continue. No structural change.

**State Corruption: cacheRoot points at a regular file**
- Assumption: `CLAUDE_PLUGIN_ROOT/../../..` is a directory.
- Betrayal: env var points at a file, or `../../..` lands at a regular file on an unusual install layout.
- Consequence: `readdirSync` throws `ENOTDIR`.
- Mitigation: `statSync(cacheRoot).isDirectory()` guard at entry → stderr + `[]`.

**Dependency Treachery: EACCES at inner layer (STRUCTURAL — per-layer try/catch)**
- Assumption: if cacheRoot is readable, descendants are too.
- Betrayal: one marketplace subdir has perms stripped, or a `node_modules` with weird perms sits inside a version dir.
- Consequence: a **single outer try/catch drops the entire batch** on one bad subdir. Unacceptable — a broken plugin-A sibling shouldn't hide plugin-B's manifest.
- Mitigation (structural): per-layer try/catch. Each `readdirSync` call (marketplace layer, plugin layer, version-stat layer, winner-recursive-scan layer) wrapped independently; failure at any layer soft-skips that subtree and continues siblings. See implementation Step 4 — `single try/catch wrapping statSync + readdirSync` guidance is superseded.

**Dependency Treachery: symlink loop inside winning version dir**
- Assumption: plugin tree has no symlink cycles.
- Betrayal: fork ships `node_modules/self -> ..`.
- Consequence: Node 20.12+ `readdirSync({recursive:true})` claims cycle detection but behavior varies by OS. Worst case: infinite walk, stack or memory exhaustion.
- Mitigation: per-plugin try/catch around inner recursive scan — overflow eventually throws, caught, that plugin skipped. If this ever triggers in practice, add explicit depth cap.

**Temporal Betrayal: file deletion during walk**
- Assumption: files enumerated by `readdirSync` still exist at `readFileSync` time.
- Betrayal: CC's plugin updater deletes a stale install concurrently.
- Consequence: `readFileSync` throws ENOENT; or version dir disappears between layer-3 listing and layer-4 recursive scan.
- Mitigation: per-file try/catch (R8b pattern) AND per-plugin try/catch around the recursive scan.

**Resource Exhaustion: winning version dir with huge `node_modules`**
- Assumption: recursive scan inside one version dir is bounded by plugin authors' good sense.
- Betrayal: a fork wrapper ships unbundled `node_modules/` with 50k+ files.
- Consequence: startup pauses while `readdirSync({recursive:true})` enumerates everything. Walk completes, just slow.
- Mitigation: accepted trade-off for MVP. If a user reports startup >500ms attributable to plugin-tree, add a skip-dirs filter (`node_modules`, `.git`, etc.) — not preemptively.

**State Corruption: two plugins declare the same `lsp-manifest.json` name**
- Assumption: plugin-tree batch has internal unique names.
- Betrayal: `mkt-a/plug-x/.../lsp-manifest.json` and `mkt-b/plug-y/.../lsp-manifest.json` both name themselves `'pyright-fork'`.
- Consequence: `mergeDiscoveryPipeline` logs "from plugin-tree ... overrides prior plugin-tree ..."; final entry is the later one by alphabetical sourcePath.
- Mitigation: deterministic (sort order); stderr makes the shadow visible. Documented behavior.

### `pickLatestVersion` helper

**Input Hostility: semver with v-prefix or pre-release tags**
- Assumption: dir names are plain `^\d+\.\d+\.\d+` or opaque hash.
- Betrayal: dir named `v1.0.0` or `2.0.0-beta.1`.
- Consequence: regex doesn't match (leading `v` fails `^\d`); treated as hash → mtime-sorted. Pre-release `2.0.0-beta.1` DOES match (`^\d+\.\d+\.\d+` consumes `2.0.0`, regex ignores `-beta.1`) — compares equal to `2.0.0` proper. For CC's observed names this is a non-issue; flag if it bites.
- Mitigation: accepted. Documented in the helper spec.

**Temporal Betrayal: mtime tie between two hash dirs (STRUCTURAL — name tie-break)**
- Assumption: mtime gives a total order.
- Betrayal: two installs within the same 1-second filesystem granularity (or `cp -a` preserving mtime) → equal `mtimeMs`.
- Consequence: JS `sort` is stable in V8 but comparator returning 0 means insertion-order-dependent output → **second-run idempotency breaks** under certain Node/V8 combinations.
- Mitigation (structural): when comparator returns 0 (equal semver or equal mtime), tie-break on `name` alphabetical ascending. Makes walker deterministic regardless of fs state. Update helper spec + add test.

**Input Hostility: version list is empty**
- Assumption: every plugin has at least one version dir.
- Betrayal: partially-uninstalled plugin leaves `<cache>/mkt/plug/` empty.
- Consequence: `pickLatestVersion([])` returns `null`.
- Mitigation: caller checks for `null` and skips the plugin. Test covers this.

### `resolvePluginTreeEnv` resolver

**Input Hostility: raw === `/` or extremely shallow path**
- Assumption: `raw` is a plugin version root several levels deep.
- Betrayal: env sets `CLAUDE_PLUGIN_ROOT=/` (misconfig).
- Consequence: `path.resolve('/', '../../..')` === `/`. Walker scans `/` as "cache root" — layer 1 filter iterates `/bin`, `/etc`, etc., none match `<mkt>/<plug>/<ver>/` shape.
- Mitigation: structurally safe — layer filters find no plugins, returns `[]`. Stderr is quiet (no error, just zero results). Accepted.

**Temporal Betrayal: env var absent, then set, between server starts**
- Assumption: env stable for a given lsp-mcp process.
- Betrayal: user rearranges env between CC sessions.
- Consequence: each server start re-reads env — correct by design.
- Mitigation: N/A, not a bug.

### `discoverManifests` opts extension

**State Corruption: pluginTreeRoot === configPath === manifestsDir**
- Assumption: the three sources point at distinct trees.
- Betrayal: user configuration accidentally aliases all three to the same dir.
- Consequence: same manifests loaded three times, merge chain logs N × 3 overrides. Noisy, not broken.
- Mitigation: accepted; documented behavior.

### `src/index.ts` wiring

**Input Hostility: `CLAUDE_PLUGIN_ROOT=""` from shell**
- Assumption: env vars are either unset or meaningful.
- Betrayal: shell `export CLAUDE_PLUGIN_ROOT=` sets empty string.
- Consequence: resolver returns `undefined` (explicit empty-string guard), plugin-tree batch skipped.
- Mitigation: 4-case resolver test covers this.

## Dependencies

- **Blocks:** `lspm-cnq` (parent-of edge; sub-epic)
- **Blocked by:** none — `lspm-kgj` closed
- **Unlocks:** `lspm-cnq` SC "Layered manifest discovery" — closes the bullet on R8c completion, satisfying the final R8-related sub-epic criterion

## Log

- [2026-04-18] [Seth] Scoped via writing-plans during lspm-kgj close-out. Single cohesion seam: add 4th pipeline source (CLAUDE_PLUGIN_ROOT env var → recursive scan for `lsp-manifest.json`) + extend discoverManifests opts + wire env in index.ts. Codebase-verified starting state: discover.ts 189 lines, 8 exports + 1 private helper from R8a/R8b; index.ts 4 env vars; tests 659 lines / 31 green of 142 total. Node 22 readdirSync recursive+withFileTypes confirmed via `node -e` smoke. No glob library needed. ONE OPEN DESIGN DECISION flagged for SRE: scope of CLAUDE_PLUGIN_ROOT scan — (A) root itself vs (B) root's parent. Skeleton defaults to (A); SRE must confirm.
- [2026-04-19] [Seth] Design decision resolved during architectural riff session: scan scope is **(B) sibling plugins in marketplace cache**. Rationale: `lsp-manifest.json` is a cross-plugin discovery contract for the whole toolkit family (fork wrappers, chunkhound, pyright-mcp, future LSP-providing plugins), not a fork-wrapper-only surface. Skeleton updated — "DESIGN DECISION" section rewrote as locked choice; Step 0 (empirical CC cache layout probe) added to implementation; `SCAN_PARENT_LEVELS` constant introduced for 1-vs-2 parent-walk depending on observed layout; unexpected layouts STOP-escalate rather than silent fall back; anti-patterns updated; 1 new SC added.
- [2026-04-19T06:50:26Z] [Seth] Knowledge capture (R8c discovery surfaces):

Three LSP-declaration surfaces exist in CC's plugin cache:
1. plugin.json with inline lspServers block (CC-native, schema-documented)
2. .lsp.json at plugin root (CC-native, sibling-file form, parallel to .mcp.json)
3. lsp-manifest.json (lsp-mcp custom format)

CC-native schema (inline and standalone share shape):
  Required: command, extensionToLanguage
  Optional: args, transport, env, initializationOptions, settings,
            workspaceFolder, startupTimeout, shutdownTimeout,
            restartOnCrash, maxRestarts

Cache layout: ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/<contents>
\$CLAUDE_PLUGIN_ROOT resolves to innermost <version>/

Schema delta lsp-mcp's PluginManifest vs CC-native:
- lsp-mcp richer on: capabilities.impls.stringPrefilter hints
- CC-native richer on: lifecycle (startupTimeout, restartOnCrash, maxRestarts)
- Neither is a superset.

References for future sessions (don't re-derive):
- Skill: plugin-dev:plugin-structure (cache layout, \$CLAUDE_PLUGIN_ROOT semantics)
- CC docs: plugins-reference.md (lspServers schema, plugin.json full field list)
- [2026-04-19T20:51:32Z] [Seth] SRE (2026-04-19): skeleton spot-checked; discover.ts=188, discover.test.ts=618, 142 tests green across 6 suites confirmed. CC cache layout empirically probed — <cache>/<mkt>/<plug>/<ver>/<contents>; single-plugin marketplaces (lsp-mcp, pyright-marketplace) and multi-plugin (claude-plugins-official) both present; agent-deck has 2 hash-version dirs simultaneously (motivates latest-version filter). claude-code-guide confirmed cache layout + active-version selection + sibling-discovery APIs are ALL undocumented by Anthropic. User call: undocumented-coupling accepted, MVP glue not platform. Skeleton updated: scan scope locked to 3-level walk (../../..) to cache root; per-plugin latest-version pick added (semver-desc, mtime-desc fallback, semver beats hash); pickLatestVersion helper spec'd; Step 0 probe deleted (design locked); walker Step 3/4 + resolver Step 5/6 + SC + Key Considerations + Anti-Patterns all rewritten. Markymark angle-bracket warnings in code blocks are cosmetic, not content bugs.
- [2026-04-19T21:04:13Z] [Seth] Step 10 smoke tests PASS. Smoke 1 (add): '[lsp-mcp] loaded 13 manifests (builtin: 12, plugin-tree: 1)'. Smoke 2 (override): '[lsp-mcp] manifest "pyright" from plugin-tree (<tmp>/mkt-smoke/fork-plug/1.0.0/lsp-manifest.json) overrides prior builtin (<repo>/manifests/pyright.json).' then 'loaded 12 manifests (builtin: 11, plugin-tree: 1)'. Script at /tmp/lspm-mcp-smoke.sh.
