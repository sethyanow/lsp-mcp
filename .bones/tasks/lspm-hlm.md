---
id: lspm-hlm
title: R5 — PATH probe at startup; status field on ManifestEntry
status: closed
type: task
priority: 1
owner: Seth
parent: lspm-cnq
---







## Context

Advances sub-epic `lspm-cnq` SC: *"PATH probe at startup sets `status: 'ok' | 'binary_not_found'` per manifest; only `ok` manifests join the routing map; all are visible to `list_languages`."*

R4 landed multi-candidate routing (`lspm-z4z`); R8 (a/b/c) landed layered discovery. The router now ingests every discovered manifest into `_langMap` unconditionally. R5 adds the PATH-awareness gate: every manifest is probed for `cmd[0]` resolvability at startup; only probe-ok manifests contribute to routing; all manifests (including `binary_not_found`) remain enumerable for the future `list_languages` MCP tool (R6, separate task).

R5 does NOT ship `list_languages` — that's R6. R5 sets up the status field the tool will surface.

## Starting state (verified on branch `dev`, post-`lspm-mcp`)

- `src/router.ts` (485 lines) exports `ManifestEntry { manifest, server, sourceKind }` (3 fields) + `Router`. Router's `constructor(entries: ManifestEntry[])` builds `_entries` (deduped), `_byName`, and `_langMap` — unconditionally routing every entry. `entries` getter returns `_entries`; no status-aware accessor exists.
- `src/index.ts` (118 lines) builds `entries` inline: `discovered.map(d => ({manifest, server: new LspServer(...), sourceKind: d.sourceKind}))` then `new Router(entries)`. No probe step.
- `src/lsp-server.ts` already imports `spawn, spawnSync`. `LspServer` spawn is lazy (`ensureRunning`) — unspawned instances are cheap. Shutdown on an unspawned server is a no-op (`_process` is null).
- `src/tests/router.test.ts` (852 lines) builds fixtures via `entriesFrom(servers: LspServer[])` which emits `{manifest, server, sourceKind: 'config-file'}`. Adding `status` to ManifestEntry requires updating this helper (default `'ok'`).
- `mcp-server.ts` has zero direct references to `ManifestEntry` or `sourceKind` — it consumes `Router` only. ManifestEntry extension is internal to router + index + tests.
- Test baseline: 164 green across 6 suites (post-R8c).
- `package.json`: no `which` dep. Zero-dep PATH probe via `fs.accessSync` + `path.delimiter` + `PATHEXT` is preferred.

## Requirements

Advances sub-epic `lspm-cnq` SC "PATH probe at startup …" — R5 closes this bullet.

Does NOT advance: `list_languages` (separate — R6), `set_primary` (separate — R7), dynamic tool schemas (separate — R7b). The status field shipped here unblocks those tasks.

## Design

### New file: `src/probe.ts`

Zero-dep cross-platform PATH probe.

```ts
export type ProbeStatus = 'ok' | 'binary_not_found';

/**
 * Resolve `cmd` against PATH. Returns 'ok' if a matching executable exists,
 * 'binary_not_found' otherwise. Absolute paths are checked directly.
 * Cross-platform: PATHEXT on Windows supplies .EXE / .CMD / .BAT / .COM
 * extensions; POSIX tests the bare name.
 */
export function probeBinaryOnPath(cmd: string): ProbeStatus;
```

Implementation sketch:
- **Entry guard:** `if (!cmd) return 'binary_not_found';` — prevents empty-string fallthrough into bare-name branch.
- `path.isAbsolute(cmd)` → `accessSync(cmd, constants.X_OK)` with try/catch; on success, verify `statSync(cmd).isFile()` (see "File-not-directory gate" below). `ok` if both pass, `binary_not_found` on any throw or non-file.
- Bare name:
  - Split `process.env.PATH ?? ''` on `path.delimiter`. Filter empty segments.
  - Windows: split `process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM'` on `';'`. POSIX: extensions = `['']`.
  - For each (dir, ext), `accessSync(path.join(dir, cmd + ext), constants.X_OK)` + `statSync(...).isFile()`; first combined success → `'ok'`.
  - Exhaust all candidates → `'binary_not_found'`.

