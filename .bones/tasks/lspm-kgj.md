---
id: lspm-kgj
title: R8b — LSP_MCP_MANIFESTS_DIR source
status: open
type: task
priority: 1
parent: lspm-cnq
---


## Context

Second of three R8 tasks. R8a (`lspm-h1n`) closed 2026-04-18 with the discovery pipeline + built-in defaults + `LSP_MCP_CONFIG` source wired. R8c (`lspm-mcp`) remains for `$CLAUDE_PLUGIN_ROOT` plugin-tree glob. R8b adds the 4th priority slot: `LSP_MCP_MANIFESTS_DIR` env var → user-specified directory of JSON manifest files.

Sub-epic SC (`lspm-cnq`): "Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision; conflict logged to stderr." Bullet closes when R8c lands. R8b's contribution: adds the 4th source + validates three-way merge (builtin → config-file → manifests-dir).

## Starting state (verified on branch `dev`, post-`lspm-h1n` close)

- `src/discover.ts` (133 lines) exports: `SourceKind` ('builtin' | 'plugin-tree' | 'config-file' | 'manifests-dir'), `DiscoveredManifest`, `discoverBuiltinManifests()`, `discoverConfigFileManifests(configPath)`, `discoverManifests({configPath})`, `mergeDiscoveryPipeline`.
- `discoverBuiltinManifests` body has 40 lines of FS + filter + sort + safeParse — R8b reuses this pattern for the new dir loader, extracted into a shared private helper.
- `src/index.ts:22` imports `discoverManifests`; `src/index.ts:35` calls `discoverManifests({ configPath })`; `src/index.ts:7-16` doc comment lists 3 env vars (`LSP_MCP_CONFIG`, `LSP_MCP_ROOT`, `LSP_MCP_PLUGINS_DIR`).
- `src/tests/discover.test.ts` (305 lines) has 16 tests (7 core + 9 adversarial) + helpers `writeConfigFixture`, `mkManifest`, `mkDiscovered` reusable by R8b tests.
- Tests baseline: 127 green across 6 suites.

## Requirements

Advances sub-epic `lspm-cnq` SC "Layered manifest discovery ... `LSP_MCP_MANIFESTS_DIR` ... all merge". Bullet closes when R8c also lands. R8b delivers sources 1+3+4 (builtin + config-file + manifests-dir); R8c delivers source 2 (plugin-tree).

## Design

### New export: `discoverManifestsDir`

```ts
// Public — invoked by discoverManifests when opts.manifestsDir is provided.
export function discoverManifestsDir(dir: string): DiscoveredManifest[];
```

Reads JSON files from `dir`, tags each with `sourceKind: "manifests-dir"` and `sourcePath: <full file path>`. Soft-skip on dir-absent (consistent with `discoverBuiltinManifests`). Matches the existing dir-loader pattern exactly.

### Shared helper refactor (cycle 2 REFACTOR phase)

After Step 4 GREEN, REFACTOR-phase extracts:

```ts
// Private — shared by discoverBuiltinManifests and discoverManifestsDir.
function discoverFromJsonDir(
    dir: string,
    sourceKind: SourceKind
): DiscoveredManifest[];
```

Both public dir-loaders become 1-line delegations. Preserves all existing behavior: existsSync guard, `readdirSync({withFileTypes})` + `.isFile()` + `.json` filter, alphabetical sort, Zod safeParse, soft-skip on invalid.

The helper ALSO adds two failure-mode guards surfaced by R8b adversarial planning (apply to both dir sources):
- `statSync(dir).isDirectory()` check before `readdirSync` — if user points at a file, soft-skip with "not a directory" message
- try/catch around `readdirSync` — if dir exists but permission-denied, soft-skip with "could not read" message

These are latent bugs in `discoverBuiltinManifests` that the R8b refactor incidentally fixes. Net change is additive safety.

### Extended `discoverManifests` signature

```ts
export function discoverManifests(opts: {
    configPath: string;
    manifestsDir?: string;   // R8b — optional LSP_MCP_MANIFESTS_DIR
}): DiscoveredManifest[];
```

