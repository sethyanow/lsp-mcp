---
id: lspm-rot
title: R6 — list_languages MCP tool
status: active
type: task
priority: 1
owner: Seth
parent: lspm-cnq
---





## Context

Advances sub-epic `lspm-cnq` SC: *"`list_languages` MCP tool returns `{lang, manifest, primary: bool, status, capabilities}[]`."*

R5 (`lspm-hlm`) added `ManifestEntry.status` and the `_buildLangMap` filter so only `ok` manifests route, while `_entries` / `_byName` keep every manifest enumerable. R6 surfaces that enumeration as an MCP tool: agents can see what langs the server routes, which manifest is primary per lang, which manifests have a missing binary, and each manifest's advertised capabilities — all without restarting or reading stderr.

This task does NOT ship:
- `set_primary` (R7) — mutation of the primary slot.
- Dynamic tool-schema enums (R7b) — re-scoped for R7.
- `using-lsp-mcp` skill (R9).
- Fresh-CC-session demo (lives in the Phase 1 acceptance task).

R5's design already committed to `list_languages` reading from `router.entries` (unfiltered). R6 is the consumer.

## Starting state (verified on branch `dev`, post-`lspm-hlm` commit c915691)

- `src/router.ts` exports `ManifestEntry { manifest, server, sourceKind, status }` and `Router`. Public accessors: `entries` (all, unfiltered), `entry(name)`, `servers`, `primaryForLang(langId)`, `candidatesForLang(langId)`, `ownerForFile(fileUri)`. No `listLanguages` method exists yet.
- `src/mcp-server.ts` (355 LOC) registers MCP tools via `server.registerTool(name, {description, inputSchema}, handler)`. Existing tools: `symbol_search`, `defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, and the conditionally-registered call-hierarchy tools. Each handler wraps its router call in `try { return jsonResult(...) } catch (err) { return toolError(name, err) }`. `jsonResult` + `toolError` are local helpers.
- `src/tests/mcp-server.test.ts` uses `Client` + `InMemoryTransport` from the MCP SDK to exercise tools end-to-end. `entriesFrom` helper already includes `status: 'ok' as const` (post-R5).
- `PluginManifest.capabilities` (from `src/types.ts`, schema-defaulted) is always present as an object with optional keys (`workspaceSymbol`, `implementations`, `callHierarchy`, `didOpenDelayMs`). Safe to return verbatim.
- Test baseline: 185 green across 7 suites.

## Design

### New `Router.listLanguages()` method

`src/router.ts` grows one public method:

```ts
export interface LanguageInfo {
    lang: string;
    manifest: string;            // manifest.name
    primary: boolean;            // true iff this manifest is the primary for `lang`
    status: ProbeStatus;         // 'ok' | 'binary_not_found'
    capabilities: PluginManifest['capabilities'];
}