**File-not-directory gate.** On POSIX, `accessSync(path, X_OK)` returns true for directories (the X bit on a dir means "traversable"). On Windows, Node maps `X_OK` to `R_OK`, which any readable directory satisfies. Without a `statSync(path).isFile()` check, `probeBinaryOnPath('/tmp')` returns `'ok'` — wrong. The gate is a second syscall per probe; acceptable cost. Wrap `statSync` in its own try/catch so race-condition unlinks between `accessSync` and `statSync` report as `binary_not_found`.

**Anti-pattern to avoid:** spawning the binary (e.g., `spawnSync(cmd, ['--version'])`). Some LSPs don't support `--version` or hang; pure filesystem probe is cheaper and has no correctness risk.

### `ManifestEntry` extension

`src/router.ts`:

```ts
export interface ManifestEntry {
    manifest: PluginManifest;
    server: LspServer;
    sourceKind: SourceKind;
    status: ProbeStatus;  // NEW — R5
}
```

Import `ProbeStatus` from `./probe.js`. Callers (index.ts, tests) MUST set this field — no default. Test helper `entriesFrom` in `router.test.ts` gets `status: 'ok' as const` appended.

### `Router` status-aware behavior

`_byName` (all entries) and `_entries` (all entries) remain unfiltered — `list_languages` needs enumeration. Only `_langMap` is filtered:

```ts
private static _buildLangMap(entries: ManifestEntry[]): Map<...> {
    const map = new Map<...>();
    for (const entry of entries) {
        if (entry.status !== 'ok') continue;   // NEW — filter here
        for (const langId of entry.manifest.langIds) { ... }
    }
    return map;
}
```

`via: "<missing-binary-manifest>"` routing: currently `_requireByName` throws on unknown name. When the name resolves but `status === 'binary_not_found'`, throw a distinct informative error:

```ts
private _requireByName(name: string): ManifestEntry {
    const entry = this._byName.get(name);
    if (!entry) throw new Error(`No manifest named "${name}"`);
    if (entry.status !== 'ok') {
        throw new Error(
            `Manifest "${name}" is ${entry.status} — binary not found on PATH`
        );
    }
    return entry;
}
```

`symbol_search` fan-out via `_selectSymbolSearchTargets`: filter `binary_not_found` from explicit-`manifests` mode with a stderr notice (analogous to "no manifest named X"). Default-primaries mode already excludes them because `_langMap` only holds ok entries.

### `src/index.ts` wiring

Before constructing `ManifestEntry`, probe each discovered manifest's `cmd[0]`:

```ts
const entries: ManifestEntry[] = discovered.map((d) => ({
    manifest: d.manifest,
    server: new LspServer(d.manifest, workspaceRoot, pluginsDir),
    sourceKind: d.sourceKind,
    status: probeBinaryOnPath(d.manifest.server.cmd[0]),
}));
```

Observability — extend the existing "loaded N manifests" line with a missing-binary summary:

```
[lsp-mcp] loaded 13 manifests (builtin: 12, plugin-tree: 1)
[lsp-mcp] 3 manifests have binary_not_found: clangd, rust-analyzer, typescript-language-server
```

The second line only emits when ≥1 manifest is `binary_not_found`. Ordering: alphabetical by manifest name for determinism.

**Singular vs plural.** When exactly one manifest is missing, use the singular form:

```
[lsp-mcp] 1 manifest has binary_not_found: rust-analyzer
```

Agree the exact pluralization in the implementation: `count === 1 ? 'manifest has' : 'manifests have'`. Adversarial tests must cover both the singular and plural forms.

### Test helper update

`src/tests/router.test.ts` `entriesFrom`:

```ts
function entriesFrom(servers: LspServer[]): ManifestEntry[] {
    return servers.map((s) => ({
        manifest: s.manifest,
        server: s,
        sourceKind: 'config-file' as const,
        status: 'ok' as const,   // NEW — default for all existing fixtures
    }));
}
```

Existing 164 tests keep passing because default is `'ok'`. New R5 tests explicitly override.