When `manifestsDir` supplied, invoke `discoverManifestsDir(manifestsDir)` and append its batch to the merge pipeline. Merge order: `[builtins, configFile, manifestsDir]`. Manifests-dir highest priority → overrides config-file → overrides builtin. Map-insertion-order preservation still holds: a name that first entered via builtin keeps slot 1; a later manifests-dir entry with same name replaces the slot's contents, not the slot's position.

R8a tests MUST continue to pass — single-arg `discoverManifests({configPath})` (no manifestsDir) preserves R8a behavior exactly.

### `src/index.ts` env var wiring

Add to `main()` before the `discoverManifests` call:

```ts
const rawManifestsDir = process.env.LSP_MCP_MANIFESTS_DIR;
const manifestsDir =
    rawManifestsDir && rawManifestsDir.length > 0
        ? path.resolve(rawManifestsDir)
        : undefined;
```

Then: `discoverManifests({ configPath, manifestsDir })`.

Empty-string env var is treated as unset (defensive against shell export quirks — `export LSP_MCP_MANIFESTS_DIR=` sets it to `""`, which through `path.resolve` would resolve to `process.cwd()` and scan the working directory for JSON files, which is wrong).

Relative paths are normalized via `path.resolve` — CC invokes the server from arbitrary cwds, so relative paths are fragile. Document in the doc comment that absolute paths are recommended.

Doc comment at `src/index.ts:7-16` extended to list `LSP_MCP_MANIFESTS_DIR` as the 4th env var with description.

### Dir-absent policy

Locked: soft-skip + stderr notice. Consistent with `discoverBuiltinManifests`. Rationale: dir-based sources are collections of optional manifests; a missing dir is unsurprising in a cross-machine shared config where only some hosts have the directory. Only single-file `LSP_MCP_CONFIG` hard-exits on malformed content (user-authored correctness expected).

### Observability

The existing `countsBySource` reduce in `src/index.ts:40-43` is generic — no change required. With an active `LSP_MCP_MANIFESTS_DIR` source that contributes N entries, the startup line renders:

```
[lsp-mcp] loaded M manifests (builtin: X, config-file: Y, manifests-dir: N)
```

## Implementation

### Step 1 — RED: dir-absent test

Extend `src/tests/discover.test.ts`. Add `describe('discoverManifestsDir')`. First test: `discoverManifestsDir('/nonexistent-lsp-mcp-r8b')` returns `[]` + stderr notice matching `/manifests-dir.*skipping|missing/i`. Import `discoverManifestsDir` from `'../discover'`.

Run: `bun run test -- --testPathPattern=discover` → expect TS2305 "has no exported member 'discoverManifestsDir'".

### Step 2 — GREEN: minimal `discoverManifestsDir`

In `src/discover.ts`, add:

```ts
export function discoverManifestsDir(dir: string): DiscoveredManifest[] {
    if (!existsSync(dir)) {
        process.stderr.write(
            `[lsp-mcp] manifests-dir missing at ${dir} — skipping manifests-dir source\n`
        );
        return [];
    }
    return [];  // minimal — Step 4 adds read logic
}
```

Run → Step 1 test passes.

### Step 3 — RED: valid dir with multiple manifests

Extend `discover.test.ts`. Test: `mkdtempSync` + write two manifests (`alpha.json` and `beta.json`) using `mkManifest` helper. Call `discoverManifestsDir(tmpDir)`. Assert:
- length 2
- both tagged `sourceKind: "manifests-dir"`
- `sourcePath` ends with `.json`
- alphabetical order (alpha before beta)

Run → expect test to fail (minimal impl returns []).

### Step 4 — GREEN + REFACTOR: full dir-loader + extract shared helper

Replace the minimal `discoverManifestsDir` body with a full copy of `discoverBuiltinManifests`'s read-filter-sort-parse loop, tagged `sourceKind: 'manifests-dir'` and using the dynamic `dir` parameter instead of `BUILTIN_DIR`.

Run → Step 3 test passes.

