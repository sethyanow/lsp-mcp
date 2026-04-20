---
id: lspm-zw9
title: R7 — set_primary MCP tool
status: open
type: task
priority: 1
parent: lspm-cnq
---

## Context

Advances sub-epic `lspm-cnq` SC: *"`set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart."*

R6 (`lspm-rot`) shipped `Router.listLanguages()` + `list_languages` MCP tool — the *query* surface. R7 is the *mutation* surface: flip which candidate manifest is primary for a given lang, at runtime, without server restart. Change is in-memory only; resets to first-registered on restart (epic contract — no persistence in Phase 1).

R7 is the first mutating MCP tool in the router. Every prior tool (`symbol_search`, `defs`, `refs`, `list_languages`, etc.) is a pure query. The Router's `_langMap` slot shape is already `{ candidates: ManifestEntry[]; primary: string }` — the `primary` field is a mutable string within an otherwise-immutable Map. R7 mutates that one field and leaves everything else untouched.

This task does NOT ship:
- R7b dynamic tool-schema enums (separate task) — per epic Key Consideration: "`set_primary` changes the default primary, not enum values — schema stays valid." No schema regen needed.
- R9 `using-lsp-mcp` skill.
- Fresh-CC-session demo (lives in Phase 1 acceptance task; that demo uses `set_primary` on bazel `starpls` ↔ `bazel-lsp` swap as its showcase).
- Persistence to a config file (explicitly out per parent epic R6: "Change is in-memory only; resets to config default on restart").

## Starting state (verified on branch `dev`, post-`lspm-rot` commit c8e6028)

- `src/router.ts` (553 LOC) exports `Router` with private `_langMap: Map<string, { candidates: ManifestEntry[]; primary: string }>` built once in `_buildLangMap`. The `primary` field is a string (manifest name) that no existing code path mutates — R7 will be the first writer.
- Router public surface: `entries`, `entry(name)`, `primaryForLang(langId)`, `candidatesForLang(langId)`, `listLanguages()`, `primaryForFile`, fan-out ops (`symbolSearch`, `definitions`, `references`, `implementations`, `hover`, …). No existing mutator.
- `src/mcp-server.ts` (376 LOC) registers all tools via `server.registerTool(name, {description, inputSchema}, handler)`. Every handler follows the `try { return jsonResult(...) } catch (err) { return toolError(name, err) }` pattern. All existing tools are pure queries — R7 is the first mutation.
- `list_languages` tool registration sits between `symbol_search` and `defs` in `mcp-server.ts`. R7's `set_primary` belongs adjacent to `list_languages` (both operate on the routing map) — register directly after `list_languages`.
- `src/tests/router.test.ts` has `Router — listLanguages` describe (13 tests) as a pattern for shape-based tests. R7 tests join a new `Router — setPrimary` describe following the same fixture conventions (`makeMockServer`, `entriesFrom`, raw `ManifestEntry` literals when `status:'binary_not_found'` needed).
- `src/tests/mcp-server.test.ts` has `list_languages tool` describe (3 tests) as the MCP-integration pattern for new tools.
- `_requireByName(name, {context})` (private Router method, introduced by R5 `lspm-hlm`) already throws `"Manifest X is binary_not_found — binary not found on PATH"` for missing-binary access. Reuse the phrasing for R7's manifest-status validation to keep a consistent error surface.
- Test baseline (post R6 close): 202 green across 7 suites.

## Design

### New `Router.setPrimary(lang, manifestName)` method

`src/router.ts` grows one public method:

```ts
/**
 * Swap which candidate manifest is primary for a langId.
 * Mutates `_langMap[lang].primary` in-memory. Throws on:
 *   - unknown manifest name
 *   - unknown langId (no slot in _langMap)
 *   - manifest is not a candidate for this lang
 *   - manifest is binary_not_found on PATH (can't be primary for routing
 *     that would then fail every downstream call)
 * Returns the previous primary name so the caller can echo it.
 */
setPrimary(lang: string, manifestName: string): { lang: string; primary: string; previous: string };
```

Validation order (fail fast, clearest error first):
1. `this._byName.get(manifestName)` — unknown manifest → throw `"Unknown manifest: <name>. Known: <list>"` (mirror `_requireByName` pattern).
2. `this._langMap.get(lang)` — unknown lang → throw `"Unknown lang: <lang>. Known: <list of active langs>"`.
3. `slot.candidates.some((c) => c.manifest.name === manifestName)` — manifest exists but not a candidate for this lang → throw `"Manifest <name> is not a candidate for lang '<lang>'. Candidates: <names>"`.
4. `entry.status === 'ok'` — manifest exists and is a candidate but binary_not_found → throw using the same phrasing as R5's `_requireByName` error.