Same update in `src/tests/mcp-server.test.ts` and `src/tests/e2e.test.ts` where they build ManifestEntry fixtures — verify their helpers and append `status: 'ok' as const` to each.

## Implementation

### Step 1 — RED: `probeBinaryOnPath` absolute-path test

Create `src/tests/probe.test.ts`. First test: `probeBinaryOnPath('/nonexistent-lsp-mcp-probe-${Date.now()}')` returns `'binary_not_found'`; `probeBinaryOnPath('/bin/sh')` returns `'ok'` (POSIX) or platform-equivalent.

Guard the POSIX-only assertion with `if (process.platform === 'win32') return;` — or use `process.execPath` (the running Node binary) as the known-exists absolute path, which works cross-platform.

Run `bun run test -- --testPathPattern=probe` → expect TS2307 "Cannot find module '../probe'" or TS2305.

### Step 2 — GREEN: create `src/probe.ts` with `probeBinaryOnPath`

Export `ProbeStatus` type + `probeBinaryOnPath` per the design sketch. Use `accessSync(path, constants.X_OK)` with per-branch try/catch. Handle empty `PATH` env var (return `binary_not_found` for bare names when no PATH).

Run → Step 1 passes. REFACTOR-assess.

### Step 3 — RED: `probeBinaryOnPath` PATH-resolved test

Extend `probe.test.ts`. Bare-name test: `probeBinaryOnPath('sh')` returns `'ok'` on POSIX (sh is always on PATH); `probeBinaryOnPath('zzz-nope-${Date.now()}')` returns `'binary_not_found'`. Windows: `probeBinaryOnPath('cmd')` with PATHEXT.

Consider: platform-guard or use a binary known to exist on both platforms (e.g., `node` — since we're running under Node, it's reachable). Simpler: test bare `node` because Node is definitely on PATH or at `process.execPath`.

Actually use a safer pattern — construct a fixture binary:

```ts
const fixtureDir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-probe-'));
const fake = path.join(fixtureDir, 'fake-lsp');
writeFileSync(fake, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
const origPath = process.env.PATH;
process.env.PATH = fixtureDir + path.delimiter + (origPath ?? '');
try {
    expect(probeBinaryOnPath('fake-lsp')).toBe('ok');
    expect(probeBinaryOnPath('does-not-exist')).toBe('binary_not_found');
} finally {
    process.env.PATH = origPath;
    rmSync(fixtureDir, { recursive: true, force: true });
}
```

This is platform-portable (the fixture dir has mode 755 on POSIX; on Windows `accessSync(..., X_OK)` reduces to readability). Windows-specific PATHEXT case: write `fake-lsp.cmd` containing `@echo off` and probe `fake-lsp` without extension → expect `'ok'`. Guard that case behind `if (process.platform === 'win32')`.

Run → expect RED.

### Step 4 — GREEN: implement PATH-walk + PATHEXT

Flesh out `probeBinaryOnPath` body. Handle: empty PATH (return binary_not_found), extensions array selection, loop through (dir, ext) combos. Per adversarial: return first match; don't over-walk.

Run → Step 3 passes + existing Step 1 still green. REFACTOR-assess.

### Step 5 — RED: Router test — `_langMap` excludes `binary_not_found` entries

Extend `router.test.ts`. First import adjustment: update `entriesFrom` helper to include `status: 'ok' as const` (DOES NOT break existing tests — they still get 'ok' by default).

Add `describe('Router — PATH probe integration')`:
```ts
it('entries with status=binary_not_found are retained in _entries but excluded from routing', () => {
    const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'ok-lsp' });
    const missingServer = makeMockServer(['rust'], ['**/*.rs'], { name: 'missing-lsp' });
    const router = new Router([
        { manifest: okServer.manifest, server: okServer, sourceKind: 'config-file', status: 'ok' },
        { manifest: missingServer.manifest, server: missingServer, sourceKind: 'config-file', status: 'binary_not_found' },
    ]);

    expect(router.entries).toHaveLength(2);
    expect(router.entry('missing-lsp')).toBeDefined();
    expect(router.primaryForLang('python')?.manifest.name).toBe('ok-lsp');
    expect(router.primaryForLang('rust')).toBeUndefined();
});
```