**REFACTOR phase (mandatory — duplication signal strong):** extract `discoverFromJsonDir(dir: string, sourceKind: SourceKind): DiscoveredManifest[]` as a private function containing the shared logic. Both `discoverBuiltinManifests` and `discoverManifestsDir` become 1-line delegations:

```ts
export function discoverBuiltinManifests(): DiscoveredManifest[] {
    return discoverFromJsonDir(BUILTIN_DIR, 'builtin');
}

export function discoverManifestsDir(dir: string): DiscoveredManifest[] {
    return discoverFromJsonDir(dir, 'manifests-dir');
}
```

Add the adversarial-planning guards inside `discoverFromJsonDir`:
- After `existsSync`, add `statSync(dir).isDirectory()` check → soft-skip if false
- Wrap `readdirSync` in try/catch → soft-skip on permission-denied or other FS errors

Run full suite (`bun run test`) → expect 127 + Step 1 test + Step 3 test = 129 green. No regressions in built-in loader (the extraction preserves its behavior).

### Step 5 — RED: three-way collision merge test

Extend `discover.test.ts`. New test inside `describe('discoverManifests')`:
- `writeConfigFixture` creates config file with one entry named `pyright` (version `88.88.88`, cmd `config-pyright`)
- `mkdtempSync` creates manifests-dir fixture with two entries: `pyright` (version `99.99.99`, cmd `dir-pyright`) and `bazel-lsp` (version `99.99.99`, cmd `dir-bazel`)
- Call `discoverManifests({ configPath: cfg, manifestsDir: tmpDir })`
- Assert:
  - `pyright` entry's `sourceKind === 'manifests-dir'`, `manifest.server.cmd[0] === 'dir-pyright'`
  - `bazel-lsp` entry's `sourceKind === 'manifests-dir'`, `manifest.server.cmd[0] === 'dir-bazel'`
  - Stderr contains line matching `/"pyright" from config-file .* overrides prior builtin/`
  - Stderr contains line matching `/"pyright" from manifests-dir .* overrides prior config-file/`
  - Stderr contains line matching `/"bazel-lsp" from manifests-dir .* overrides prior builtin/`
  - `bazel-lsp` index < `starpls` index in result (slot preservation across chained overrides)

Run → expect failure because `discoverManifests` signature rejects `manifestsDir` (no such property).

### Step 6 — GREEN: extend `discoverManifests` opts

Update signature to `discoverManifests(opts: { configPath: string; manifestsDir?: string })`. In body:

```ts
const builtins = discoverBuiltinManifests();
const configFile = discoverConfigFileManifests(opts.configPath);
const manifestsDir = opts.manifestsDir
    ? discoverManifestsDir(opts.manifestsDir)
    : [];
return mergeDiscoveryPipeline([builtins, configFile, manifestsDir]);
```

Run discover test suite → all green. R8a's single-arg `discoverManifests({configPath})` test also still passes (manifestsDir is optional, omitted → empty batch → no-op merge contribution).

### Step 7 — Integration: wire `LSP_MCP_MANIFESTS_DIR` in `src/index.ts`

Update doc comment at lines 7-16:

```ts
/**
 * Entry point for the meta-LSP MCP server.
 *
 * Reads a plugin configuration file and starts the MCP server.
 *
 * Configuration:
 *   LSP_MCP_CONFIG          Path to a JSON config file listing plugin manifests.
 *                           Defaults to ./lsp-mcp.config.json.
 *   LSP_MCP_MANIFESTS_DIR   Optional directory of JSON manifest files. Each *.json
 *                           file is parsed as a PluginManifest. Highest priority
 *                           source — entries here override config-file and built-in
 *                           defaults on name collision. Use absolute paths; CC
 *                           invokes the server from arbitrary working directories.
 *   LSP_MCP_ROOT            Workspace root passed to each LSP server.
 *                           Defaults to process.cwd().
 *   LSP_MCP_PLUGINS_DIR     Directory containing per-plugin asset dirs.
 *                           ${pluginDir} in cmd/buildHook expands to
 *                           "$LSP_MCP_PLUGINS_DIR/<manifest.name>".
 *                           Defaults to "<dirname(LSP_MCP_CONFIG)>/plugins".
 */
```