listLanguages(): LanguageInfo[];
```

Algorithm — single pass over `_entries`:

1. For every `entry` in `_entries` (includes `binary_not_found`):
   2. For every `langId` in `entry.manifest.langIds`:
       3. `primary` = `entry.status === 'ok'` AND `this._langMap.get(langId)?.primary === entry.manifest.name`.
       4. Emit `{lang: langId, manifest: entry.manifest.name, primary, status: entry.status, capabilities: entry.manifest.capabilities}`.

Ordering: deterministic — preserve `_entries` insertion order, and `manifest.langIds` declared order within each entry. No sort. Agents parsing the list should not depend on internal order; the test just pins it for reproducibility.

### Router accessor for capabilities return shape

Capabilities flow through verbatim — `PluginManifest.capabilities` is already zod-validated (defaults to `{}`). Do not re-wrap or normalize. Callers that need a specific capability check it themselves via optional chaining.

### New MCP tool: `list_languages`

`src/mcp-server.ts`: register a zero-input-arg tool.

```ts
server.registerTool(
    'list_languages',
    {
        description:
            'Enumerate every (lang, manifest) pair the router knows about, including ' +
            'manifests whose binary was not found on PATH. Each entry reports which ' +
            'manifest is the primary for a given lang, the PATH probe status, and the ' +
            'manifest-declared LSP capabilities. No arguments.',
        inputSchema: {},
    },
    async () => {
        try {
            return jsonResult(router.listLanguages());
        } catch (err) {
            return toolError('list_languages', err);
        }
    }
);
```

Register adjacent to `symbol_search` (both are workspace-scope, no position args). Position it right after the `symbol_search` block so the file layout stays "workspace tools → file tools → call-hierarchy tools."

### Design invariants (what the implementation must preserve)

- **NO filtering `_entries` by status in `listLanguages`.** The whole point is showing missing-binary manifests so users can diagnose why their LSP isn't routing. Filtering defeats the tool.
- **NO duplicating `primary` semantics in Router.** `primary` is already encoded in `_langMap.get(langId).primary` — a single string. Resolving at query time keeps the source of truth singular.
- **NO adding input params.** R7b will drive schema enums for `lang` / `via` / `manifests` on mutating / routed tools. `list_languages` is read-only enumeration with no args — simplest possible surface.
- **NO returning `server: LspServer` objects in the response.** Response is JSON; LspServer instances don't serialize and shouldn't leak to MCP clients anyway. Expose only `manifest.name`.

## Implementation

### Step 1 — RED: `Router.listLanguages` for ok-only router

Extend `src/tests/router.test.ts`. New `describe('Router — listLanguages')`. First test:

```ts
it('returns {lang, manifest, primary, status, capabilities} rows for every (entry, langId) pair — ok-only router', () => { ... });
```

Fixture: two `makeMockServer` instances, e.g., `pyright` (langIds: ['python'], name: 'pyright') and `tsls` (langIds: ['typescript', 'javascript'], name: 'tsls'). Build router via `entriesFrom([pyright, tsls])` (all 'ok').

Assert `router.listLanguages()` returns 3 rows (python + typescript + javascript). For each, assert keys: `lang`, `manifest`, `primary: true`, `status: 'ok'`, `capabilities` (deep-equals the mock manifest's capabilities).

Run `bun run test -- --testPathPattern=router` → expect TS2339 "Property 'listLanguages' does not exist on type 'Router'".

### Step 2 — GREEN: implement `listLanguages`

Add to `src/router.ts`:
1. Define `LanguageInfo` interface above the class. Export it (re-exported via existing router exports).
2. Add method body that walks `_entries × manifest.langIds`, computes `primary` via `_langMap.get(langId)?.primary === entry.manifest.name && entry.status === 'ok'`, pushes rows. No sort.

Run → Step 1 passes. REFACTOR-assess.

### Step 3 — RED: missing-binary manifests surface with primary=false, status=binary_not_found

New test in the same describe. Fixture: one `ok` entry (`ok-lsp` for python) plus one `binary_not_found` entry (`missing-lsp` for rust). Both declared via explicit ManifestEntry literals with `status:` set.

Assertions:
- `listLanguages()` has 2 rows (python + rust).
- Python row: `primary: true`, `status: 'ok'`.
- Rust row: `primary: false` (not in `_langMap`), `status: 'binary_not_found'`, `capabilities` still present.

Run → expect RED only if Step 2 implementation missed the enumeration-side path. If Step 2 walked `_entries` correctly, this may pass (regression lock). If it passes, note "GREEN because Step 2 walked _entries; locking in regression against future 'filter by status' refactor."

### Step 4 — GREEN: (if Step 3 RED) fix enumeration. (if Step 3 GREEN) note regression lock.

### Step 5 — RED: two candidates for one lang — only first-registered is primary

Fixture: two mock servers both declaring `langIds: ['python']`, distinct names (`pyright`, `pyright-fork`). Both status: 'ok'. Construct router with `entriesFrom([pyright, pyrightFork])`.

Assertions:
- `listLanguages()` has 2 rows, both `lang: 'python'`.
- One with `manifest: 'pyright'`, `primary: true`.
- One with `manifest: 'pyright-fork'`, `primary: false`.

Run → expect GREEN if Step 2 computed `primary` via `_langMap.get(lang).primary === entry.manifest.name`. If it picked the wrong manifest as primary, refactor.

### Step 6 — REFACTOR-assess the primary computation

Verify `_langMap.get(lang)?.primary` is what determines `primary: true`. Confirm with a grep that no other code path writes to primary outside `_buildLangMap`.

### Step 7 — RED: manifest declares multiple langIds — one row per langId

Covered by Step 1's tsls fixture (typescript + javascript). If Step 1 only asserted length 3, add explicit assertion that both typescript + javascript rows reference `manifest: 'tsls'` and both have `primary: true`. Regression guard only.

### Step 8 — RED: empty router returns []

Fixture: `new Router([])`. Assert `listLanguages()` returns `[]`. Empty is a structural adversarial boundary.

### Step 9 — GREEN: confirm empty case works

The loop over `_entries = []` yields `[]` naturally. Regression lock.

### Step 10 — RED: MCP tool registration and response shape

Extend `src/tests/mcp-server.test.ts`. New `describe('MCP tool — list_languages')`. Use the existing `Client` + `InMemoryTransport` pattern to call the tool with empty args.

Fixture: two mock servers (one ok, one binary_not_found).

Assertions:
- Tool listed in `client.listTools()` output.
- `client.callTool({name: 'list_languages', arguments: {}})` returns structured content whose parsed JSON matches the Router's `listLanguages()` return shape.
- No error.

Run → expect "Tool list_languages not found" (or similar MCP error).

### Step 11 — GREEN: register `list_languages` in `createMcpServer`

Add `server.registerTool('list_languages', {description, inputSchema: {}}, handler)` per the Design sketch. Position after the `symbol_search` block.

Run → Step 10 passes.

REFACTOR-assess: description is concise and explains the purpose; handler mirrors the `try/jsonResult/toolError` pattern of sibling tools. No duplication.

### Step 12 — Adversarial battery

Add these to `router.test.ts` and/or `mcp-server.test.ts` as applicable:
- **All manifests binary_not_found**: every row has `primary: false`. Length = total langIds across all manifests.
- **Manifest with zero langIds** (`langIds: []`): emits zero rows for that manifest. Router's accept-empty-langIds contract is untouched — just not surfaced by `listLanguages`.
- **Call `listLanguages` twice**: second call returns equal shape (idempotency; no caching bugs).
- **One manifest, many langIds**: emits N rows all with the same `manifest` and `status`.
- **MCP response is pure JSON** (no circular refs via LspServer): assert `JSON.stringify(response)` doesn't throw and round-trips.
- **Spawn safety (Failure catalog: Temporal Betrayal)**: build router from mock servers with spyable `ensureRunning` / `request` / `openDocument` / `workspaceSymbol` jest.fns; call `listLanguages()`; assert every mocked method on every server has `.mock.calls.length === 0`. Guards against the implementation accidentally touching `entry.server`.
- **Primary-slot invariant (Failure catalog: State Corruption)**: single `ok` manifest declaring one langId, no competing candidate — the emitted row MUST have `primary: true`. Guards against future `_buildLangMap` filter regressions.
- **Duplicate langIds within one manifest (Failure catalog: Input Hostility)**: construct a manifest with `langIds: ['python', 'python']`; assert two rows with identical `{lang: 'python', manifest: <name>}`; documents no-dedupe-at-list-time behavior.

Each is an RED/GREEN cycle; most will pass as regression locks given the Step 2 implementation.

### Step 13 — Smoke

Rebuild `dist/index.js`. Launch server with `LSP_MCP_CONFIG=/nonexistent`:

```bash
LSP_MCP_CONFIG=/nonexistent node dist/index.js </dev/null 2>&1 | head -10
```

Confirm stderr still shows the startup banner unchanged from R5.

Then programmatic smoke: spawn the server via `@modelcontextprotocol/sdk` stdio client and call `list_languages`. Confirm the returned array has entries for the 7 ok + 5 missing builtins (see R5 smoke). Record the output in `bn log lspm-rot`.

If spawning from a shell script is awkward, write a tiny `node -e` script that uses the MCP SDK client directly, or lift the smoke into a jest-driven e2e test via the existing `InMemoryTransport` path. Prefer the e2e test — it's repeatable and doesn't need a subprocess.

### Step 14 — Full verification

```bash
bun run test > /tmp/lspm-rot-test.log 2>&1 && tail -15 /tmp/lspm-rot-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 185 baseline + ~10–12 new = ~195–197 green. Typecheck clean. Build succeeds.