If validation passes:
- Capture `previous = slot.primary`.
- If `previous === manifestName` — no-op. Return `{lang, primary: manifestName, previous}` without writing. Idempotent by design.
- Else: `slot.primary = manifestName`. Log to stderr: `[lsp-mcp] set_primary: <lang> <previous> → <manifestName>`.
- Return `{lang, primary: manifestName, previous}`.

### Design invariants (what the implementation must preserve)

- **NO new Map allocation.** Mutating `slot.primary` in place is O(1). Rebuilding `_langMap` would be O(N×M) and would reorder internals (breaks determinism, which listLanguages + primaryForFile both depend on).
- **NO persistence.** This is runtime state only. No file write, no config update. Restart reverts to `_buildLangMap`'s first-registered winner. Parent epic R6 contract: "Change is in-memory only; resets to config default on restart."
- **NO promoting a `binary_not_found` manifest.** `list_languages` reports primary status, and routing consults `_langMap.primary`. If primary points at a missing binary, routing would skip it (per R5 `_selectSymbolSearchTargets` soft-skip) — agents would see `primary:true` but queries mysteriously return empty. Refuse the mutation to keep the invariant that primary is always dispatchable.
- **NO return of internal objects.** The return shape is `{lang, primary, previous}` — all strings. No `ManifestEntry`, no `LspServer`, no `Map` references. Keeps the MCP response pure JSON and the Router's internals private.
- **NO firing on `candidatesForLang(lang).length === 1`.** Single-candidate langs still accept `set_primary(lang, theOnlyCandidate)` — idempotent no-op. Don't special-case and refuse ("already primary"); treat it the same as the no-op branch. Reduces agent cognitive load.

### New MCP tool: `set_primary`

`src/mcp-server.ts`: register adjacent to `list_languages`.

```ts
server.registerTool(
    'set_primary',
    {
        description:
            'Swap which candidate manifest is primary for a given lang. Takes effect ' +
            'immediately for subsequent defs/refs/hover calls; no restart. Resets to ' +
            'first-registered on server restart (in-memory only, not persisted). Throws ' +
            'if the lang or manifest is unknown, if the manifest is not a candidate for ' +
            'the lang, or if the manifest is binary_not_found on PATH.',
        inputSchema: {
            lang: z.string().describe('langId whose primary to swap (e.g. "python", "bazel").'),
            manifest: z.string().describe('Name of the candidate manifest to promote to primary.'),
        },
    },
    async ({ lang, manifest }) => {
        try {
            return jsonResult(router.setPrimary(lang, manifest));
        } catch (err) {
            return toolError('set_primary', err);
        }
    }
);
```

R7b (dynamic schemas, separate task) will later upgrade `lang` → `z.enum(...)` and `manifest` → `z.enum(...)` with values derived from the active manifest set. Left as plain `z.string()` here.

## Implementation

### Step 1 — RED: happy-path setPrimary swap

Add to `src/tests/router.test.ts` a new describe `Router — setPrimary`. First test:

```ts
it('swaps primary for a lang and returns {lang, primary, previous}', () => { ... });
```

Fixture: two ok candidates for `python` (`pyright`, `pyright-fork`). Build router; assert `primaryForLang('python').manifest.name === 'pyright'` initially. Call `router.setPrimary('python', 'pyright-fork')`. Assert return value equals `{lang: 'python', primary: 'pyright-fork', previous: 'pyright'}`. Assert `primaryForLang('python').manifest.name === 'pyright-fork'` after.

Run `bun run test -- --testPathPattern=router` → expect TS2339 "Property 'setPrimary' does not exist on type 'Router'".

### Step 2 — GREEN: implement `setPrimary`

Add to `src/router.ts` (after `listLanguages`, before `primaryForFile`):
1. Method signature per Design.
2. Body: lookup manifest via `_byName`, lookup slot via `_langMap`, validate candidacy, validate `entry.status === 'ok'`, capture previous, mutate if different, log to stderr, return.

Run → Step 1 passes. REFACTOR-assess.

### Step 3 — RED: `listLanguages` reflects the swap (no caching)

