---
id: lspm-mcp
title: R8c — $CLAUDE_PLUGIN_ROOT plugin-tree glob source
status: open
type: task
priority: 1
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

### Scope of the `$CLAUDE_PLUGIN_ROOT` scan — sibling plugins (cross-plugin contract)

**Locked 2026-04-19.** R8c scans beyond `$CLAUDE_PLUGIN_ROOT` itself to find sibling plugins in the marketplace cache. This makes `lsp-manifest.json` a **cross-plugin discovery contract** for the whole toolkit family (fork wrappers, chunkhound, pyright-mcp, any future LSP-providing plugin), not just Phase 2 fork wrappers. Any plugin that declares `lsp-manifest.json` at its root is picked up by lsp-mcp's R8c scan and routed via multi-candidate.

Implementation:

```ts
// resolvePluginTreeEnv normalizes CLAUDE_PLUGIN_ROOT to the marketplace cache
// root (one level up from lsp-mcp's own plugin dir) so the walker sees siblings.
// Scan scope = path.resolve(root, '..').
```

Exact parent-walk depth (one level vs two) depends on CC's cache layout: is `$CLAUDE_PLUGIN_ROOT/..` the marketplace-scoped siblings dir, or a hash-versioned subdir of the same plugin? **Requires empirical probe** under a real CC marketplace install before implementation — same approach `lspm-501` used for verifying `${CLAUDE_PLUGIN_ROOT}` resolution. Add Step 0 to the implementation: probe `ls $CLAUDE_PLUGIN_ROOT/..` under CC; if it shows siblings, use `..`; if it shows hash dirs, use `../..`.

Seam contract (Phase 1 → Phase 2) holds unchanged — fork wrappers ship as sibling plugins with their own `lsp-manifest.json`. The contract widens beyond fork wrappers: any toolkit-family plugin declares LSPs the same way. `using-lsp-mcp` skill documents this convention for plugin authors.

### New export: `resolvePluginTreeEnv`

Symmetric with `resolveManifestsDirEnv`:

```ts
export function resolvePluginTreeEnv(raw: string | undefined): string | undefined;
```

- `undefined` → `undefined`
- `""` (empty string) → `undefined` (guards against `path.resolve('')` → cwd scan)
- absolute path → unchanged (via `path.resolve`)
- relative path → resolved against `process.cwd()`

Doc comment references `CLAUDE_PLUGIN_ROOT` by name.

### Extraction candidates (REFACTOR-phase decisions)

Two potential extractions surface during Cycles 2 and 4:

1. **`parseManifestFile(full: string, sourceKind: SourceKind): DiscoveredManifest | null`** — extracted from `discoverFromJsonDir`'s per-file read+parse+validate loop. Both `discoverFromJsonDir` and `discoverPluginTreeManifests` would delegate. REFACTOR-phase decision in Cycle 2 after `discoverPluginTreeManifests` GREEN. If the inline code is ≤10 lines, extraction may be premature.

2. **`resolveDirEnv(raw: string | undefined): string | undefined`** — identical body in `resolveManifestsDirEnv` and `resolvePluginTreeEnv`. REFACTOR-phase decision in Cycle 4. Alternative: keep separate so each can have env-var-specific doc comments.

Both are ASSESSMENTS, not mandates. Document findings either way — don't extract without a structural reason.

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

### Step 0 — Empirical probe: CC cache layout

Before writing the walker, confirm the cache structure under a real CC marketplace install. From a CC session with lsp-mcp installed, run:

```bash
echo "$CLAUDE_PLUGIN_ROOT"
ls "$CLAUDE_PLUGIN_ROOT"
ls "$CLAUDE_PLUGIN_ROOT/.."
ls "$CLAUDE_PLUGIN_ROOT/../.."
```

Expected observations:
- `$CLAUDE_PLUGIN_ROOT/..` shows either (a) sibling plugin dirs by name (use `..` for scan) or (b) hash-versioned subdirs of the current plugin (use `../..`).
- Whichever level has dirs named after plugins is the scan root.