### Step 15 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "`list_languages` MCP tool returns `{lang, manifest, primary: bool, status, capabilities}[]`." from `[ ]` to `[x]` with a satisfaction note pointing at this task.
- Do NOT flip `set_primary` (R7), dynamic-schemas (R7b), or CC-demo SCs.

### Step 16 — Commit + push

Stage `src/router.ts`, `src/mcp-server.ts`, `src/tests/router.test.ts`, `src/tests/mcp-server.test.ts`, `dist/index.js`, `dist/index.js.map`, `.bones/`. Commit message notes: `listLanguages` method + `list_languages` MCP tool + regression locks + R7/R7b/R9 still open. Push via bare `git push`.

## Success Criteria

- [x] `src/router.ts` exports `LanguageInfo` interface with fields `{lang, manifest, primary, status, capabilities}` matching the sub-epic SC shape
- [x] `Router.listLanguages(): LanguageInfo[]` method implemented; walks `_entries × manifest.langIds`; no status filter
- [x] `primary: true` iff `entry.status === 'ok'` AND `_langMap.get(lang)?.primary === entry.manifest.name`
- [x] `binary_not_found` manifests appear in output with `primary: false` and their declared langIds (regression-tested)
- [x] Multiple candidates for one lang: only the `_langMap.primary` entry has `primary: true` (regression-tested)
- [x] Manifest declaring multiple langIds emits one row per langId, all with the same `manifest` and `status` (regression-tested)
- [x] Empty router returns `[]`
- [x] `listLanguages()` is idempotent — second call returns the same shape (regression lock)
- [x] `capabilities` field returned verbatim from `manifest.capabilities` (schema-defaulted to `{}` when the manifest omits it)
- [x] MCP tool `list_languages` registered in `src/mcp-server.ts` with empty `inputSchema`, `try/jsonResult/toolError` handler pattern
- [x] `list_languages` appears in `client.listTools()` output (new MCP test asserts)
- [x] `client.callTool({name: 'list_languages', arguments: {}})` returns a JSON-serializable array matching `Router.listLanguages()` shape (new MCP test asserts)
- [x] No `LspServer` instances leak into MCP response; response round-trips through `JSON.stringify`/`JSON.parse`
- [x] Adversarial cases covered: all-missing router, zero-langIds manifest, idempotency, many langIds per manifest
- [x] `listLanguages` does NOT call any `LspServer` methods (no `ensureRunning`, no `shutdown`, no request) — test asserts every `jest.fn()` on the mock server is untouched after `listLanguages()`
- [x] Invariant regression-locked: single `ok` manifest declaring one langId with no competing candidate ALWAYS emits `primary: true` — guards against future `_buildLangMap` filter regressions
- [x] Duplicate langIds within one manifest (`langIds: ['python', 'python']`) emit two rows — documented current behavior, no dedupe at list time
- [x] 185 baseline tests stay green; new tests land (~13–15 new; target ~198–200) *(202 total — 17 new: 13 router listLanguages + 3 MCP + 1 e2e smoke)*
- [x] Smoke: `list_languages` called against a fresh server with built-in defaults returns entries for 7 ok + 5 missing builtins on the dev box (record in `bn log lspm-rot`) *(recorded — 12 manifests loaded, 7 ok + 5 missing, 18 list_languages rows, 13 primary langs)*
- [x] `bun run test` green; `bun run typecheck` clean; `bun run build` succeeds
- [x] Sub-epic `lspm-cnq` SC "`list_languages` MCP tool returns …" flipped `[ ]` → `[x]`
- [x] Single commit on `dev`, pushed via bare `git push`. Commit notes R6 complete; R7, R7b, R9 still open