Same describe. Test: before swap, `listLanguages()` returns `[{...pyright, primary: true}, {...pyright-fork, primary: false}]`. After `setPrimary('python', 'pyright-fork')`, `listLanguages()` returns `[{...pyright, primary: false}, {...pyright-fork, primary: true}]`. Row order preserved (still `_entries` order).

Likely GREEN on first run because `listLanguages` reads `_langMap.primary` at query time. Regression lock — guards against future caching.

### Step 4 — RED: idempotent no-op when new primary == current

Fixture: single candidate for `python` (`pyright`). Call `setPrimary('python', 'pyright')`. Assert return is `{lang: 'python', primary: 'pyright', previous: 'pyright'}`. Assert no stderr write (spy on `process.stderr.write` before call; assert `.mock.calls.length === 0`).

### Step 5 — RED: unknown manifest throws

Fixture: one candidate for `python`. Call `setPrimary('python', 'nonexistent-manifest')`. Expect throw matching `/Unknown manifest: nonexistent-manifest/`. Assert `primaryForLang('python')` unchanged.

### Step 6 — RED: unknown lang throws

Fixture: one ok manifest for `python`. Call `setPrimary('rust', 'pyright')`. Expect throw matching `/Unknown lang: rust/`. Assert `primaryForLang('python')` unchanged.

### Step 7 — RED: manifest not a candidate for lang throws

Fixture: `pyright` (python only) + `rust-analyzer` (rust only). Call `setPrimary('python', 'rust-analyzer')`. Expect throw matching `/not a candidate for lang 'python'/`. Assert `primaryForLang('python').manifest.name === 'pyright'` (unchanged).

### Step 8 — RED: binary_not_found manifest refused

Fixture: ok `pyright` + binary_not_found `pyright-missing` both for `python`. Call `setPrimary('python', 'pyright-missing')`. Expect throw matching `/binary_not_found/`. Assert primary unchanged.

### Step 9 — RED: stderr log on successful swap

Fixture: two ok candidates. Spy on `process.stderr.write`. Call swap. Assert one stderr call containing `set_primary: python pyright → pyright-fork`.

### Step 10 — REFACTOR-assess

Validate:
- Single mutation site in Router (`slot.primary = manifestName`). No duplicate `_langMap` writer.
- Error messages point at the user's action (show known alternatives where applicable).
- Return shape is pure strings (JSON-safe).

### Step 11 — RED: MCP tool registration + response shape

Add to `src/tests/mcp-server.test.ts` a new describe `set_primary tool`. Two tests:

**Test A — registration:**
```ts
it('is registered in the tool list', async () => { ... });
```
Fixture: one mock server. Assert `set_primary` in `client.listTools()` output.

**Test B — callTool returns `{lang, primary, previous}`:**
Fixture: two candidates for `python`. Call via MCP client. Assert:
- `result.isError` falsy.
- Parsed JSON payload equals `{lang: 'python', primary: 'pyright-fork', previous: 'pyright'}`.
- Follow-up `list_languages` call reflects new primary (round-trip: swap via MCP, observe via MCP).

Run → expect "Tool set_primary not found."

### Step 12 — GREEN: register `set_primary` in `createMcpServer`

Add `server.registerTool('set_primary', {...}, handler)` per Design sketch. Position directly after `list_languages`. Handler mirrors sibling pattern (`try/jsonResult/toolError`).

Run → Step 11 passes. REFACTOR-assess.

### Step 13 — RED: MCP error path — unknown manifest surfaces via `isError`

Fixture: one candidate for `python`. Call `set_primary` with `manifest: 'nonexistent'`. Assert `result.isError === true`. Assert error text includes `Unknown manifest`.

Same pattern for unknown-lang, not-a-candidate, binary_not_found. Can batch into one test with subtests or split — batch preferred to keep the suite compact. (The Router unit tests already exercise each validation branch; MCP layer only needs to confirm errors reach the client as `isError`.)

### Step 14 — Adversarial battery

Add to the `Router — setPrimary` describe:
- **Set primary on an empty router** (`new Router([])`): `setPrimary('python', 'anything')` throws `Unknown manifest` (no manifests at all — manifest check fails first per validation order).
- **Sequential swaps**: swap A → B → A. Final state equals initial. Each swap's return value shows correct `previous`.
- **Swap back to binary_not_found doesn't regress**: start with ok primary; try to swap to a missing-binary candidate (throws, no state change); verify primary unchanged after the failed attempt. State-corruption regression lock.
- **Swap observed across all readers**: after swap, `primaryForLang`, `listLanguages`, `candidatesForLang` (order unchanged — only primary flipped), and the fan-out target selection all reflect the new primary.
- **setPrimary does NOT spawn LSP processes** (failure catalog: Temporal Betrayal parallel to R6). Assert no mock `LspServer` method is invoked during setPrimary.