Add env var parse after `pluginsDir` resolution:

```ts
const rawManifestsDir = process.env.LSP_MCP_MANIFESTS_DIR;
const manifestsDir =
    rawManifestsDir && rawManifestsDir.length > 0
        ? path.resolve(rawManifestsDir)
        : undefined;
```

Update the discover call:

```ts
const discovered = discoverManifests({ configPath, manifestsDir });
```

Run `bun run typecheck` → clean. Run full suite → 129+ green.

### Step 8 — Smoke test: observability shows `manifests-dir: N`

Commands:

```bash
bun run build 2>&1 | tail -5

# Create fixture dir with one custom manifest
tmpdir=$(mktemp -d)
cat > "$tmpdir/my-custom-lsp.json" <<'EOF'
{
  "name": "my-custom-lsp",
  "version": "0.1.0",
  "langIds": ["custom"],
  "fileGlobs": ["**/*.custom"],
  "workspaceMarkers": [],
  "server": { "cmd": ["my-lsp-stub"] }
}
EOF

LSP_MCP_MANIFESTS_DIR="$tmpdir" echo '' | LSP_MCP_MANIFESTS_DIR="$tmpdir" node dist/index.js 2>&1 | head -5
```

Expected stderr:
- `[lsp-mcp] loaded 13 manifests (builtin: 12, manifests-dir: 1)` — exact substring `manifests-dir: 1` asserted via `grep -q 'manifests-dir: 1'`. If missing, fail the step.

Run a second smoke covering override behavior: create `$tmpdir/pyright.json` with a custom `pyright` manifest; rerun; expect stderr to contain `/"pyright" from manifests-dir .* overrides prior builtin/`.

Record both outputs in `bn log lspm-kgj`.

### Step 9 — Full suite + typecheck + build

```bash
bun run test > /tmp/lspm-kgj-test.log 2>&1; tail -15 /tmp/lspm-kgj-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 127 baseline + Step 1 + Step 3 + Step 5 + potential adversarial = ~131-134 green. Typecheck clean. Build produces bundled `dist/index.js`.

### Step 10 — Commit + push

```bash
git add src/discover.ts src/index.ts src/tests/discover.test.ts dist/index.js dist/index.js.map .bones/
git commit -m "lspm-kgj: R8b LSP_MCP_MANIFESTS_DIR source + shared dir-loader helper"
git push
```

Commit body: enumerate new `discoverManifestsDir`, extracted `discoverFromJsonDir` helper, added dir-is-directory + permission-denied guards (latent bug fix in built-in loader), `manifestsDir` option in `discoverManifests`, `LSP_MCP_MANIFESTS_DIR` env var in index.ts, doc comment updated. Deferred: R8c (`$CLAUDE_PLUGIN_ROOT` plugin-tree glob).

Do NOT create follow-up task stubs. R8c (`lspm-mcp`) already exists from lspm-h1n's Step 13.

## Success Criteria

- [ ] `src/discover.ts` exports `discoverManifestsDir(dir: string): DiscoveredManifest[]`
- [ ] Private helper `discoverFromJsonDir(dir, sourceKind)` extracted from `discoverBuiltinManifests`; both public dir-loaders delegate to it
- [ ] `discoverFromJsonDir` adds two guards: `statSync(dir).isDirectory()` soft-skip, try/catch around `readdirSync` for permission-denied soft-skip
- [ ] `discoverManifests` signature accepts optional `manifestsDir?: string`; R8a single-arg form still works
- [ ] Merge priority `[builtins, configFile, manifestsDir]` — manifests-dir overrides config-file overrides builtin; Map-insertion-order preserves registration slots through chained overrides
- [ ] `src/index.ts` reads `LSP_MCP_MANIFESTS_DIR` env var; empty-string treated as unset; relative paths normalized via `path.resolve`
- [ ] `src/index.ts` doc comment lists all 4 env vars with descriptions; `LSP_MCP_MANIFESTS_DIR` documented with "use absolute paths" note
- [ ] Observability line renders `manifests-dir: N` when source active
- [ ] Dir-absent behavior: soft-skip + stderr notice (matches `discoverBuiltinManifests`)
- [ ] New discovery tests cover: dir-absent, valid dir with 2 manifests (alphabetical), three-way collision (builtin vs config vs manifests-dir), chained-override slot preservation
- [ ] Smoke test with `LSP_MCP_MANIFESTS_DIR` set shows `manifests-dir: N` in startup observability (exact substring `manifests-dir: 1` asserted via `grep -q`)
- [ ] Second smoke with override fixture shows `"pyright" from manifests-dir ... overrides prior builtin` stderr line
- [ ] `bun run test` green (baseline 127 + new tests; final count logged to `bn log lspm-kgj`)
- [ ] `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit references `lspm-kgj`, notes latent-bug fixes in built-in loader (stat + permission guards), defers R8c plugin-tree glob.