Record findings in `bn log lspm-mcp`. Choose `SCAN_PARENT_LEVELS = 1` or `2` accordingly. `resolvePluginTreeEnv` implementation then becomes:

```ts
export function resolvePluginTreeEnv(raw: string | undefined): string | undefined {
    if (!raw || raw.length === 0) return undefined;
    return path.resolve(raw, SCAN_PARENT_LEVELS === 1 ? '..' : '../..');
}
```

If empirical probe reveals an unexpected layout (e.g., siblings are not discoverable from `$CLAUDE_PLUGIN_ROOT` at any reasonable parent level), **STOP and surface to user** — do not silently fall back to scanning the plugin's own root, because that would collapse the cross-plugin contract.

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

### Step 3 — RED: recursive walker finds `lsp-manifest.json` at multiple depths

Extend `discover.test.ts`. New test inside `describe('discoverPluginTreeManifests')`:

- `mkdtempSync` root
- `mkdirSync` `<root>/fork-a`, `<root>/fork-a/nested`, `<root>/fork-b`
- Write fork-a manifest at `<root>/fork-a/lsp-manifest.json` (name `'fork-a-mf'`) via `mkManifest`
- Write fork-b manifest at `<root>/fork-b/lsp-manifest.json` (name `'fork-b-mf'`)
- Write a decoy at `<root>/fork-a/nested/other.json` (wrong filename — MUST NOT match)
- Call `discoverPluginTreeManifests(root)`

Assertions:
- `length === 2`
- names `['fork-a-mf', 'fork-b-mf']` (alphabetical by sourcePath)
- all entries `sourceKind === 'plugin-tree'`
- all entries' `sourcePath` ends with `lsp-manifest.json`

Run → expect failure (minimal returns `[]`).

### Step 4 — GREEN + REFACTOR: implement walker

Flesh out the body with statSync.isDirectory guard, single try/catch wrapping statSync + recursive readdirSync, filter for `isFile()` + `name === 'lsp-manifest.json'`, sort matches by sourcePath, then per-file read+parse+validate.

**REFACTOR-phase assessment (mandatory):** the per-file read+parse+validate loop is about to duplicate between `discoverFromJsonDir` and `discoverPluginTreeManifests`. Extract `parseManifestFile(full: string, sourceKind: SourceKind): DiscoveredManifest | null` only if BOTH of:
- (a) the duplication is ≥8 lines
- (b) the shared semantics (soft-skip per file, stderr wording, schema validation) are genuinely identical across callers

If yes: extract the helper, collapse both callers. If no: inline and document the call.

Run full test suite → expect 142 baseline + Step 1 + Step 3 = 144 green. No regressions in R8a/R8b tests.

### Step 5 — RED: `resolvePluginTreeEnv` 4-case matrix

Extend `discover.test.ts`. New `describe('resolvePluginTreeEnv')` with 4 tests matching `resolveManifestsDirEnv` shape:

- `undefined` → `undefined`
- `''` → `undefined`
- absolute path → unchanged (via `path.resolve`)
- relative path `'my-tree'` → `path.resolve(process.cwd(), 'my-tree')`

Import `resolvePluginTreeEnv`.

Run → expect TS2305.

### Step 6 — GREEN + REFACTOR: implement `resolvePluginTreeEnv`

Add export matching `resolveManifestsDirEnv` body. Doc comment references `CLAUDE_PLUGIN_ROOT`.

**REFACTOR-phase assessment:** extract shared `resolveDirEnv` only if the doc comments don't need env-var-specific references. Likely skip — each resolver's doc comment names its specific env var for grep-ability. Document the decision either way.

Run → 8 tests for resolvers total (4 R8b + 4 R8c).

### Step 7 — RED: four-way collision merge test

Extend `discover.test.ts`. New test inside `describe('discoverManifests')`:

- Built-in `pyright` exists (shipped, name `'pyright'`)
- Plugin-tree fixture: `mkdtempSync` root; write `<root>/fork/lsp-manifest.json` with `name: 'pyright'`, cmd `['tree-pyright']`
- Config-file fixture via `writeConfigFixture`: `pyright` version 88, cmd `['config-pyright']`
- Manifests-dir fixture: `<mDir>/pyright.json` cmd `['dir-pyright']` + `<mDir>/bazel-lsp.json` cmd `['dir-bazel']`
- Call `discoverManifests({ configPath, pluginTreeRoot: root, manifestsDir: mDir })`

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

Write `/tmp/lspm-mcp-smoke.sh` (follow the R8b pattern — build, mktemp, two smoke passes with `grep -q` assertions, cleanup). Smoke 1: fork manifest with new name `'fork-pyright'` → assert `plugin-tree: 1` in stderr + `loaded 13 manifests`. Smoke 2: fork manifest named `'pyright'` → assert `"pyright" from plugin-tree ... overrides prior builtin`.

Run `bash /tmp/lspm-mcp-smoke.sh`. Record both stderr outputs in `bn log lspm-mcp`.

### Step 11 — Adversarial battery for `discoverPluginTreeManifests`

Add `describe('discoverPluginTreeManifests — adversarial')`. Patterns:

- **Empty**: root exists, zero `lsp-manifest.json` files → `[]`
- **Type boundary**: root points at a file, not dir → soft-skip stderr "not a directory"
- **Deep nesting**: `lsp-manifest.json` at depth 5+ → still found
- **Semantically hostile: dir named `lsp-manifest.json`** → filtered by `isFile()`
- **Semantically hostile: invalid JSON** → soft-skip per-file
- **Semantically hostile: non-matching filename** (`plugin-manifest.json`, `lsp-manifest.txt`) → filtered
- **Second-run idempotency**
- **Self-referential**: `pluginTreeRoot` === repo root (has `manifests/` subdir with non-`lsp-manifest.json` files) → zero matches (filename convention prevents collision)

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

- [ ] `src/discover.ts` exports `discoverPluginTreeManifests(root: string): DiscoveredManifest[]`
- [ ] `src/discover.ts` exports `resolvePluginTreeEnv(raw: string | undefined): string | undefined` with empty-string-as-unset semantics matching `resolveManifestsDirEnv`; resolves to the marketplace-siblings dir (via parent-walk) not to `$CLAUDE_PLUGIN_ROOT` itself
- [ ] Step 0 probe under actual CC install recorded in bn log; `SCAN_PARENT_LEVELS` (1 or 2) chosen based on observed cache layout; unexpected layouts STOP and escalate, not silently fall back
- [ ] Walker uses `readdirSync({recursive: true, withFileTypes: true})` with `e.isFile() && e.name === 'lsp-manifest.json'` filter; no glob library dep
- [ ] Results tagged `sourceKind: 'plugin-tree'` with `sourcePath: <full file path>`; sorted alphabetically by sourcePath
- [ ] Soft-skip policy: root absent, root is file, readdir error all produce stderr + `[]` (never throw)
- [ ] `discoverManifests` signature accepts optional `pluginTreeRoot?: string`; merge order `[builtins, pluginTree, configFile, manifestsDir]`
- [ ] R8a single-arg + R8b 2-arg opts forms continue to work; 142 baseline tests stay green
- [ ] `src/index.ts` reads `CLAUDE_PLUGIN_ROOT` via `resolvePluginTreeEnv`; passes `pluginTreeRoot` into `discoverManifests`
- [ ] `src/index.ts` doc comment lists all 5 env vars with descriptions; `CLAUDE_PLUGIN_ROOT` notes "set by Claude Code"
- [ ] Observability line renders `plugin-tree: N` when source active
- [ ] Four-way collision merge test verifies: builtin → plugin-tree → config-file → manifests-dir chain override; three stderr chain lines; bazel-lsp slot preservation through 4-batch chain
- [ ] Adversarial battery covers: empty root, type boundary, deep nesting, dir-named-lsp-manifest.json, invalid JSON, non-matching filename, second-run idempotent, self-ref to repo root
- [ ] Smoke 1 (add): `CLAUDE_PLUGIN_ROOT=$tmpdir` with fork manifest → stderr contains `plugin-tree: 1` + `loaded 13 manifests` (asserted via `grep -q`)
- [ ] Smoke 2 (override): fork `lsp-manifest.json` named `pyright` → stderr contains `"pyright" from plugin-tree ... overrides prior builtin` (asserted via `grep -qE`)
- [ ] `bun run test` green; `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`
- [ ] Sub-epic `lspm-cnq` SC "Layered manifest discovery ..." flipped `[ ]` → `[x]` — R8c closes the bullet
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit notes R8 layered discovery complete (R8a/R8b/R8c delivered)