### Step 15 — Adversarial MCP: JSON round-trip on success + error

Add to `set_primary tool` describe:
- Success response JSON-round-trips without throwing (no circular refs; `previous`/`primary`/`lang` all strings).
- Error response payload survives `JSON.stringify`/`JSON.parse`.

### Step 16 — Smoke

Use existing generic harness:

```bash
node scripts/smoke-mcp-tool.mjs set_primary '{"lang": "python", "manifest": "pyright"}'
```

The harness's `list_languages`-specific display falls through to `JSON.stringify(payload, null, 2)` for non-list tools — expected output is the `{lang, primary, previous}` object. Record actual output in `bn log lspm-zw9`.

Also smoke an error path: `'{"lang": "nonexistent", "manifest": "pyright"}'` — expect `isError` with `Unknown lang` in message.

### Step 17 — Full verification

```bash
bun run test > /tmp/lspm-zw9-test.log 2>&1 && tail -15 /tmp/lspm-zw9-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect baseline 202 + ~15–18 new = ~217–220 green. Typecheck clean. Build succeeds.

### Step 18 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "`set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart." from `[ ]` to `[x]` with satisfaction note pointing at `lspm-zw9`.
- Do NOT flip R7b (dynamic schemas), R9 skill, or acceptance demo SCs.

### Step 19 — Commit + push

Stage `src/router.ts`, `src/mcp-server.ts`, `src/tests/router.test.ts`, `src/tests/mcp-server.test.ts`, `dist/index.js`, `dist/index.js.map`, `.bones/`. Commit message notes: `setPrimary` method + `set_primary` MCP tool + validation + stderr logging + adversarial battery + R7b/R9 still open. Push via bare `git push`.

## Success Criteria

- [ ] `Router.setPrimary(lang, manifestName): {lang, primary, previous}` implemented in `src/router.ts`
- [ ] Validation fails fast with specific errors: unknown manifest, unknown lang, not-a-candidate, binary_not_found (each with regression test)
- [ ] Successful swap mutates `_langMap[lang].primary` in place (no Map reallocation, no reordering of `_entries` or candidates)
- [ ] No-op when new primary equals current — returns `{lang, primary, previous}` where primary === previous, skips stderr log, no state change
- [ ] `listLanguages()` reflects the swap on next call (regression-tested — guards future caching)
- [ ] `primaryForLang(lang)` reflects the swap on next call
- [ ] `candidatesForLang(lang)` order is unchanged after a swap (only primary string flipped)
- [ ] Stderr log on successful swap: `[lsp-mcp] set_primary: <lang> <previous> → <new>` (suppressed on no-op)
- [ ] `binary_not_found` manifest cannot be promoted to primary (refused with informative error; primary unchanged)
- [ ] MCP tool `set_primary` registered in `src/mcp-server.ts` with `{lang: string, manifest: string}` input schema, try/jsonResult/toolError handler
- [ ] `set_primary` appears in `client.listTools()` output
- [ ] `client.callTool({name: 'set_primary', arguments: {lang, manifest}})` returns `{lang, primary, previous}` on success
- [ ] MCP error surface returns `isError: true` with error message for each of the 4 validation failures (unknown manifest, unknown lang, not-a-candidate, binary_not_found)
- [ ] `setPrimary` does NOT invoke any `LspServer` methods (spawn safety; parallel to R6)
- [ ] Sequential swap (A → B → A) restores initial state; each swap reports correct `previous`
- [ ] Failed swap (e.g., binary_not_found target) leaves primary unchanged — state-corruption regression lock
- [ ] Response payload JSON-round-trips through `JSON.stringify`/`JSON.parse` without throwing
- [ ] 202 baseline tests stay green; new tests land (~15–18 new; target ~217–220)
- [ ] Smoke: `node scripts/smoke-mcp-tool.mjs set_primary '{"lang":"...","manifest":"..."}'` on the dev box returns expected payload; error-path smoke returns `isError` with informative text; both recorded in `bn log lspm-zw9`
- [ ] `bun run test` green; `bun run typecheck` clean; `bun run build` succeeds
- [ ] Sub-epic `lspm-cnq` SC "`set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart." flipped `[ ]` → `[x]`
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit notes R7 complete; R7b, R9 still open