## Anti-Patterns

- **NO R8c work.** Plugin-tree glob is `lspm-mcp`'s scope. Scanning plugin subtrees, `lsp-manifest.json` convention — defer.
- **NO breaking R8a signatures.** `discoverManifests({ configPath })` (single-arg) must still work — `manifestsDir` is optional. R8a tests MUST continue to pass.
- **NO hard-exit on dir-absent.** Dir-based sources soft-skip by design. Only `LSP_MCP_CONFIG` file-missing-and-parse-failure hard-exits.
- **NO tilde expansion logic.** Node doesn't expand `~`; users pre-expand via shell. Adding expansion is scope creep with platform-specific edge cases.
- **NO manifest transformation.** Dir-scanned manifests pass through the same `PluginManifestSchema` validation as every other source. No field normalization, no defaults injection.
- **NO separate merge function for manifests-dir.** The existing `mergeDiscoveryPipeline` handles N batches natively; just append.
- **NO removing R8a fixture helpers.** `writeConfigFixture`, `mkManifest`, `mkDiscovered` in `discover.test.ts` are reused by R8b tests.
- **NO test fixtures written into real `manifests/`.** Tests use `mkdtempSync` only. The built-in dir stays as the 12 shipped files.
- **NO skipping the REFACTOR phase in cycle 2.** Duplication between built-in and manifests-dir loaders after Step 4 is a textbook extraction signal. Skipping the extraction doubles the surface where the adversarial guards (stat + permission) would need to be added separately.

## Key Considerations

- **Empty-string env var semantics.** Some shells export unset vars as empty strings when written as `export LSP_MCP_MANIFESTS_DIR=` (no value). Treating empty as unset avoids `path.resolve('')` resolving to `process.cwd()` and scanning the working directory. Checked via `rawManifestsDir && rawManifestsDir.length > 0`.
- **Relative path normalization.** `path.resolve(rawDir)` resolves relative to `process.cwd()`. CC invokes the server from arbitrary working dirs, so relative paths produce unpredictable results. Doc comment recommends absolute paths.
- **Symlinks.** `readdirSync(dir, {withFileTypes: true})` + `dirent.isFile()` follows symlinks to files — consistent with `discoverBuiltinManifests`. Symlink-to-dir inside the dir is skipped (not a regular file).
- **Triple-collision merge trace.** When all three sources declare the same manifest name, `mergeDiscoveryPipeline` iterates batches in order: builtin sets slot, config-file overrides (stderr: "config-file overrides prior builtin"), manifests-dir overrides again (stderr: "manifests-dir overrides prior config-file"). Two stderr lines; final entry is manifests-dir; slot stays at builtin's original insertion position.
- **`sourcePath` for manifests-dir entries.** Must be the full file path (e.g., `/tmp/xyz/pyright.json`), NOT the dir path. Matches `discoverBuiltinManifests` which uses full file paths. Gives users a precise handle in override log lines.
- **Latent-bug fix in built-in loader.** The `statSync(dir).isDirectory()` check and try/catch around `readdirSync` added to `discoverFromJsonDir` incidentally fix two edge cases that would have crashed `discoverBuiltinManifests` if the shipped `manifests/` entry became a regular file (bundler misconfig) or a permission-denied situation (install-time file permissions). Additive safety; no user-observable behavior change on healthy installs.
- **R8c reuse potential.** If R8c's glob resolves to a list of per-manifest file paths (rather than a single dir + filename filter), `discoverFromJsonDir` won't directly apply — R8c likely needs a different helper that takes a file list. Not a blocker for R8b; noted so R8c doesn't over-reuse.
- **Startup log ordering.** `Object.entries(countsBySource)` iteration order is insertion order, which is discovery order (builtin first, config second, manifests-dir third). Log reads `(builtin: X, config-file: Y, manifests-dir: Z)` — natural priority order.