Run → expect FAIL because Router doesn't filter yet (primaryForLang('rust') returns the missing-lsp entry).

### Step 6 — GREEN: filter `_buildLangMap`

Add `if (entry.status !== 'ok') continue;` at the start of the loop body in `Router._buildLangMap`. Run → Step 5 passes.

REFACTOR-assess: is the filter coherent with other Router methods? Check `_selectSymbolSearchTargets` — default-primaries mode reads `_langMap`, so it's already filtered. Explicit-manifests mode reads `_byName` and may resolve a `binary_not_found` entry → those should be skipped with stderr. Add to Step 7.

### Step 7 — RED: symbol_search in explicit-manifests mode skips binary_not_found + stderr

Extend router.test.ts. New test: request `symbolSearch('foo', undefined, ['missing-lsp'])` with `missing-lsp` having `status: 'binary_not_found'`. Expect `[]` + stderr matching `/symbol_search.*"missing-lsp".*binary_not_found/i`.

Run → expect FAIL (router currently calls `missingServer.workspaceSymbol` regardless of status).

### Step 8 — GREEN: status gate in `_selectSymbolSearchTargets`

In the explicit-manifests branch, after `const entry = this._byName.get(name)`, add:
```ts
if (entry && entry.status !== 'ok') {
    process.stderr.write(
        `[lsp-mcp] symbol_search: "${name}" is ${entry.status} — skipping\n`
    );
    continue;
}
```

Run → Step 7 passes. REFACTOR-assess.

### Step 9 — RED: `via: "<binary_not_found-name>"` throws informative error

Extend router.test.ts. New test: `router.definitions(fileUri, pos, 'missing-lsp')` throws `/Manifest "missing-lsp".* binary_not_found/`. Same pattern for `references`, `hover`, `symbolSearch` via explicit manifest.

Actually `symbolSearch` doesn't throw — it soft-skips with stderr (Step 7+8). Distinguish: positional `via` parameter throws; `symbol_search manifests: []` soft-skips. Matches prior decision shape.

Run → expect FAIL.

### Step 10 — GREEN: status check in `_requireByName`

Add status check per design sketch. Run → Step 9 passes. Verify other via-using tests still green.

REFACTOR-assess: `_requireByName` now has two error classes (unknown name, status not ok). Error messages distinct. Consider extracting to a named helper — likely skip; two branches is fine inline.

### Step 11 — RED: index.ts integration — probe each manifest, set status

Add test to `src/tests/e2e.test.ts` or a new integration-flavored test in `discover.test.ts` that exercises the `main()`-style flow. Since `main()` is hard to test directly, test via a probe-aware constructor helper or by extracting the probe+entry-build logic to a small helper in index.ts and unit-testing that.

Preferred approach: extract a pure function `attachProbeStatus(discovered: DiscoveredManifest[]): (DiscoveredManifest & { status })[]` in `src/index.ts` or in `src/probe.ts`:

```ts
export function probeAll(discovered: DiscoveredManifest[]): Array<DiscoveredManifest & { status: ProbeStatus }>;
```

Test it with fixtures containing known-existing and known-missing `cmd[0]` values. Stderr includes missing-list line.

Run → expect TS2305 (export missing) or failure.

### Step 12 — GREEN: implement `probeAll` + wire into main()

In `probe.ts`: `probeAll(discovered)` maps each `d` → `{...d, status: probeBinaryOnPath(d.manifest.server.cmd[0])}`.

In `index.ts`: replace the inline `.map` that constructs `ManifestEntry` with:
1. `const probed = probeAll(discovered);`
2. Observability — after the existing "loaded N manifests" line, compute missing names from `probed.filter(p => p.status === 'binary_not_found')`. If non-empty, emit the summary line with alphabetically-sorted manifest names. Pluralize: `count === 1 ? 'manifest has' : 'manifests have'`.
3. `const entries = probed.map(p => ({manifest: p.manifest, server: new LspServer(...), sourceKind: p.sourceKind, status: p.status}))`.