## Anti-Patterns

- **NO persistence.** `set_primary` writes only to the in-memory `_langMap`. No config file mutation, no `.local.md` write, no JSON serialization to disk. Phase 2 settings work (separate sub-epic `lspm-erd`) handles persistence — keep R7 pure runtime.
- **NO new Map allocation.** Mutate `slot.primary` in place. Rebuilding `_langMap` would reorder internals and break determinism contracts that listLanguages + primaryForFile rely on.
- **NO promoting `binary_not_found` manifests.** Primary implies dispatchable; if the binary isn't on PATH, routing can't dispatch. Refuse the mutation with an informative error. Keeps the invariant: `primary:true` rows in `list_languages` are always routable.
- **NO new `ManifestEntry` fields.** `primary` stays derived from `_langMap` at query time. Don't add `ManifestEntry.isPrimary` — that creates two sources of truth and R6's design has a matching anti-pattern.
- **NO MCP tool that returns internal objects.** Response is `{lang, primary, previous}` — three strings. No `ManifestEntry`, no `LspServer`, no `Map` reference leaking to the wire.
- **NO schema regen.** R7b's dynamic schemas will enum-ify `lang`/`manifest` later. `set_primary` does NOT trigger a re-registration after a swap — schemas are stable across the server lifetime per R7b's contract.
- **NO silent success log.** Log successful swaps to stderr with old → new. Users and agents inspecting logs need to see the mutation — it's the only signal the state changed.
- **NO hot-path overhead.** Validation is 3-4 Map lookups + an array scan over `slot.candidates`. Never probe the filesystem, never call `ensureRunning`, never touch `entry.server`. Parallel to R6's spawn-safety contract.

## Key Considerations

- **Error message phrasing.** Reuse R5's existing `_requireByName` phrasing for `binary_not_found` so users see a consistent error surface across query and mutation. Other errors (unknown lang, not-a-candidate) are new — write them as "expected, got, known alternatives" to match user expectations.
- **Return shape choice — `{lang, primary, previous}` vs. just `{primary}`.** The `previous` field lets an agent detect a no-op (primary === previous) without a prior `list_languages` call. Small payload, strong observability. Matches the stderr log's content.
- **Idempotent no-op.** When the target is already primary, mutation is skipped but a valid response still returns. Avoids forcing callers to pre-check — set_primary can be used as "ensure primary is X" without branching.
- **Thread safety / concurrency.** MCP transport is single-request per call in this server (no batching). No two `setPrimary` calls can race. JS single-threaded. No locks needed. If someone later adds request parallelism, the mutation is still a single assignment — atomic by JS semantics. No concern for Phase 1.
- **Interaction with `set_primary`-during-request.** A long-running `symbol_search` fan-out captures its target list up-front (per R4 design — `_selectSymbolSearchTargets` returns a snapshot). A concurrent `set_primary` during the fan-out doesn't affect the in-flight request. Sensible behavior; no special handling needed.
- **Test fixture: stderr spy hygiene.** Tests that assert the stderr log should `jest.spyOn(process.stderr, 'write').mockImplementation(() => true)` in `beforeEach` and `.mockRestore()` in `afterEach` (per CLAUDE.md convention). Do not leak spies across tests.
- **MCP error reporting.** The existing `toolError` helper wraps thrown errors into the MCP `isError: true` envelope with the error message. R7's handler relies on this — no new error-packaging code. Tests assert `isError === true` and message-substring matches.
- **No-op return still echoes `previous`.** Even on no-op, the return shape includes `previous` (equal to `primary`). Don't use `previous: null` or `previous: undefined` — consistency in the shape makes agent code simpler.

### Failure catalog (adversarial planning)

To be filled in by `adversarial-planning` skill at session start. Current adversarial battery in Step 14 covers empty-router, sequential swaps, failed-swap-state-preservation, reader-consistency, and spawn safety — SRE + adversarial-planning should audit for additional encoding/dense/race patterns beyond those.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R7 closes the `set_primary` SC bullet)
- **Blocked by:** none — R6 (`lspm-rot`) is closed; `_langMap` structure supports in-place mutation
- **Unlocks:** Phase 1 acceptance demo (bazel `starpls` ↔ `bazel-lsp` swap uses `set_primary`); R7b dynamic schemas (independent but often bundled conceptually)