## Anti-Patterns

- **NO glob library dependency.** Node's built-in recursive `readdirSync` + exact filename match is sufficient. Pulling in minimatch/globby for this is scope creep.
- **NO pretending the scan scope is internal-only.** Scope is deliberately sibling plugins in the marketplace cache — `lsp-manifest.json` is a cross-plugin contract. If empirical probing (Step 0) reveals the cache layout is different than expected, surface to user — do NOT silently fall back to scanning only the plugin's own root.
- **NO reading `lsp-manifest.json` as a dir entry.** Filter `e.isFile()` — a subdirectory named `lsp-manifest.json` must be skipped cleanly.
- **NO confusing builtins with plugin-tree entries.** The `manifests/` dir contains `<manifestname>.json`, not `lsp-manifest.json` — the naming convention is distinct by design. If BUILTIN_DIR were ever pointed at via `CLAUDE_PLUGIN_ROOT`, no collision should result (adversarial test verifies).
- **NO breaking R8a/R8b signatures.** `pluginTreeRoot` is optional. Existing callers unchanged.
- **NO hard-exit on malformed plugin-tree manifest.** Match R8b's soft-skip-with-stderr policy. Plugin trees are bulk sources; single bad file should skip, not crash.
- **NO removing R8a/R8b fixture helpers.** `writeConfigFixture`, `mkManifest`, `mkDiscovered` are reused by R8c tests.
- **NO changing merge order to put plugin-tree above config-file.** The sub-epic SC locks the order: builtins → plugin-tree → config-file → manifests-dir. User-authored config files and user-pointed dirs both outrank fork-wrapper auto-discovery.
- **NO mandatory extraction of `parseManifestFile` or `resolveDirEnv`.** Both are REFACTOR-phase ASSESSMENTS. Extract only if the structural case is genuine; document the call either way.

## Key Considerations