## Anti-Patterns

- **NO filtering `_entries` by status inside `listLanguages`.** Missing-binary manifests MUST appear in the output — that's the UX value. The status column tells the user what's wrong.
- **NO adding input parameters.** This tool is read-only enumeration. `lang` filter, `manifest` filter, etc. are out of scope. If a user needs filtering they can `.filter()` on the client side.
- **NO hardcoding `primary` as a second field on `ManifestEntry`.** Primary is derived from `_langMap` at query time. Duplicating it onto entries creates an invariant maintenance burden — R7 `set_primary` already has one place to update (`_langMap`), don't add another.
- **NO serializing the `LspServer` object in the response.** Only return `manifest.name`. The MCP client doesn't (and shouldn't) see the LSP process handle.
- **NO reordering `_entries` or `manifest.langIds` in this tool.** Insertion order is a documented Router property; `listLanguages` preserves it. Sorting in the tool would surprise future callers that depend on the Router's order.
- **NO MCP-tool name with camelCase.** Existing tools use snake_case (`symbol_search`, `list_languages`). Match the convention.

## Key Considerations

- **`capabilities` shape stability.** `PluginManifest.capabilities` is zod-validated with `.default({})`. `listLanguages` returns it verbatim. If the schema grows new capability flags in a future task, the tool surface picks them up automatically — no code change here. Tests should assert presence of the existing flags but NOT exhaustively enumerate — otherwise the test is brittle to schema growth.
- **Response size.** 12 built-in manifests × 1-2 langIds each ≈ 15-20 rows. Adding a custom manifests dir could push this to 50+ rows. Still tiny for MCP JSON response. No pagination needed.
- **Determinism for tests.** `_entries` insertion order is preserved (post-dedupe-by-name), and `manifest.langIds` order is declared by the JSON source. Tests can assert exact ordering. If test flakiness emerges, check dedupe-by-name tie-breaking — not listLanguages.
- **LspServer object in ManifestEntry.** `ManifestEntry.server` is NOT included in `LanguageInfo` — only `manifest.name` is surfaced. Makes the response purely data, no opaque handles.
- **Interaction with R7 `set_primary`.** When R7 lands, `_langMap.get(lang).primary` will mutate on `set_primary`. `listLanguages` will reflect the new primary on the next call — no caching. This is the design intent: the tool is a query, not a snapshot.
- **Interaction with R7b dynamic schemas.** `list_languages` itself has empty `inputSchema`. No schema needs regenerating. R7b's scope is `lang` / `via` / `manifests` enums on other tools.
- **MCP inputSchema: {} semantics.** An empty zod schema object means "no arguments required." The MCP SDK accepts this. Verify by checking an existing zero-arg pattern — if none exists, the first test confirms behavior.
- **Test fixture: `makeMockServer` ignores `capabilities` param.** The fixture sets a default capabilities object (`{ workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 } }`). Tests asserting `capabilities` equality should match that shape or construct manifests via `PluginManifestSchema.parse(...)` for realism.

