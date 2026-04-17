---
id: lspm-z4z
title: Refactor router to multi-candidate routing with via/manifests params
status: open
type: task
priority: 1
parent: lspm-cnq
---


## Context

Second task in Phase 1 sub-epic `lspm-cnq`, parent epic `lspm-y5n`. Prior task `lspm-501` delivered the root-as-plugin marketplace scaffolding and verified `${CLAUDE_PLUGIN_ROOT}` path resolution empirically.

This task delivers **R4 only** from the parent epic: the multi-candidate routing model that every other Phase 1 feature (R3 PATH probe, R5 `list_languages`, R6 `set_primary`, R7 dynamic schemas, R8 layered discovery) depends on. Scoping is deliberately narrow — the router refactor plus the `via?` / `manifests?` tool parameters, nothing else.

**Explicitly out of scope (tracked as later Phase 1 tasks):** PATH probe (R3), `list_languages` (R5), `set_primary` (R6), dynamic tool-schema enums (R7), layered manifest discovery (R8), manifest library JSON files (R2), `using-lsp-mcp` skill content (R9), `sourceKind` field on `ManifestEntry`.

**Starting state (verified in `src/` on branch `dev`):**
- `src/router.ts` (278 LOC) stores `_servers: LspServer[]`; routing via array-find through `ownsFile` / `ownsLang`. No candidate/primary concept.
- `src/types.ts` (141 LOC) has `PluginManifestSchema` via Zod — no `ManifestEntry` yet.
- `src/mcp-server.ts` (337 LOC) exposes 9 tools (`symbol_search`, `defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, plus 3 gated call-hierarchy tools). None accept `via?` / `manifests?`.
- `src/index.ts` bootstraps: `manifests.map(m => new LspServer(...))` → `new Router(servers)`.
- `src/config.ts` is untouched by this task (R8 territory).
- Tests at 66/66 green. `src/tests/router.test.ts` / `mcp-server.test.ts` / `e2e.test.ts` construct `new Router([...])` in 36 places with flat `LspServer[]` — all 36 migrate to `ManifestEntry[]` here.
- Mock factory collision: `makeMockServer(...).manifest.name === 'mock'` for every mock; two mocks in same test will collide in the new `_byName` map — factories need a unique-name affordance.

## Requirements

Satisfies parent epic R4:

> Router supports multiple manifests declaring the same `langId`. Routing model: `Map<langId, {candidates: ManifestEntry[], primary: string}>`. Positional operations (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) route to the lang's primary unless a `via` parameter names a specific manifest. `symbol_search` fans across primaries of all langs by default (or a specified subset via `langs`); a `manifests` parameter scopes fan-out to specific named manifests.

Does NOT satisfy R2, R3, R5, R6, R7, R8, R9 — those are downstream tasks that layer on this contract.

## Design

### Routing model

```
Router state
├── _entries: ManifestEntry[]                    // canonical list (preserves registration order)
├── _byName: Map<string, ManifestEntry>          // O(1) lookup for via/manifests resolution
└── _langMap: Map<langId, { candidates: ManifestEntry[], primary: string }>
                                                  // primary = manifest name; first-registered wins
```

`ManifestEntry = { manifest: PluginManifest, server: LspServer }` — defined in `src/router.ts` (not `types.ts`) to avoid circular import with `lsp-server.ts`. No `sourceKind` field in this task; R8 extends the type.

### Routing semantics

- **Positional methods** (`definitions`, `references`, `implementations`, `hover`, `documentSymbols`, `diagnostics`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `raw`): accept optional `via?: string`.
    - `via` given + `_byName.get(via)` hits → route to that entry's server.
    - `via` given + unknown name → throw `Error('No manifest named "${via}"')`.
    - `via` omitted → resolve primary: for file-URI methods via `primaryForFile(filePath)`; for `raw` via `primaryForLang(lang)`; for `incomingCalls`/`outgoingCalls` via the item's `uri` → `primaryForFile`.
- **`symbolSearch(query, langIds?, manifests?)`**:
    - `manifests` non-empty array → fan-out to each named entry (unknown name stderr-logs + skips; does not abort).
    - `manifests` omitted or empty → fan-out to each langId's primary only (one server per langId, deduped by manifest name). If `langIds` is provided, restrict to those langs' primaries.

### Public API changes

Router public surface after refactor:

```ts
class Router {
    constructor(entries: ManifestEntry[]);
    get servers(): LspServer[];                                    // flat list (for lifecycle + capability probes)
    get entries(): ManifestEntry[];
    entry(name: string): ManifestEntry | undefined;
    primaryForLang(langId: string): ManifestEntry | undefined;
    candidatesForLang(langId: string): ManifestEntry[];
    primaryForFile(filePath: string): ManifestEntry | undefined;

    serverForFile(filePath: string): LspServer | undefined;        // preserved (delegates to primaryForFile)
    serverForLang(langId: string): LspServer | undefined;          // preserved (delegates to primaryForLang)

    async definitions(fileUri, position, via?): Promise<Location[]>;
    async references(fileUri, position, includeDeclaration?, via?): Promise<Location[]>;
    async implementations(fileUri, position, via?): Promise<Location[]>;
    async hover(fileUri, position, via?): Promise<Record<string, unknown> | null>;
    async documentSymbols(fileUri, via?): Promise<SymbolInfo[]>;
    async diagnostics(fileUri, via?): Promise<DiagnosticInfo[]>;
    async prepareCallHierarchy(fileUri, position, via?): Promise<unknown[]>;
    async incomingCalls(item, via?): Promise<unknown[]>;
    async outgoingCalls(item, via?): Promise<unknown[]>;
    async raw(lang, method, params, via?): Promise<unknown>;
    async symbolSearch(query, langIds?, manifests?): Promise<SymbolInfo[]>;

    async shutdownAll(): Promise<void>;                            // unchanged
    forceKillAll(): void;                                          // unchanged
}
```

### MCP tool schema changes

- Each positional tool schema gets `via: z.string().optional().describe('Manifest name to target (overrides primary routing).')`.
- `symbol_search` schema gets `manifests: z.array(z.string()).optional().describe('Restrict search to specific manifest names (overrides primary-only fan-out).')`.
- Plain `z.string()` / `z.array(z.string())` — **dynamic enums are R7, not this task.** Inline TODO comment at each added field: `// R7 (downstream task): replace with z.enum() over active manifest names.`

## Implementation

### Step 1 — Prep: unique manifest names in test mock factories

- `src/tests/router.test.ts`: change `makeMockServer(langIds, fileGlobs)` signature to `makeMockServer(langIds, fileGlobs, opts?: { name?: string })`; default `name` to `mock-${counter++}` via module-scope counter. Update the manifest constant to use `opts?.name ?? nextMockName()`.
- `src/tests/mcp-server.test.ts`: same change to its `makeMockServer` (extending existing `MockOpts` with optional `name`).
- No assertion changes; behavior-neutral. This is non-logic scaffolding (TDD escape hatch applies).
- Command: `bun run typecheck` — clean.

### Step 2 — RED: tests for ManifestEntry + langMap construction

- File: `src/tests/router.test.ts`. Add `describe('Router multi-candidate routing')`.
- Test "first-registered candidate is primary": two entries both declaring `langIds: ['python']` with names `pyright` and `pyright-fork`; assert `router.primaryForLang('python')?.manifest.name === 'pyright'`.
- Test "candidatesForLang returns all candidates in registration order": same setup; assert `.map(e => e.manifest.name)` is `['pyright', 'pyright-fork']`.
- Test "unknown lang returns undefined": `router.primaryForLang('rust')` is `undefined`; `router.candidatesForLang('rust')` is `[]`.
- Test "entry() returns ManifestEntry by manifest name": `router.entry('pyright-fork')?.manifest.name === 'pyright-fork'`.
- Command: `bun run test -- --testPathPattern=router.test` — expect COMPILE failure on `ManifestEntry` type + `primaryForLang` / `candidatesForLang` / `entry` methods.

### Step 3 — GREEN: introduce ManifestEntry + build langMap

- File: `src/router.ts`.
- Export `interface ManifestEntry { manifest: PluginManifest; server: LspServer; }` (import `PluginManifest` type-only; `LspServer` type-only — already `import type` in file).
- Change constructor: `constructor(entries: ManifestEntry[])`. Store `private readonly _entries`, `_byName = new Map(entries.map(e => [e.manifest.name, e]))`, and `_langMap` built by a private `_buildLangMap(entries)` that iterates each entry's `manifest.langIds`, pushes to candidates, sets primary on first occurrence.
- Replace `get servers(): LspServer[]` → return `_entries.map(e => e.server)`.
- Add `get entries(): ManifestEntry[]` → `_entries`.
- Add public `entry(name)`, `primaryForLang(langId)`, `candidatesForLang(langId)`.
- Step 2 tests pass. Other tests will fail to compile (Step 4 fixes).
- Command: `bun run test -- --testPathPattern=router.test` — only the 4 new tests pass; lots of compile errors in existing tests.

### Step 4 — GREEN: migrate 36 test call sites to ManifestEntry[]

- Add a module-level helper in each of `router.test.ts`, `mcp-server.test.ts`, `e2e.test.ts`:
    ```ts
    function entriesFrom(servers: LspServer[]): ManifestEntry[] {
        return servers.map((s) => ({ manifest: s.manifest, server: s }));
    }
    ```
- Replace every `new Router([a, b, ...])` with `new Router(entriesFrom([a, b, ...]))`.
- For tests that construct two mocks with the same default `'mock'` name AND store both in the same Router (e.g. python-dup test in router.test.ts around lines 109–118; starpls-style A/B tests added in Step 5), pass distinct `name` via `opts`.
- Command: `bun run test 2>&1 | tee /tmp/lspm-z4z-step4.log` — all 66 pre-existing tests + 4 new from Step 2 green.

### Step 5 — RED: primaryForFile tests

- File: `src/tests/router.test.ts`. Extend the multi-candidate describe.
- Test: two entries share `langIds: ['python']` + `fileGlobs: ['**/*.py']` (names: `pyright`, `pyright-fork`). Assert `router.primaryForFile('/x.py')?.manifest.name === 'pyright'`.
- Test: two entries declare different langs + globs. Assert `primaryForFile('/x.rs')?.manifest.name === 'rust-analyzer'`.
- Test: no entry owns the file → `undefined`.
- Command: `bun run test -- --testPathPattern=router.test` — expect compile failure on `primaryForFile`.

### Step 6 — GREEN: implement primaryForFile + bridge serverForFile

- File: `src/router.ts`. `primaryForFile(filePath)`: iterate `_langMap` values in insertion order; for each `{primary}`, resolve via `_byName`; return first entry whose `server.ownsFile(filePath)` is true. Return `undefined` if none match.
- Redirect `serverForFile(filePath)` → `primaryForFile(filePath)?.server`; redirect `serverForLang(langId)` → `primaryForLang(langId)?.server`.
- Command: `bun run test` — all green.

### Step 7 — RED: `via?` on definitions (first positional method)

- File: `src/tests/router.test.ts`. New `describe('Router via parameter')`.
- Test "via routes to named candidate": pyright + pyright-fork entries; `router.definitions('file:///x.py', pos, 'pyright-fork')`; assert pyright-fork's `openDocument` + `request` called; pyright's NOT called.
- Test "unknown via throws": `router.definitions('file:///x.py', pos, 'unknown')` rejects with error message matching `/unknown/`.
- Test "undefined via falls through to primary": no third arg; pyright's methods called.
- Command: `bun run test -- --testPathPattern=router.test` — expect red (signature mismatch / unknown-via passes through silently).

### Step 8 — GREEN: thread `via` through all positional methods

- File: `src/router.ts`.
- Refactor `_fileRequest<T>(server, fileUri, method, params, fallback)` so caller passes the pre-resolved server.
- Add private `_routeFileRequest(fileUri, via?: string): ManifestEntry | undefined`:
    - `via` given → `_byName.get(via)` or throw `Error('No manifest named "${via}"')`.
    - Else → resolve `filePath` from `fileUri` (existing `fileURLToPath` logic), return `primaryForFile(filePath)`.
- Rewrite each positional method:
    - `definitions(fileUri, position, via?)`: `entry = _routeFileRequest(fileUri, via)`; if undefined return `[]`; else `_fileRequest(entry.server, fileUri, 'textDocument/definition', buildTextDocParams(fileUri, position), [])`.
    - `references(fileUri, position, includeDeclaration = true, via?)`: same pattern.
    - `implementations(fileUri, position, via?)`: same.
    - `hover(fileUri, position, via?)`: same.
    - `documentSymbols(fileUri, via?)`: same.
    - `diagnostics(fileUri, via?)`: resolve via `_routeFileRequest`; if undefined return `[]`; else open + pull diagnostic (existing logic, but against resolved server).
    - `prepareCallHierarchy(fileUri, position, via?)`: same pattern as definitions.
    - `incomingCalls(item, via?)`: if `via` given → `_byName.get(via)` or throw; else `_serverForCallHierarchyItem(item)`. Return `[]` if neither resolves.
    - `outgoingCalls(item, via?)`: same.
    - `raw(lang, method, params, via?)`: if `via` given → `_byName.get(via)` or throw; else `primaryForLang(lang)`. If neither resolves → throw existing error.
- Command: `bun run test` — Step 7 tests green. Full suite green.

### Step 9 — RED + GREEN: `via` coverage for remaining positional methods

- Add one test each to the `via parameter` describe for: `references`, `implementations`, `hover`, `documentSymbols`, `diagnostics`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `raw`. Each test asserts (a) named-via routes to correct candidate, (b) unknown `via` throws.
- If Step 8 was thorough, these pass immediately. Any failure → fix the specific method's signature.
- Command: `bun run test` — all green.

### Step 10 — RED: `manifests?` param scoping on symbolSearch

- File: `src/tests/router.test.ts`. New `describe('Router symbolSearch manifests scoping')`.
- Setup: three entries — `pyright`, `pyright-fork` (both python), `typescript-language-server` (typescript).
- Test "explicit manifests scopes fan-out": `router.symbolSearch('x', undefined, ['pyright-fork'])`; assert only `pyright-fork.workspaceSymbol` called once; others zero calls.
- Test "unknown manifest name is skipped with stderr log": `manifests: ['unknown', 'pyright-fork']`; spy on `process.stderr.write`; assert stderr contains `no manifest named "unknown"`; pyright-fork still called.
- Test "empty manifests array falls through to default fan-out": `manifests: []` behaves identically to `manifests: undefined` (document this in router comment).
- Command: `bun run test -- --testPathPattern=router.test` — expect red (signature mismatch; current `symbolSearch(query, langIds?)` has no third arg).

### Step 11 — RED: default fan-out hits primaries only

- Same describe. Setup: pyright + pyright-fork (both python).
- Test "default fans primaries only": `router.symbolSearch('x')`; assert `pyright.workspaceSymbol` called exactly once; `pyright-fork.workspaceSymbol` NOT called.
- Test "langIds filter + primary-only default": `router.symbolSearch('x', ['python'])`; same assertion.
- Command: `bun run test -- --testPathPattern=router.test` — expect red (current default fans to ALL servers including non-primary candidates).

### Step 12 — GREEN: refactor symbolSearch target selection

- File: `src/router.ts`. Change signature to `async symbolSearch(query, langIds?, manifests?: string[])`.
- New private `_selectSymbolSearchTargets(langIds?, manifests?): ManifestEntry[]`:
    - If `manifests && manifests.length > 0`: for each name, `_byName.get(name)`; on miss, `process.stderr.write('[lsp-mcp] symbol_search: no manifest named "${name}"\n')` and skip. Return the resolved entries in input order (dedupe by manifest name).
    - Else: iterate `_langMap` in insertion order; for each `(langId, {primary})` where `!langIds || langIds.includes(langId)`, resolve primary via `_byName`; dedupe by `entry.manifest.name` across langs.
- Fan-out calls `entry.server.workspaceSymbol(query)` (unchanged semantics); keep `Promise.allSettled` + merge + dedupe logic untouched.
- Command: `bun run test` — Steps 10 + 11 green. Full suite green.

### Step 13 — RED: MCP tool schema + pass-through tests

- File: `src/tests/mcp-server.test.ts`. New `describe('Tool schemas expose via/manifests')`.
- Test "positional tools accept optional via": call `client.listTools()`; for each of `defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`, assert `tool.inputSchema.properties.via` exists and is not in `tool.inputSchema.required`.
- Test "symbol_search accepts optional manifests": assert `tool.inputSchema.properties.manifests` exists (type array, items string), not required.
- Test "via passes through": wire a spy on `router.definitions`; invoke the `defs` tool via client with `via: 'pyright-fork'`; assert spy called with `(file, pos, 'pyright-fork')`. Repeat for one other positional tool (e.g. `refs`) to guard against per-tool regressions.
- Test "manifests passes through": spy on `router.symbolSearch`; invoke `symbol_search` tool with `manifests: ['pyright-fork']`; assert spy called with `(name, undefined, ['pyright-fork'])`.
- Command: `bun run test -- --testPathPattern=mcp-server.test` — expect red on schema property checks.

### Step 14 — GREEN: add via/manifests to MCP tool schemas

- File: `src/mcp-server.ts`. For each positional tool (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`): add `via: z.string().optional().describe('Manifest name to target (overrides primary routing).')` to `inputSchema`. Destructure `via` in handler; forward to the router call. Inline comment: `// R7 (downstream task): replace with z.enum() over active manifest names.`
- For `symbol_search`: add `manifests: z.array(z.string()).optional().describe('Restrict search to specific manifest names (overrides primary-only fan-out).')`. Destructure + forward. Same inline R7 comment.
- Command: `bun run test` — Step 13 tests green. Full suite green.

### Step 15 — GREEN: index.ts bootstrap constructs ManifestEntry[]

- File: `src/index.ts`. Change:
    ```ts
    const servers = manifests.map((m) => new LspServer(m, workspaceRoot, pluginsDir));
    const router = new Router(servers);
    ```
    to:
    ```ts
    const entries: ManifestEntry[] = manifests.map((m) => ({
        manifest: m,
        server: new LspServer(m, workspaceRoot, pluginsDir),
    }));
    const router = new Router(entries);
    ```
- Import `ManifestEntry` type-only from `./router.js`.
- Command: `bun run typecheck` — clean.

### Step 16 — Verify: full suite + build + smoke

- Command: `bun run test 2>&1 | tee /tmp/lspm-z4z-final.log` — all green.
- Command: `bun run build 2>&1 | tee /tmp/lspm-z4z-build.log` — typecheck clean, bun build emits bundled `dist/index.js`.
- Command: `echo '' | node dist/index.js 2>&1 | head -5` — server starts, logs zero-manifest notice, exits cleanly on EOF. No traceback.

### Step 17 — Commit (single scoped commit on `dev`, not pushed)

- `git add src/router.ts src/mcp-server.ts src/index.ts src/tests/router.test.ts src/tests/mcp-server.test.ts src/tests/e2e.test.ts .bones/`
- Commit message (HEREDOC):
    ```
    lspm-z4z: multi-candidate routing + via/manifests params (R4)

    - ManifestEntry + Map<langId, {candidates, primary}> routing model
    - via? threaded through all positional tool handlers
    - manifests? on symbol_search; default fans primaries only
    - MCP tool schemas expose via/manifests (plain string/array;
      R7 dynamic enums deferred to downstream task)
    - 36 test call sites migrated from LspServer[] to ManifestEntry[]
    - Mock factory supports unique manifest names

    Does not implement R3 (PATH probe), R5/R6 (list_languages,
    set_primary), R7 (dynamic enums), R8 (layered discovery),
    R2 (manifest library), R9 (skill content). Those are separate
    Phase 1 tasks.
    ```
- Do NOT push. User reviews before push.

## Success Criteria

- [ ] `ManifestEntry` interface exported from `src/router.ts` with shape `{ manifest: PluginManifest; server: LspServer }`.
- [ ] `Router` constructor signature is `constructor(entries: ManifestEntry[])`; old `LspServer[]` signature removed; no legacy factory shim.
- [ ] Router maintains internal `_langMap: Map<langId, { candidates: ManifestEntry[], primary: string }>`; first-registered candidate becomes primary; deterministic given registration order.
- [ ] Public accessors present: `primaryForLang(langId)`, `candidatesForLang(langId)`, `primaryForFile(filePath)`, `entry(name)`, `get servers()`, `get entries()`.
- [ ] Legacy accessors `serverForFile` / `serverForLang` preserved, delegating to primary lookups.
- [ ] Every positional router method (`definitions`, `references`, `implementations`, `hover`, `documentSymbols`, `diagnostics`, `prepareCallHierarchy`, `incomingCalls`, `outgoingCalls`, `raw`) accepts optional `via?: string`; unknown `via` throws `Error('No manifest named "${via}"')`; omitted `via` preserves primary routing.
- [ ] `router.symbolSearch(query, langIds?, manifests?)` — explicit `manifests` scopes fan-out; unknown name skipped with stderr log; default (no `manifests` or empty array) fans across each langId's primary only, deduped by manifest name.
- [ ] Every positional MCP tool in `src/mcp-server.ts` declares `via?` in its Zod input schema; `symbol_search` declares `manifests?` as optional string array. Handlers forward to the router. Each added schema field has an inline comment deferring dynamic enums to R7.
- [ ] `src/index.ts` constructs a `ManifestEntry[]` and passes it to the Router.
- [ ] `bun run test` — all 66 pre-existing tests + new tests for (a) multi-candidate routing map construction + first-registered primary, (b) `primaryForFile` across candidates, (c) `via` on each of 10 positional methods including unknown-name error path, (d) `manifests` scoping including unknown-name skip + stderr log, (e) default-fans-primaries-only, (f) MCP tool schemas expose `via` / `manifests`, (g) MCP tool arg pass-through behavior.
- [ ] `bun run typecheck` clean; `bun run build` produces a bundled `dist/index.js`.
- [ ] Manual smoke: `echo '' | node dist/index.js` starts, logs zero-manifest notice, exits cleanly without traceback.
- [ ] Single commit on `dev`, not pushed. Commit message references `lspm-z4z` and enumerates out-of-scope R2/R3/R5/R6/R7/R8/R9.

## Anti-Patterns

- **NO PATH probe (R3).** Don't add `which` / `spawnSync` binary availability checks.
- **NO `list_languages` / `set_primary` MCP tools (R5/R6).** Register zero new MCP tools.
- **NO dynamic tool-schema enums (R7).** `via?` / `manifests?` stay plain `z.string()` / `z.array(z.string())` in this task.
- **NO layered manifest discovery (R8).** `src/config.ts` is untouched.
- **NO manifest library content (R2).** Don't create `manifests/*.json` files.
- **NO `sourceKind` on `ManifestEntry`.** R8 task adds it when it has a real discovery source to populate. Partial fields without full pipeline = dead code.
- **NO skill content (R9).** `skills/using-lsp-mcp/SKILL.md` stays at its placeholder.
- **NO silent `via` failure.** Unknown `via` on positional methods throws; unknown entry in `manifests` array stderr-logs + skips (consistent with existing per-server failure handling in symbolSearch).
- **NO `Router.fromServers(LspServer[])` legacy shim.** All test call sites migrate to `ManifestEntry[]` explicitly.
- **NO tests that skip the behavior check in favor of only the schema check.** Tool-schema assertions pair with pass-through behavior assertions (spy on router methods).
- **NO conditional steps ("if the router has X, do Y").** This task pre-verified the codebase — steps are definitive.
- **NO scope creep via "while I'm here" refactors of `LspServer` or `config.ts`.** Touch only router, mcp-server, index, and tests.

## Key Considerations

- **Circular import avoidance.** `ManifestEntry` references both `PluginManifest` (from `types.ts`) and `LspServer` (from `lsp-server.ts`). Since `lsp-server.ts` already imports from `types.ts`, placing `ManifestEntry` in `types.ts` would re-introduce a cycle. Place it in `router.ts` (which already `import type`s both). Export from `router.ts` so callers (`index.ts`, tests) can import.
- **Mock factory name collisions.** Current `makeMockServer` gives every mock `name: 'mock'`. With the new `_byName: Map<string, ManifestEntry>`, two mocks in one Router overwrite each other. Factories in both `router.test.ts` and `mcp-server.test.ts` need an optional `name` arg (or auto-increment) — do this FIRST in Step 1 before any test expansion, to avoid silent test-interference bugs later.
- **`get servers()` backward compatibility.** `mcp-server.ts` calls `router.servers.some(s => s.manifest.capabilities?.callHierarchy === true)` to gate call-hierarchy tool registration. The refactored getter must still return a flat `LspServer[]`. Map from `_entries` at call time — trivial one-liner.
- **`primaryForFile` insertion order.** ES2015+ `Map` preserves insertion order. `_langMap` is built by iterating `_entries` in registration order; candidates appear in the order their manifests were registered. First langMap entry whose primary owns the file wins. Deterministic across Node/Bun.
- **`symbolSearch(query, [], [])` edge case.** Empty `manifests: []` falls through to default (primaries only), matching `manifests: undefined`. Document with a comment on the router method — agents may pass `[]` when "no override" is intended.
- **E2E test subprocess.** `src/tests/e2e.test.ts` spawns a stub LSP via `makeServer(args)`. After the Router refactor, `new Router(entriesFrom([makeServer()]))` must produce identical observable behavior — same symbol_search output shape, same diagnostic paths. Regression in e2e blocks commit.
- **stderr message format.** Existing `symbolSearch` error path writes `[lsp-mcp] symbol_search on ${name} failed: ${message}`. The new unknown-`manifests`-name path writes `[lsp-mcp] symbol_search: no manifest named "${name}"`. Keep the `[lsp-mcp]` prefix consistent.
- **`incomingCalls` / `outgoingCalls` `via` semantics.** These methods currently route via the call-hierarchy item's `uri` field. `via` short-circuits that — when given, ignore the item's uri for routing and use the named manifest. The LSP call payload still carries the full `item` (the target server should know what to do).
- **Test determinism.** Tests that rely on "first-registered is primary" must construct entries in a fixed order. Don't use `Array.sort` on manifests — registration order IS the contract.
- **`bun run test` with jest.** Running individual test files via `--testPathPattern=router.test` works because jest's default regex matches substrings. Use `bun run test` (not direct `jest`) to pick up the `--forceExit` flag from `package.json`.

## Dependencies

- **Blocks:** `lspm-cnq` (Phase 1 sub-epic — this task is parent-of, so closing this advances the sub-epic toward its remaining criteria).
- **Blocked by:** none. Unlocked — `lspm-501` closed; no other prerequisites.
- **Unlocks (downstream tasks, to be scoped after this closes):** R3 (PATH probe), R2 (manifest library), R5+R6 (`list_languages` + `set_primary`), R7 (dynamic schemas), R8 (layered discovery), R9 (`using-lsp-mcp` skill content). These all consume the routing contract this task delivers.

## Log

- [2026-04-17T20:47:57Z] [Seth] Task scoped via writing-plans. Deliberate narrow scope: R4 multi-candidate routing refactor only. Touches src/router.ts, src/mcp-server.ts, src/index.ts + 3 test files (36 call sites migrate from LspServer[] to ManifestEntry[]). Mock factories gain optional name arg to avoid collision under new _byName map. Does NOT implement R2/R3/R5/R6/R7/R8/R9 — 17-step TDD plan with micro-cycles. Next task after close: user decides whether R3 PATH probe or R2 manifest library comes next.