- **Scan scope — LOCKED 2026-04-19 to sibling plugins.** `lsp-manifest.json` is a cross-plugin contract for the whole toolkit family (fork wrappers, chunkhound, pyright-mcp, future LSP-providing plugins). R8c walks up from `$CLAUDE_PLUGIN_ROOT` to the marketplace cache dir and scans siblings. Exact walk depth (`..` vs `../..`) requires empirical probe (Step 0) against actual CC cache layout before writing the walker.
- **Self-reference hazard.** When `CLAUDE_PLUGIN_ROOT` points at a dir that contains `lsp-manifest.json` files shadowing builtin names, the override is logged and applied correctly. Adversarial test verifies. The naming convention (`lsp-manifest.json` vs `<name>.json` in `manifests/`) prevents collision between plugin-tree and builtin sources when `CLAUDE_PLUGIN_ROOT` points at lsp-mcp's own repo.
- **Depth limit.** `readdirSync({ recursive: true })` has no depth cap. Pathological trees (symlink loops without cycle detection, 10k+ dirs) could slow startup. Node's recursive walker detects symlink cycles per the Node docs — verify behavior if a test flakes. Not a correctness concern for MVP; document as a known limitation if it surfaces.
- **Symlink traversal.** `readdirSync` follows symlinks by default. Fork wrappers shipping symlinked `node_modules` would be traversed. Cycle protection relies on Node's built-ins. Out of scope to add manual cycle detection.
- **Windows path separators.** `path.join(e.parentPath, e.name)` handles `/` vs `\`. Tests checking `sourcePath` endings should use `lsp-manifest.json` as the suffix (Node normalizes internally).
- **Empty-string env var.** Same semantics as `resolveManifestsDirEnv` — `""` treated as unset to prevent `path.resolve('')` → cwd scan. Verified by 4-case resolver test.
- **`$CLAUDE_PLUGIN_ROOT` vs `LSP_MCP_ROOT` separation.** `LSP_MCP_ROOT` is the LSP workspace root (passed to each `LspServer`). `CLAUDE_PLUGIN_ROOT` is the plugin-tree discovery root. Don't conflate or share a variable.
- **`parseManifestFile` extraction trigger.** Two callers is the minimum threshold. If R8c's walker inlines read+parse+validate without becoming ugly, don't extract. If the inline code exceeds ~10 lines of duplication OR error-message wording drifts between callers, extract. Decision goes in REFACTOR-phase assessment of Cycle 2.
- **`resolveDirEnv` extraction trigger.** Two identical 1-line resolvers. Extraction saves 1 line per caller at the cost of losing env-var-specific doc comments. Likely skip; document the no-op decision in REFACTOR-phase assessment.

## Failure Catalog (pre-SRE)

**Encoding Boundaries: UTF-8 BOM in `lsp-manifest.json` files**
- Assumption: users author clean UTF-8 JSON.
- Betrayal: Windows-authored `lsp-manifest.json` has BOM prefix.
- Consequence: `JSON.parse` throws `SyntaxError: Unexpected token`. Soft-skipped by per-file try/catch (same as R8b's handling).
- Mitigation: inherited from the parse loop. No structural change needed.

**State Corruption: root points at a regular file**
- Assumption: `CLAUDE_PLUGIN_ROOT` is a directory.
- Betrayal: user misconfigures or CC's env export points at a file.
- Consequence: `readdirSync` throws `ENOTDIR`.
- Mitigation: `statSync(root).isDirectory()` guard before recursive read — same pattern as `discoverFromJsonDir`.

**Dependency Treachery: permission-denied on recursive walk**
- Assumption: server has read access to every subdirectory under `root`.
- Betrayal: a subdir has `-r` stripped mid-walk, or `statSync` fails on `root` itself (EACCES).
- Consequence: `readdirSync({recursive: true})` throws partway through the walk.
- Mitigation: single try/catch wraps `statSync + readdirSync`. Soft-skip returns `[]` (losing any partial results). Matches R8b's single-catch pattern.

**Dependency Treachery: symlink loop**
- Assumption: plugin tree has no symlink cycles.
- Betrayal: fork wrapper ships `node_modules/self -> ..` (self-referential symlink).
- Consequence: Node's `readdirSync({recursive: true})` SHOULD detect cycles (per Node 20.12+ docs) but the exact behavior differs by OS. If not detected, stack overflow or hang.
- Mitigation: wrap in try/catch — infinite walk eventually exhausts memory/stack and throws; caught and soft-skipped. If this triggers in practice, add explicit depth limit.

**Temporal Betrayal: file deletion during walk**
- Assumption: files enumerated by `readdirSync` still exist at `readFileSync` time.
- Betrayal: user or install tooling deletes a `lsp-manifest.json` between listing and reading.
- Consequence: `readFileSync` throws `ENOENT`.
- Mitigation: existing per-file try/catch in the parse loop soft-skips (same as R8b).

**State Corruption: two fork wrappers with the same manifest name**
- Assumption: plugin-tree batch has no internal name collisions.
- Betrayal: two forks both name themselves `'pyright-fork'`.
- Consequence: `mergeDiscoveryPipeline` logs "from plugin-tree (...) overrides prior plugin-tree (...)". Final entry is the second one by alphabetical sourcePath sort.
- Mitigation: deterministic (sort order); documented behavior; stderr makes the shadow visible.

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