Run → Step 11 passes + all prior tests still green.

REFACTOR-assess: the entry-construction lambda is getting longer. Extract helper? Likely fine inline.

### Step 12b — Update mcp-server.test.ts and e2e.test.ts fixtures

If those tests build `ManifestEntry[]` directly, append `status: 'ok' as const`. Verify via a test run; add the field where TS2322 fires. Use test-run-driven discovery to find all fixture sites.

### Step 13 — Smoke test

Write `/tmp/lspm-hlm-smoke.sh` following the R8c pattern: build `dist/index.js`, then:

- Smoke 1: stock LSP_MCP_CONFIG=/nonexistent launch → stderr shows `loaded 12 manifests` (built-ins only). Count `binary_not_found` entries: typically 10-11 (varies by box). Assert the stderr shape — `grep -q 'have binary_not_found:'` — rather than exact count.
- Smoke 2: construct a config-file with a guaranteed-present binary (e.g., `/bin/sh` on POSIX, `node` on all). Launch; assert that binary is NOT in the binary_not_found list.

Record stderr in `bn log lspm-hlm`.

### Step 14 — Adversarial battery (probe.test.ts + router.test.ts)

Adversarial patterns:
- **Empty PATH**: `process.env.PATH = ''`; `probeBinaryOnPath('anything')` → `'binary_not_found'`.
- **PATH with trailing delimiter**: `'/usr/bin:'` (POSIX) / `'C:\\Windows;'` (Win) — empty segment filtered, no crash.
- **Absolute path that's a directory**: `probeBinaryOnPath('/tmp')` → `'binary_not_found'`. Fails without the `statSync.isFile()` gate because `X_OK` on POSIX directories and the `R_OK`-aliased `X_OK` on Windows both return true for dirs.
- **Absolute path that's a non-executable file**: `writeFileSync(..., { mode: 0o644 })` → `'binary_not_found'` on POSIX (accessSync X_OK fails); behavior on Windows may differ (R_OK=X_OK) — guard or document.
- **Empty string cmd**: `probeBinaryOnPath('')` → `'binary_not_found'`. Entry guard short-circuits before branching.
- **Bare-name hit that is a directory**: construct a fixture dir, create a subdir `fake-lsp/` (not a file) inside, prepend the fixture dir to `PATH`, probe `fake-lsp` → `'binary_not_found'`. Validates the `statSync.isFile()` gate in the PATH-walk branch.
- **Command with embedded path separator** (e.g., `./rel/path`): `path.isAbsolute` returns false, but the command isn't a bare name either. Lock in behavior with a test: `probeBinaryOnPath('./nonexistent-relative-path')` returns `'binary_not_found'`. Documented: the probe does not resolve relative to CWD or workspace; relative paths go through PATH-lookup and miss. Acceptable.
- **Router with all manifests binary_not_found**: `_langMap` empty; `primaryForLang('python')` returns undefined; `symbol_search` returns `[]`; no crash.
- **Router with status change between builds**: verify that constructing a new Router with updated statuses produces a new `_langMap`. (Not a state change within one Router instance — R7 `set_primary` handles that; R5 is construct-only.)
- **Observability pluralization**: index.ts emission with `count === 1` → `"1 manifest has binary_not_found:"`; `count > 1` → `"N manifests have binary_not_found:"`. Test both branches with injected probed-lists.

Each adversarial: RED → verify expected failure → GREEN → Three-Question Framework per stress-test skill.

### Step 15 — Full verification