### Failure catalog (adversarial planning)

**Temporal Betrayal: `listLanguages` must not spawn LSP processes**
- Assumption: enumeration is a pure read of manifest metadata.
- Betrayal: future refactor could call `entry.server.ensureRunning()` or read server state, triggering lazy spawn for every candidate.
- Consequence: one `list_languages` call wakes all 12 built-in LSP processes on first invocation; defeats the lazy-spawn design that keeps dormant candidates at zero cost.
- Mitigation: the implementation reads only `entry.manifest.*` and `_langMap.get(lang).primary` — never `entry.server`. Regression-locked by asserting every `jest.fn()` on the mock `LspServer` is untouched after `listLanguages()` returns.

**State Corruption: `ok` entry missing primary slot for a declared langId**
- Assumption: every `ok` entry contributes to `_langMap` for each of its `langIds`.
- Betrayal: a future `_buildLangMap` refactor (e.g., capability-based filter, langId normalization) could silently exclude an entry without flipping its `status`.
- Consequence: `listLanguages` shows `status: 'ok'` alongside `primary: false` for an unchallenged manifest — looks broken with no competing candidate to explain it, and the agent has no way to diagnose from the tool surface.
- Mitigation: invariant test — router with one `ok` manifest declaring one langId, no other candidate, MUST emit `primary: true` for that row. Any future `_buildLangMap` filter that drops the entry breaks this test immediately.

**Input Hostility: duplicate langIds within one manifest**
- Assumption: `manifest.langIds` is a set of distinct strings.
- Betrayal: schema (`z.array(z.string())`) does not dedupe; a hand-authored manifest could declare `langIds: ['python', 'python']`.
- Consequence: `listLanguages` emits two identical rows; not a correctness bug but surprising UX.
- Mitigation: regression-lock current behavior (two rows, no dedupe in `listLanguages`). If dedupe becomes desired, the fix belongs at schema load, not here — `listLanguages` faithfully represents what the manifest declared.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R6 closes the `list_languages` SC bullet)
- **Blocked by:** none — `lspm-hlm` (R5) is closed; status field is available
- **Unlocks:** R7 `set_primary` (mutation needs a query surface to observe results); R7b dynamic schemas (enum values derive from the manifest set that `list_languages` also enumerates); Phase 1 acceptance task (demo flow uses `list_languages`)

## Log

- [2026-04-20T02:07:39Z] [Seth] R6 complete. listLanguages method + list_languages MCP tool shipped. Tests: 200 → 202 (17 new: 13 router + 3 MCP + 1 e2e smoke). Programmatic smoke via stdio MCP client against dist/index.js on dev box: 12 manifests loaded (7 ok: clangd, gopls, pyright, rust-analyzer, svelte-language-server, typescript-language-server, zls | 5 missing: bash-language-server, bazel-lsp, elixir-ls, lua-language-server, starpls). list_languages returned 18 rows (13 ok + 5 missing); 13 primary langs: c, cpp, go, javascript, javascriptreact, objective-c, objective-cpp, python, rust, svelte, typescript, typescriptreact, zig. Generic reusable smoke harness added at scripts/smoke-mcp-tool.mjs. R7 set_primary, R7b dynamic schemas, R9 using-lsp-mcp skill still open.
