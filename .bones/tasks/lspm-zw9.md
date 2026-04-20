---
id: lspm-zw9
title: R7 — set_primary MCP tool
status: closed
type: task
priority: 1
owner: Seth
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
- `_requireByName(name)` (private Router method at `src/router.ts:442`, introduced by R5 `lspm-hlm`) throws two distinct messages: `No manifest named "<name>"` for unknown names, and `Manifest "<name>" is binary_not_found — binary not found on PATH` for missing-binary access. Reuse the `binary_not_found` phrasing (quoted name) verbatim for R7's status validation to keep a consistent error surface. The unknown-manifest case is NEW phrasing in R7 because it lists known alternatives (`_requireByName` does not) — see Design validation order #1.
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
- Else: **mutate first, then log.** Order is `slot.primary = manifestName` → `process.stderr.write('[lsp-mcp] set_primary: <lang> <previous> → <manifestName>\n')`. Mutation must precede log so a stderr failure (EPIPE / closed pipe) cannot leave state un-applied. No try/catch around the log — EPIPE is a process-wide concern, not R7's job to mask.
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
- Mutation precedes stderr log (write-order invariant from failure catalog). No logger callback wraps the assignment. No try/catch around the stderr write.
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
- **Cross-slot isolation (multi-langId manifests).** Fixture: manifest `A` declares `langIds: ['typescript', 'javascript']`; manifest `B` declares `langIds: ['typescript']` only. Both ok. Initially `primaryForLang('typescript') === A` and `primaryForLang('javascript') === A` (A registered first). Call `setPrimary('typescript', 'B')`. Assert `primaryForLang('typescript').manifest.name === 'B'` AND `primaryForLang('javascript').manifest.name === 'A'` (UNCHANGED). Also assert `listLanguages()` shows `javascript` row's `primary: true` still pointing at `A`. Regression lock against a future refactor that might accidentally mutate every slot a manifest appears in, instead of just the target slot. Per-slot mutation is the design contract; this test makes it non-regressable.
- **Empty-string arguments** (failure catalog: Input Hostility). Fixture: one ok candidate for `python`. Two subtests:
  - `setPrimary('', 'pyright')` throws matching `/Unknown manifest:/` (empty manifest resolves as unknown-manifest per validation order #1).
  - `setPrimary('python', '')` throws matching `/Unknown manifest:/` (empty manifest, same path).
  - After each: `primaryForLang('python').manifest.name === 'pyright'` unchanged. Locks in that empty-string args route through unknown-manifest error, not through unknown-lang or a future silent-no-op rewrite.
- **Synchronous Router call** (failure catalog: Dependency Treachery). Assert `router.setPrimary('python', 'pyright-fork')` returns a plain object (not a Promise): `expect(router.setPrimary(...)).not.toHaveProperty('then')` and `expect(typeof result.lang).toBe('string')`. Regression lock against a future async refactor that would silently break the MCP handler (handler is `async` but doesn't `await` the router call — any Promise would serialize as `{}`).

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

Expect baseline 202 + ~18–21 new = ~220–223 green. Typecheck clean. Build succeeds.

### Step 18 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "`set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart." from `[ ]` to `[x]` with satisfaction note pointing at `lspm-zw9`.
- Do NOT flip R7b (dynamic schemas), R9 skill, or acceptance demo SCs.

### Step 19 — Commit + push

Stage `src/router.ts`, `src/mcp-server.ts`, `src/tests/router.test.ts`, `src/tests/mcp-server.test.ts`, `dist/index.js`, `dist/index.js.map`, `.bones/`. Commit message notes: `setPrimary` method + `set_primary` MCP tool + validation + stderr logging + adversarial battery + R7b/R9 still open. Push via bare `git push`.

## Success Criteria

- [x] `Router.setPrimary(lang, manifestName): {lang, primary, previous}` implemented in `src/router.ts`
- [x] Validation fails fast with specific errors: unknown manifest, unknown lang, not-a-candidate, binary_not_found (each with regression test)
- [x] Successful swap mutates `_langMap[lang].primary` in place (no Map reallocation, no reordering of `_entries` or candidates)
- [x] No-op when new primary equals current — returns `{lang, primary, previous}` where primary === previous, skips stderr log, no state change
- [x] `listLanguages()` reflects the swap on next call (regression-tested — guards future caching)
- [x] `primaryForLang(lang)` reflects the swap on next call
- [x] `candidatesForLang(lang)` order is unchanged after a swap (only primary string flipped)
- [x] Stderr log on successful swap: `[lsp-mcp] set_primary: <lang> <previous> → <new>` (suppressed on no-op)
- [x] `binary_not_found` manifest cannot be promoted to primary (refused with informative error; primary unchanged)
- [x] MCP tool `set_primary` registered in `src/mcp-server.ts` with `{lang: string, manifest: string}` input schema, try/jsonResult/toolError handler
- [x] `set_primary` appears in `client.listTools()` output
- [x] `client.callTool({name: 'set_primary', arguments: {lang, manifest}})` returns `{lang, primary, previous}` on success
- [x] MCP error surface returns `isError: true` with error message for each of the 4 validation failures (unknown manifest, unknown lang, not-a-candidate, binary_not_found)
- [x] `setPrimary` does NOT invoke any `LspServer` methods (spawn safety; parallel to R6)
- [x] Sequential swap (A → B → A) restores initial state; each swap reports correct `previous`
- [x] Failed swap (e.g., binary_not_found target) leaves primary unchanged — state-corruption regression lock
- [x] Cross-slot isolation: `setPrimary(langX, M)` where M declares multiple langIds leaves OTHER slots' primaries unchanged (regression lock against accidental multi-slot mutation)
- [x] Empty-string args: `setPrimary('', 'pyright')` throws `Unknown manifest:`; `setPrimary('python', '')` throws `Unknown manifest:` (regression lock on validation order under empty args)
- [x] MCP handler invokes `router.setPrimary(...)` synchronously and returns the plain object (not a Promise) — return shape equals `{lang, primary, previous}` on success (regression lock against future async refactor)
- [x] Response payload JSON-round-trips through `JSON.stringify`/`JSON.parse` without throwing
- [x] 202 baseline tests stay green; new tests land (~18–21 new; target ~220–223) — **223 green, 21 new**
- [x] Smoke: `node scripts/smoke-mcp-tool.mjs set_primary '{"lang":"...","manifest":"..."}'` on the dev box returns expected payload; error-path smoke returns `isError` with informative text; both recorded in `bn log lspm-zw9`
- [x] `bun run test` green; `bun run typecheck` clean; `bun run build` succeeds
- [x] Sub-epic `lspm-cnq` SC "`set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart." flipped `[ ]` → `[x]`
- [x] Single commit on `dev`, pushed via bare `git push`. Commit notes R7 complete; R7b, R9 still open *(commit `1054ba0`)*

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

Structured findings from the six-category walk (Input Hostility / Encoding / Temporal / Dependency / State / Resource) against the four components: `Router.setPrimary`, `set_primary` MCP tool, stderr log line, error surface. Most categories are covered by existing anti-patterns / adversarial battery / Key Considerations; entries below call out what those don't already lock in.

**Input Hostility: empty-string arguments (`Router.setPrimary`)**
- Assumption: Callers pass non-empty strings for `lang` and `manifestName`.
- Betrayal: MCP client sends `{lang: '', manifest: 'pyright'}` or `{lang: 'python', manifest: ''}`. Zod's `z.string()` accepts both; `_byName.get('')` returns undefined; `_langMap.get('')` returns undefined.
- Consequence: Validation order resolves correctly — empty manifest → "Unknown manifest: " error; empty lang (with valid manifest) → "Unknown lang: " error. No state change, no crash. The risk is a future refactor adding a `.trim().length > 0` precheck that silently reshuffles which error fires first, or worse, accepts an empty string as "unchanged" no-op.
- Mitigation: Structural — validation order is explicit (manifest first, lang second), and the per-error tests lock specific error messages. Add adversarial tests for empty `lang` and empty `manifest` to prevent silent reshuffle. (See Success Criteria below.)

**State Corruption: write-order invariant (`Router.setPrimary`)**
- Assumption: `slot.primary = manifestName` executes BEFORE `process.stderr.write(...)`. State is consistent regardless of whether the log succeeds.
- Betrayal: Future refactor re-orders to "log-then-mutate" for readability, or wraps the mutation inside a logger callback. A stderr EPIPE would then leave the mutation un-applied while the log (if it got part-way) suggests the swap happened. Or a try/catch around the log could accidentally swallow the mutation.
- Consequence: Observed state (`primaryForLang`) diverges from logged state — the kind of ghost bug that takes hours to reproduce.
- Mitigation: Structural — make the write-order a stated invariant in Design ("mutate, then log") and extend Step 10 REFACTOR-assess ("Single mutation site") to also check "mutation precedes log, no logger callback wraps the assignment." No test (mocking stderr to throw is fragile and tests the wrong thing); code-review discipline is sufficient because the single-line method is obvious.

**State Corruption: single-writer invariant on `slot.primary`**
- Assumption: `setPrimary` is the ONLY code path that writes to any `_langMap.<lang>.primary` field. All other references are reads.
- Betrayal: A future feature (auto-failover when primary's LspServer crashes; policy-driven rotation; test-only state reset) adds a second writer. Two writers interleaved via async microtask boundaries produce race-condition state.
- Consequence: Intermittent primary flips that don't correspond to any user action; debugging requires scanning the whole codebase for `slot.primary =`.
- Mitigation: Structural — Step 10 REFACTOR-assess already covers "Single mutation site in Router (`slot.primary = manifestName`). No duplicate `_langMap` writer." Keep that criterion. If a future feature needs a second writer, it must route through `setPrimary` or be explicitly added to the adversarial battery with interleave tests.

**Dependency Treachery: Router call must stay synchronous**
- Assumption: `router.setPrimary()` is synchronous — handler wraps it in `try { return jsonResult(router.setPrimary(...)) } catch ...` without `await`.
- Betrayal: Future refactor makes `setPrimary` async (e.g., to re-probe the binary before promotion). Without `await`, the handler would return a Promise as the response payload, which `jsonResult` would stringify as `{}` — silent data loss. A throw inside the async work would become an unhandled rejection.
- Consequence: MCP client gets `{}` on success (not the `{lang, primary, previous}` triplet). Errors go missing. The tool appears to work but its output is broken.
- Mitigation: Structural — Anti-Pattern "NO hot-path overhead" already forbids async/filesystem/ensureRunning in `setPrimary`. Test explicitly asserts return shape equals `{lang, primary, previous}` (not `{}`). A future async refactor would break that test immediately.

**Encoding Boundaries: Unicode normalization (deferred)**
- Assumption: MCP-arrived strings and discovery-registered manifest names use byte-identical UTF-8.
- Betrayal: Client sends decomposed Unicode (`e` + combining acute), manifest file used precomposed (`é`). Map.get fails silently — user sees "Unknown manifest" despite typing the name correctly.
- Consequence: Confusing UX for non-ASCII manifest names.
- Mitigation: Out of scope for Phase 1 (all 12 builtins are ASCII; authored manifests are advisory). Do NOT add NFC normalization in R7 — it changes comparison semantics for Map keys everywhere downstream. Flag as Phase 2+ concern if encountered. No test, no SC — signpost only.

**Skipped categories (with reasons):**
- **Resource Exhaustion** for setPrimary: O(1) Map lookups + O(N) over `slot.candidates` where N is typically 1-3, max ~10 for Bazel-like langs. Stderr log adds one line per call. No exhaustion path.
- **Temporal Betrayal** beyond mid-request fan-out (already in Key Considerations): JS is single-threaded; mutation is one assignment. No true race. The `_selectSymbolSearchTargets` snapshot semantics are already documented.
- **Dependency Treachery** beyond sync-Router-call: setPrimary has no filesystem, network, or subprocess calls — no external dependency to betray.
- **Input Hostility** beyond empty-string: extreme-length strings just waste a Map lookup; control characters in names would be an author-controlled concern (manifest files), not a runtime trust boundary; type-coercion is prevented by Zod at the MCP layer.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R7 closes the `set_primary` SC bullet)
- **Blocked by:** none — R6 (`lspm-rot`) is closed; `_langMap` structure supports in-place mutation
- **Unlocks:** Phase 1 acceptance demo (bazel `starpls` ↔ `bazel-lsp` swap uses `set_primary`); R7b dynamic schemas (independent but often bundled conceptually)

## Log

- [2026-04-20T05:20:19Z] [Seth] SRE refinement: verified skeleton claims against codebase (src/router.ts:442 _requireByName phrasing, 553 LOC, 202-test baseline, _byName/_langMap structure, no existing primary mutator, mcp-server.ts registration pattern, test fixture conventions). Two additions: (1) Cross-slot isolation adversarial test — multi-langId manifest (e.g. tsls declaring ['typescript','javascript']) + sibling single-langId manifest, swap on one lang must leave other slot primary unchanged. Regression lock against accidental multi-slot mutation. (2) Starting-state _requireByName quote corrected to match actual code (two error messages: 'No manifest named "X"' for unknown, 'Manifest "X" is binary_not_found — binary not found on PATH' for missing binary — clarifies which phrasing R7 reuses). Updated SC count target 16-19 new tests (was 15-18). No design changes: validation order, return shape, invariants, anti-patterns stand as scoped.
- [2026-04-20T05:24:28Z] [Seth] Adversarial planning: walked 6 categories × 4 components (Router.setPrimary, MCP tool, stderr log, error surface). Failure catalog added to Key Considerations with 5 explicit entries + skipped-with-reason list: (1) Input Hostility empty-string args — resolves via validation order to Unknown-manifest, tests lock order. (2) State Corruption write-order invariant — mutation MUST precede stderr log so EPIPE cannot leave state un-applied; Design + Step 10 REFACTOR-assess updated. (3) State Corruption single-writer — slot.primary has exactly one writer (setPrimary); future auto-failover features must route through it. (4) Dependency Treachery sync-Router-call — handler doesn't await; async refactor would serialize as {} silently; regression test added. (5) Encoding Unicode normalization — out-of-scope Phase 1 signpost. Skipped with reason: Resource (O(1)+O(few)), further Temporal (JS single-threaded), further Dependency (no external calls), further Input Hostility (Zod + author-controlled names). Added 3 new SCs (empty-string, sync-call, cross-slot-already-added). Test count target 18-21 new (was 16-19, was 15-18). No design changes: validation order, return shape, MCP tool shape, anti-patterns all stand.
- [2026-04-20T05:47:36Z] [Seth] Step 16 smoke outputs on dev box (12 builtins, 7 ok): (1) set_primary python/pyright → idempotent no-op, returned {lang:python, primary:pyright, previous:pyright}; no stderr log line (suppressed on no-op). (2) set_primary python/nonexistent → isError:true with 'set_primary error: Unknown manifest: nonexistent. Known: [12 names alphabetical]'. (3) set_primary cobol/pyright → isError:true with 'set_primary error: Unknown lang: cobol. Known: [13 active langs alphabetical]'. No multi-candidate python on dev box so no A→B swap smoke possible without a fork manifest; Phase 1 acceptance demo (lspm-cnq acceptance task) covers that via bazel starpls↔bazel-lsp.