```bash
bun run test > /tmp/lspm-hlm-test.log 2>&1 && tail -15 /tmp/lspm-hlm-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 164 baseline + ~12 new (probe unit + router integration + adversarial) = ~176 green. Typecheck clean. Build bundles cleanly.

### Step 16 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "PATH probe at startup sets `status: 'ok' | 'binary_not_found'` per manifest; only `ok` manifests join the routing map; all are visible to `list_languages`." from `[ ]` to `[x]`.
- Do NOT flip `list_languages` SC (that's R6) or `bun run test` comprehensive SC (that requires all R5-R7 done).

### Step 17 — Commit + push

```bash
git add src/probe.ts src/router.ts src/index.ts src/tests/*.ts dist/index.js dist/index.js.map .bones/
git commit -m "lspm-hlm: R5 PATH probe at startup — closes lspm-cnq PATH-probe SC"
git push
```

Commit body enumerates: new `src/probe.ts`, `ProbeStatus` type, `probeBinaryOnPath`, `probeAll`, `ManifestEntry.status` field, Router filter + via-error-on-missing, index.ts wiring + observability line, test-fixture helper updates.

## Success Criteria

- [x] `src/probe.ts` exists; exports `ProbeStatus` type (`'ok' | 'binary_not_found'`) and `probeBinaryOnPath(cmd: string): ProbeStatus`
- [x] `probeBinaryOnPath` handles: empty `cmd` string (entry guard → `binary_not_found`), absolute paths (accessSync X_OK + `statSync.isFile()` gate), bare names via PATH walk (with same isFile gate), Windows PATHEXT (`.EXE .CMD .BAT .COM` defaults), empty `PATH` env var (returns `binary_not_found`)
- [x] No process spawn in probe — pure filesystem check
- [x] `src/probe.ts` exports `probeAll(discovered: DiscoveredManifest[]): Array<DiscoveredManifest & { status: ProbeStatus }>`
- [x] `ManifestEntry` interface in `src/router.ts` has `status: ProbeStatus` field; all callers (index.ts, router.test.ts, mcp-server.test.ts, e2e.test.ts) updated
- [x] `Router._buildLangMap` filters `status !== 'ok'` entries — they don't contribute to routing
- [x] `Router.entries` and `Router.entry(name)` still return/include `binary_not_found` entries (for future `list_languages`)
- [x] `Router._requireByName` throws distinct error when resolved entry has `status !== 'ok'` — message contains the status value
- [x] `Router._selectSymbolSearchTargets` in explicit-`manifests` mode skips `binary_not_found` with stderr notice
- [x] `src/index.ts` probes each discovered manifest's `cmd[0]` before constructing `ManifestEntry[]`
- [x] Observability line: when ≥1 manifest is `binary_not_found`, stderr emits `[lsp-mcp] N manifests have binary_not_found: <alphabetical-names>` (sorted); singular form `1 manifest has binary_not_found:` when `count === 1`
- [x] Test-fixture helpers (`entriesFrom` in router.test.ts + equivalents in mcp-server.test.ts, e2e.test.ts) updated with `status: 'ok' as const`
- [x] 164 baseline tests stay green; new probe unit tests + router integration tests + adversarial cases land (~16 new, target ~180 total)
- [x] Adversarial battery covers: empty PATH, PATH with trailing/empty delimiter segment, absolute dir (not file) — asserts `statSync.isFile()` gate works, non-executable absolute file (POSIX), all-manifests-binary_not_found router, bare-name PATH miss, relative-path `cmd[0]` (`./rel/path` → `binary_not_found`), observability pluralization (singular + plural), empty-string cmd (entry guard), bare-name PATH hit pointing at a same-named subdirectory (`statSync.isFile()` gate applies in PATH-walk branch too)
- [x] Smoke test records real-box probe output (how many of the 12 built-ins are `ok` vs `binary_not_found`) in `bn log lspm-hlm`
- [x] `bun run test` green; `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`
- [x] Sub-epic `lspm-cnq` SC "PATH probe at startup ..." flipped `[ ]` → `[x]`
- [x] Single commit on `dev`, pushed via bare `git push`. Commit notes R5 complete, R6/R7/R7b still open

## Anti-Patterns

- **NO spawning the binary to probe it.** `spawnSync(cmd, ['--version'])` risks hang on LSPs that don't implement `--version` gracefully and costs actual process startup. Filesystem probe is sufficient.
- **NO `which` npm dependency.** `fs.accessSync` + `path.delimiter` + `PATHEXT` is enough. Adding a dep for 20 lines of cross-platform logic is scope creep.
- **NO filtering `_entries` or `_byName`.** Only `_langMap` filters. `list_languages` (R6) needs to enumerate every manifest including missing-binary ones — dropping them from `_entries` breaks that contract.
- **NO silent drop of `binary_not_found` from stderr.** The startup log MUST list missing-binary names so users can see why their LSP isn't routing. Silent exclusion = user confusion when `list_languages` lands in R6.
- **NO probe-once-at-import-time.** Probe runs per `main()` invocation, reading current env. Different CC sessions may have different PATHs; don't cache at module load.
- **NO breaking existing router tests.** `entriesFrom` helper defaults to `status: 'ok'` so the 164 baseline stays green. Explicit `binary_not_found` only in R5-specific tests.
- **NO changing `ManifestEntry` shape without updating test helpers.** Fixture construction sites must stay in sync — propagate the field addition to every fixture builder in one commit, not piecemeal.
- **NO coupling probe to LspServer.** The probe is pre-spawn; it must not depend on LspServer state. `probeBinaryOnPath` takes a bare string, not a manifest or server.
- **NO Windows path assumptions.** Use `path.delimiter` (`;` on Win, `:` elsewhere) and `path.join` — never hardcode separators.

## Key Considerations

- **PATH probe is not a readiness check.** It verifies the file exists on PATH; it does NOT verify the LSP actually works. An ok probe + broken LSP still routes and fails at request time. Intentional — probe is a coarse filter, not validation.
- **Status is immutable for a given Router.** R5 sets status at construction. If the user installs a missing LSP mid-session, they restart the server to re-probe. R7 `set_primary` changes routing among ok candidates — it does not re-probe.
- **Windows `accessSync(file, X_OK)` is effectively `R_OK`.** Windows doesn't have Unix exec bits; Node maps X_OK → R_OK. Test assertions on "non-executable file returns binary_not_found" are POSIX-only — guard with `if (process.platform === 'win32') return;`.
- **Windows PATHEXT defaults.** If `process.env.PATHEXT` is unset, use `'.EXE;.CMD;.BAT;.COM'`. Order matters per convention; iterate in declaration order.
- **Symlinks on PATH.** `accessSync` follows symlinks. Broken symlinks throw ENOENT — handled as `binary_not_found`. No special case needed.
- **`cmd[0]` can contain arguments via the full `cmd` array.** Only `cmd[0]` is the binary; `cmd[1..]` are arguments, irrelevant to probe. Pass only `cmd[0]` to `probeBinaryOnPath`.
- **Empty `cmd[]`.** Schema validation should prevent this (non-empty array required), but defensively: `probeBinaryOnPath(undefined as any)` returns `binary_not_found` (empty string doesn't resolve). Verify schema forbids empty cmd — if so, no defensive code needed.
- **Env PATH mutation during tests.** Tests that modify `process.env.PATH` MUST restore in `finally`; cross-test PATH pollution breaks unrelated tests. Use the pattern from Step 3.
- **Stderr spy in probe tests.** probe.test.ts doesn't need a stderr spy (the probe itself doesn't write stderr; index.ts does). Router tests that check via-missing error messages DO need stderr spies.

### Failure Catalog (adversarial planning)

**State Corruption: `probeBinaryOnPath` — directory passes X_OK**
- Assumption: `accessSync(path, X_OK)` succeeding implies `path` is an executable file.
- Betrayal: POSIX `X_OK` on a directory tests the traversal bit and returns true for any readable directory. Node on Windows maps `X_OK` to `R_OK`, which all readable directories satisfy.
- Consequence: `probeBinaryOnPath('/usr/local/bin')` returns `'ok'`. The bare-name branch hits the same issue when a PATH entry contains a same-named subdirectory (e.g., `/usr/local/bin/pyright/` as a dir). Router registers the entry as routable; spawn fails at request time with EACCES or similar; user sees runtime error instead of startup status.
- Mitigation: after `accessSync` success in both branches, gate on `statSync(path).isFile()`. Wrap `statSync` in its own try/catch so an unlink race between `accessSync` and `statSync` reports `'binary_not_found'`. Design section updated accordingly.

**Input Hostility: `probeBinaryOnPath` — empty string cmd**
- Assumption: `cmd` is a non-empty string (schema validates manifest `cmd: []` as at least one element).
- Betrayal: if schema changes or a caller dereferences `cmd[0]` when `cmd` is `[]`, the probe receives `''` or `undefined`. `path.isAbsolute('')` is `false` → bare-name branch → `path.join('/usr/bin', '')` = `/usr/bin` → directory → combined with the X_OK-on-dir bug above, returns `'ok'`.
- Consequence: empty cmd silently registers as a routable manifest.
- Mitigation: entry guard `if (!cmd) return 'binary_not_found';` at the top of `probeBinaryOnPath`. Even with the file-not-dir fix in place, the guard makes the intent explicit and avoids a full PATH walk for a garbage input. Adversarial test: `probeBinaryOnPath('')` returns `'binary_not_found'`.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R5 closes the "PATH probe" SC bullet)
- **Blocked by:** none — `lspm-mcp` (R8c) is closed; no other open deps
- **Unlocks:** R6 `list_languages` (needs status field to surface), R7 `set_primary` (needs ok-vs-missing distinction), R7b dynamic schemas (needs active-manifest enumeration)

## Log

- [2026-04-19T23:51:41Z] [Seth] SRE fresh-session review complete. Skeleton claims verified against codebase (router.ts=485 LOC, index.ts=118 LOC, router.test.ts=852 LOC, 164 baseline green across 6 suites, no 'which' dep, mcp-server/lsp-server free of ManifestEntry refs, entriesFrom helpers at router.test.ts:10, mcp-server.test.ts:11, e2e.test.ts:12, index.ts:83 inline entry construction, LspServer.shutdown null-safe via _connection guard, DiscoveredManifest at discover.ts:9-13 with optional sourcePath). Added to skeleton: (1) singular/plural handling for observability stderr line (1 manifest has vs N manifests have); (2) explicit adversarial test locking relative-path cmd[0] behavior (./rel/path -> binary_not_found, not CWD-resolved); (3) updated SC test-count estimate 12->14 and adversarial coverage bullet to include relative-path and pluralization cases. No design changes — skeleton's probe approach (fs.accessSync + PATHEXT, no spawn, no which dep) is sound.
- [2026-04-19T23:55:16Z] [Seth] Adversarial planning complete. Two failure-catalog findings added to Key Considerations: (1) HIGH — absolute-path X_OK passes for directories on both POSIX (traversal bit) and Windows (R_OK alias); skeleton's Step 14 asserts probeBinaryOnPath('/tmp') -> binary_not_found but Design sketch wouldn't implement that behavior. Mitigation: statSync(path).isFile() gate after accessSync in BOTH branches, wrapped in own try/catch for unlink-race safety. (2) MEDIUM — empty-string cmd passes through to bare-name branch, joins '' with each PATH dir producing directory paths, combined with #1 returns 'ok'. Mitigation: entry guard 'if (!cmd) return binary_not_found'. Design section updated; SCs updated to require isFile gate + entry guard; Step 14 adversarial extended with empty-string + bare-name-dir-hit cases; total-test estimate bumped 14->16 new.
- [2026-04-20T00:07:50Z] [Seth] Smoke test on real dev box (macOS/darwin):
Smoke 1 (stock, LSP_MCP_CONFIG=/nonexistent): '[lsp-mcp] loaded 12 manifests (builtin: 12)' followed by '[lsp-mcp] 5 manifests have binary_not_found: bash-language-server, bazel-lsp, elixir-ls, lua-language-server, starpls' — 7 of 12 builtins resolve on PATH (pyright, typescript-language-server, gopls, rust-analyzer, zls, clangd, svelte-language-server). Plural form correct (count=5). Alphabetical order correct (b, b, e, l, s).
Smoke 2 (array-top-level config file with cmd=node): '[lsp-mcp] loaded 13 manifests (builtin: 12, config-file: 1)' same 5-missing list — 'smoke-node' is NOT listed, confirming 'node' probed as ok. layered-discovery count mixing works.
Config-file schema note: top-level must be JSON array, not {plugins: [...]}.