## Failure Catalog (pre-SRE)

**Encoding Boundaries: LSP_MCP_MANIFESTS_DIR with spaces or unicode**
- Assumption: env var value is a plain ASCII path.
- Betrayal: user sets `LSP_MCP_MANIFESTS_DIR="/home/user/my lsps/"` or a path with unicode chars.
- Consequence: `path.resolve` handles spaces/unicode correctly; `readdirSync` handles as-is. No issue expected.
- Mitigation: no special handling required; standard Node path handling suffices.

**State Corruption: env var points at a file, not a directory**
- Assumption: user points env var at a directory.
- Betrayal: user sets env to `/tmp/config.json` (a file, not a dir).
- Consequence: `readdirSync(path-to-file)` throws `ENOTDIR`. Current `discoverBuiltinManifests` pattern doesn't guard against this (only checks `existsSync`). Without the guard, R8b surfaces this bug on LSP_MCP_MANIFESTS_DIR and also makes BUILTIN_DIR susceptible if it ever becomes a file.
- Mitigation: `statSync(dir).isDirectory()` check alongside `existsSync`; soft-skip with "is not a directory" if not. Applied inside shared `discoverFromJsonDir` helper → fixes both sources at once.

**Dependency Treachery: permission-denied on dir read**
- Assumption: server has read permission to any dir the user specifies.
- Betrayal: user points to a root-owned or ACL-restricted dir; `readdirSync` throws `EACCES`.
- Consequence: uncaught exception propagates, server fails to start.
- Mitigation: wrap `readdirSync` in try/catch; log "could not read dir ... permission denied" and return `[]`. Applied to shared helper.

**Temporal Betrayal: dir modified during discovery**
- Assumption: files present at `readdirSync` time are still present at `readFileSync` time.
- Betrayal: user or tooling deletes/renames a file between the two calls (very narrow window).
- Consequence: `readFileSync` throws `ENOENT`; current per-file try/catch catches JSON.parse errors but the read itself can also fail.
- Mitigation: The existing per-file try/catch in `discoverFromJsonDir` wraps `JSON.parse(readFileSync(...))` — `readFileSync` errors propagate out of the try block as well, since `readFileSync` is inside `try`. Actually, re-verify: the current pattern is `try { raw = JSON.parse(readFileSync(full, 'utf-8')) }` — yes, `readFileSync` errors are caught by the same block. Soft-skip applies uniformly.

## Dependencies

- **Blocks:** `lspm-cnq` (parent-of edge; sub-epic)
- **Blocked by:** none — `lspm-h1n` closed
- **Unlocks:** R8c (`lspm-mcp`) — closes sub-epic SC "Layered manifest discovery" bullet

## Log
- [2026-04-18T09:51:55Z] [Seth] Scoped via writing-plans (2026-04-18) during lspm-h1n close-out. Single cohesion seam: add 4th pipeline source (LSP_MCP_MANIFESTS_DIR env var → dir-of-JSONs) + extract shared dir-loader helper from existing built-in loader. Codebase-verified starting state: discover.ts 133 lines w/ 6 exports from R8a; index.ts reads 3 env vars (R8b extends to 4); discover.test.ts has 16 tests + reusable fixture helpers. Design picks up R8a's locked dir-absent policy (soft-skip) for manifests-dir, and leverages Map-insertion-order invariant for slot preservation across chained overrides (builtin→config-file→manifests-dir). Incidental latent-bug fix: statSync.isDirectory + permission-denied guards added to shared helper, benefiting built-in loader too. Ready for fresh-session SRE.
