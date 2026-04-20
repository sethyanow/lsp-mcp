---
id: lspm-4vb
title: R7b — dynamic tool schemas (lang/langs/via/manifests enums from active manifests)
status: closed
type: task
priority: 1
owner: Seth
parent: lspm-cnq
---







## Context

Closes sub-epic `lspm-cnq` SC: *"MCP tool input schemas built dynamically at startup; `lang` / `langs` / `via` / `manifests` parameters expose enum values reflecting currently-active manifests."*

R7 (`lspm-zw9`) shipped `set_primary` with `lang` and `manifest` params as plain `z.string()`. Three other tools (`symbol_search`, the positional file-URI tools, call-hierarchy tools) expose `via`, `langs`, and `manifests` params — all currently `z.string()`-based. R7b converts these to `z.enum(...)` values derived from the router's active manifest set at server-construction time.

Why it matters: with enum values in the published tool schema, MCP clients see the complete list of valid langIds / manifest names without having to call `list_languages` first. It turns the tool surface into a self-documenting directory of active LSPs — the polyglot UX the epic R11 promises. Agents can see at tool-discovery time which LSPs are available on the current box; no wasted probe round-trips.

This task does NOT ship:
- R9 `using-lsp-mcp` skill.
- Fresh-CC-session acceptance demo.
- Runtime re-registration of schemas on `set_primary` swap (parent epic R6 / R7 Key Consideration: "`set_primary` changes the default primary, not enum values — schema stays valid"). Schemas are built once at startup.

## Starting state (verified on branch `dev`, post-`lspm-zw9` commit 8aca216)

- `src/mcp-server.ts` (405 LOC) defines shared schemas at module scope: `PositionSchema`, `FileUriSchema`, `LspParamsSchema`, `ViaSchema`. Two R7-TODO comments mark the enum-upgrade points: line 32 above `ViaSchema`, line 86 above `symbol_search.manifests`.
- `symbol_search` inlines its `langs` and `manifests` schemas (lines ~79-92) as `z.array(z.string()).optional()`.
- `set_primary` uses `z.string().describe(...)` for both `lang` and `manifest` (lines ~150-155, registerTool block at 140-165).
- The `lsp` (raw passthrough) tool uses `z.string().describe(...)` for `lang` at lines ~284-286 (registerTool block at 277-299). REQUIRED param. R7b must enum-ify this too — parent epic R7 says "Every MCP tool with a `lang` or `langs` parameter declares those as an enum." Skeleton author missed this in initial scope.
- Positional file-URI tools (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) all reference the shared `ViaSchema` const for the `via` parameter.
- `src/tests/mcp-server.test.ts` has `describe('Tool schemas expose via/manifests'...)` at line 461 with 5 existing tests (positional via shape, symbol_search.manifests shape, defs forwards via, refs forwards via, symbol_search forwards manifests). Current assertions: `inputSchema.properties.via` defined + optional; `symbol_search.manifests` is `array` of `string`. R7b extends this to assert `enum` values.
- `Router.listLanguages()` returns every (lang, manifest) row including binary_not_found — R7b's schema factory filters by `status === 'ok'` and dedupes langIds.
- `Router.entries` (accessor) exposes all manifest entries in registration order — source for manifest-name enum.
- Test baseline (post R7 close, verified 2026-04-20 fresh `bun run test`): **226 green across 7 suites** (skeleton's original "223" was stale).

## Design

### Schema factory: `buildDynamicSchemas(router)`

New private helper inside `src/mcp-server.ts` (or extracted to `src/schemas.ts` if mcp-server.ts crosses 500 LOC):

```ts
function buildDynamicSchemas(router: Router): {
    LangEnum: z.ZodType<string>;        // required (used by set_primary.lang)
    LangsSchema: z.ZodType<string[] | undefined>;   // optional array (symbol_search.langs)
    ManifestEnum: z.ZodType<string>;    // required (used by set_primary.manifest)
    ViaSchema: z.ZodType<string | undefined>;       // optional (all positional tools)
    ManifestsSchema: z.ZodType<string[] | undefined>;  // optional array (symbol_search.manifests)
}
```

**Enum sources:**
- `LangEnum` / `LangsSchema`: active langIds — derived from `router.listLanguages()` filtered by `status === 'ok'`, then `lang` field deduplicated (use `Set` — order follows first-appearance). Empty list → fallback to `z.string()` without enum constraint.
- `ManifestEnum` / `ViaSchema` / `ManifestsSchema`: ok manifest names — derived from `router.entries.filter(e => e.status === 'ok').map(e => e.manifest.name)`. Empty list → fallback to `z.string()`.

**Zod-enum requirement:** `z.enum([])` throws. Factory must check `arr.length > 0` before using `z.enum(arr as [string, ...string[]])`. Fallback is plain `z.string()` — preserves type contract while removing the enum constraint.

**Immutability contract:** Factory called ONCE inside `createMcpServer(router)` before any `registerTool` calls. `set_primary` mutates `_langMap.primary` but not enum values — the set of active langs and ok manifests is fixed at probe time. Anti-pattern R7: NO schema regen on set_primary swap.

### Tool surface updates

`set_primary` tool:
- `lang: LangEnum` (was `z.string()`)
- `manifest: ManifestEnum` (was `z.string()`)

`symbol_search` tool:
- `langs: LangsSchema` (was inline `z.array(z.string()).optional()`)
- `manifests: ManifestsSchema` (was inline `z.array(z.string()).optional()`)

`lsp` (raw passthrough) tool:
- `lang: LangEnum` (was `z.string()`) — REQUIRED. Same `LangEnum` factory output as `set_primary.lang`. Preserve `.describe('Language ID of the target server (e.g. "python", "typescript")')` text on the resulting schema.

Positional file-URI tools (unchanged pattern, just use factory-derived `ViaSchema`):
- `defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls` — replace module-const `ViaSchema` with factory's `ViaSchema`. (Note: `lsp` appears in BOTH lists — `via` here, `lang` above.)

### Removal of module-level const schemas

Module-scope `ViaSchema` const removed — no longer usable since it depended on runtime router state. `PositionSchema`, `FileUriSchema`, `LspParamsSchema` stay at module scope (they don't depend on router state).

### Design invariants

- **NO re-registration on set_primary.** Schemas built once; swap doesn't mutate the enum values. Keeps MCP protocol compliant (clients expect stable tool schemas per session).
- **NO dropping optional-ness.** `via` / `manifests` / `langs` remain `.optional()`. Only the value constraint shifts from "any string" to "one of these strings."
- **NO enum on empty list.** Empty router (no manifests) or all-binary_not_found → schema falls back to plain `z.string()`. Tool remains callable but without enum UX.
- **NO name leak from router internals.** Only ok manifest names surface — binary_not_found names are not published in the schema (prevents users from calling into dead LSPs by name).
- **NO enum for `set_primary.manifest` that includes binary_not_found.** Consistent with R7 anti-pattern (primary must be dispatchable). Even though the tool would reject binary_not_found at runtime, the schema should not advertise them as valid choices.

## Implementation

### Step 1 — RED: symbol_search.langs schema exposes enum values for active langs

Add to `describe('Tool schemas expose via/manifests' ...)` in `src/tests/mcp-server.test.ts`:

```ts
it('symbol_search.langs is an enum of active langIds', async () => { ... });
```

Fixture: router with 2 ok manifests (python + typescript). `client.listTools()`; find `symbol_search`; assert `inputSchema.properties.langs.items.enum` equals `['python', 'typescript']` (order-insensitive via `expect.arrayContaining`).

Run `bun run test -- --testPathPattern=mcp-server` → expect failure (no enum key in items, or items is generic string).

### Step 2 — GREEN: build LangsSchema from router state, wire into symbol_search

In `src/mcp-server.ts`:
1. Add `buildDynamicSchemas(router)` helper (private to the module).
2. Inside `createMcpServer(router)`, call `const schemas = buildDynamicSchemas(router)` before the first `registerTool` call.
3. Replace `symbol_search.langs`'s inline schema with `schemas.LangsSchema`.
4. The describe/optional wrapper on `LangsSchema` should preserve the original UX copy.

Run → Step 1 passes. REFACTOR-assess.

### Step 3 — RED: symbol_search.manifests schema exposes enum of ok manifest names

Test: manifests schema's `items.enum` equals `[python-manifest, ts-manifest]`. Binary_not_found manifest present in router is EXCLUDED from the enum.

Fixture: router with 2 ok + 1 binary_not_found manifest. Assert only the ok names appear.

### Step 4 — GREEN: wire ManifestsSchema, filter binary_not_found

Factory filters `entries` by `status === 'ok'` before emitting the enum list. Wire `ManifestsSchema` into `symbol_search.manifests`.

### Step 5 — RED: positional tool `via` enum = ok manifest names

Test: for each positional tool (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`), `inputSchema.properties.via.enum` contains all ok manifest names; `via` stays optional (not in `required`).

### Step 6 — GREEN: replace module-const ViaSchema with factory-derived ViaSchema

Remove module-scope `ViaSchema` const. Replace every tool's `via: ViaSchema` with `via: schemas.ViaSchema`. Delete the R7 TODO comment at line 32.

### Step 7 — RED: set_primary.lang and lsp.lang are enums of active langIds

Test (one `it` per tool, both in the same describe block):
1. `set_primary.inputSchema.properties.lang.enum` contains all active langs; `lang` is in `required`. Same for `manifest` → ok manifest names; `manifest` is in `required`.
2. `lsp.inputSchema.properties.lang.enum` contains all active langs; `lang` is in `required`. (Note: `lsp` also publishes `via` enum + has `method`, `params`, `via` properties — only `lang` is the new assertion here.)

Both share the factory's `LangEnum`. Single source-of-truth check: capture `set_primary.lang.enum` and assert `lsp.lang.enum` deep-equals it (no drift between the two consumers).

### Step 8 — GREEN: replace set_primary's and lsp's plain z.string() with LangEnum (and ManifestEnum for set_primary)

In `src/mcp-server.ts`:
1. `set_primary.inputSchema.lang` → `schemas.LangEnum.describe('langId whose primary to swap (e.g. "python", "bazel").')` (drop the `.optional()` suffix — already required; preserve describe text).
2. `set_primary.inputSchema.manifest` → `schemas.ManifestEnum.describe('Name of the candidate manifest to promote to primary.')`.
3. `lsp.inputSchema.lang` → `schemas.LangEnum.describe('Language ID of the target server (e.g. "python", "typescript")')`.

Note: `LangEnum` factory returns either `z.enum(...)` or plain `z.string()` (empty-list fallback) — both support `.describe(...)`. Tests added in Step 7 must pass; baseline `lsp` tests (router routing semantics) stay green.

### Step 8b — Migrate existing R7 negative tests from MCP layer to Router-direct calls

**Why this step exists:** Adversarial planning surfaced that 4 existing test cases pass "unknown" arg values through `client.callTool`, expecting router-level error messages. After enum-ification, Zod intercepts and rejects those values BEFORE the router sees them — the test's expected error message never fires. This is the *correct* new behavior; the test surface is what changes, not the router behavior.

**Affected cases (verified at SRE pass):**
- `src/tests/mcp-server.test.ts:447-458` — `lsp` tool with `lang: 'rust'` (only `python` configured).
- `src/tests/mcp-server.test.ts:754` — `set_primary` with `manifest: 'nope'`.
- `src/tests/mcp-server.test.ts:755` — `set_primary` with `lang: 'cobol'`.
- `src/tests/mcp-server.test.ts:761` — `set_primary` with `manifest: 'pyright-missing'` (binary_not_found).
- (`:757` — `manifest: 'rust-analyzer'` for `lang: 'python'` — SURVIVES; both names ARE in the enum, router catches the cross-dispatch. Leave unchanged.)

**Migration:**
- Move each affected case to a sibling test that calls `Router.setPrimary` / `Router.raw` directly (router unit-test layer). Preserves the router-error-message coverage.
- Add ONE new MCP-layer test asserting that Zod validation rejects out-of-enum values (negative coverage of the enum contract itself). Shape: call `client.callTool({ name: 'set_primary', arguments: { lang: 'cobol', manifest: 'pyright' } })`, assert `result.isError` is true and message matches Zod's validation format (or just shape — don't over-couple to Zod's exact wording, which can drift across versions).

**Verification:** `bun run test -- --testPathPattern=mcp-server` passes; the migrated router-direct tests still cover the original assertions; the new Zod-rejection test covers the enum contract.

### Step 9 — RED: empty router falls back to plain string (no enum)

Fixture: `new Router([])`. `client.listTools()`; for each affected tool that survives empty-router construction (set_primary, symbol_search, lsp, defs/refs/etc are all registered unconditionally; call_hierarchy_* are gated and won't appear), verify enum is UNDEFINED on the relevant property (`langs.items.enum`, `manifests.items.enum`, `via.enum`, `lang.enum`) and the schema accepts arbitrary strings (i.e. plain `type: 'string'` JSON Schema, no `enum` key).

### Step 10 — GREEN: factory returns unrestricted schemas when arrays are empty

Factory checks `arr.length > 0` before constructing `z.enum`. Empty → plain `z.string()` (optionally wrapped per param). Test passes.

### Step 11 — RED: all-binary_not_found router → no enum values in manifest-derived schemas

Fixture: router with 2 binary_not_found manifests. Tool schemas for via/manifests fall back to plain string (no enum). Lang schemas also have no enum (since `_langMap` is empty too — `_buildLangMap` filter).

### Step 12 — GREEN

Factory already handles empty-list fallback. Test should pass without additional code. If it fails, the factory's filter logic has a gap — debug accordingly.

### Step 13 — RED: set_primary swap does NOT alter tool schemas

Fixture: router with 2 ok python manifests (A, B). Before swap, capture `symbol_search.inputSchema.properties.manifests.items.enum` (both names). Call `set_primary` to swap primary from A to B. Re-fetch tool list; assert enum values are IDENTICAL to pre-swap capture.

Locks the invariant: schema enum values reflect the manifest SET, not which is primary. set_primary mutates primary-pointer, not membership.

### Step 14 — REFACTOR-assess

Validate:
- Single call to `buildDynamicSchemas` per `createMcpServer` invocation.
- No enum-array literals inlined at tool-registration sites (all go through factory).
- Factory is testable in isolation (export private for testing if it grows).
- mcp-server.ts LOC did not cross 500 without a modularization decision (if it did, extract factory to `src/schemas.ts`).

### Step 15 — Adversarial battery

Add to `describe('Tool schemas expose via/manifests'...)`:
- **Single-manifest router**: enum is `['only-one']`, well-formed JSON Schema (not accidentally collapsed to non-array).
- **Dense**: 20 ok manifests → enum has all 20 names; ordering matches `router.entries` order.
- **Multi-langId manifest**: one manifest declares `langIds: ['typescript', 'javascript']` — langs enum lists BOTH (no dedupe that drops one).
- **Duplicate langIds across manifests**: two manifests both declare `['python']` — langs enum lists `['python']` once (Set dedupe).
- **Set_primary schema stability under 10 sequential swaps**: call set_primary 10 times in a loop, assert enum values never change (dense regression lock).
- **`lsp.lang` enum equals `set_primary.lang` enum**: same router, fetch both schemas, deep-equal the `enum` arrays. Locks the "single LangEnum source" invariant — prevents drift if a future patch wires one tool to a different factory output.

### Step 16 — Smoke via harness

Per feedback memory `feedback_prefer_reusable_tooling.md`: extend the existing harness, do NOT spawn a sibling script.

**Sub-task 16a** — Extend `scripts/smoke-mcp-tool.mjs` with a `--inspect-schema <tool>` flag:
- Default behavior (positional `<tool>` arg, no flag) stays unchanged: call the tool, print the JSON result.
- New mode: when `--inspect-schema <tool-name>` is passed, the harness calls `client.listTools()`, finds the named tool, and pretty-prints its `inputSchema`. No tool invocation.
- Implementation note: inspect the existing harness shape first (read `scripts/smoke-mcp-tool.mjs` end-to-end) and add the flag in keeping with whatever arg-parsing pattern is already there. Do not introduce a new parser library.

**Pre-step:** Run `bun run build` first so `dist/index.js` reflects R7b source. Skipping this step makes the smoke read pre-R7b schemas and record `enum: undefined` — false negative.

**Sub-task 16b** — Run the smoke and record results in `bn log lspm-4vb`:

```bash
node scripts/smoke-mcp-tool.mjs --inspect-schema symbol_search
node scripts/smoke-mcp-tool.mjs --inspect-schema defs
node scripts/smoke-mcp-tool.mjs --inspect-schema set_primary
node scripts/smoke-mcp-tool.mjs --inspect-schema lsp
```

Record the observed enum arrays for: `symbol_search.langs.items.enum`, `symbol_search.manifests.items.enum`, `defs.via.enum`, `set_primary.lang.enum`, `set_primary.manifest.enum`, `lsp.lang.enum`, `lsp.via.enum`. Also confirm the unchanged `node scripts/smoke-mcp-tool.mjs list_languages` still succeeds (regression check on the original harness behavior).

### Step 17 — Full verification

```bash
bun run test > /tmp/lspm-4vb-test.log 2>&1 && tail -15 /tmp/lspm-4vb-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 226 baseline + ~10-15 new = **~236-241 green**. Typecheck clean. Build succeeds. (Baseline confirmed via fresh `bun run test` at 2026-04-20 SRE pass; pre-R7b was 226 not 223 as initially scoped.)

### Step 18 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "MCP tool input schemas built dynamically at startup; `lang` / `langs` / `via` / `manifests` parameters expose enum values reflecting currently-active manifests." from `[ ]` to `[x]` with satisfaction note pointing at `lspm-4vb`.

### Step 19 — Commit + push

Stage `src/mcp-server.ts`, test files, `dist/index.js`, `dist/index.js.map`, `.bones/`, and any new smoke-harness changes. Commit message notes: `buildDynamicSchemas` factory + enum conversion on 4 params + schema-stability under set_primary swap + adversarial battery + R9 still open. Push via bare `git push`.

## Success Criteria

- [x] `buildDynamicSchemas(router)` factory implemented in `src/mcp-server.ts` (or extracted to `src/schemas.ts` if mcp-server.ts crosses 500 LOC)
- [x] Factory returns `{LangEnum, LangsSchema, ManifestEnum, ViaSchema, ManifestsSchema}` derived from router state at call time
- [x] `LangEnum` and `LangsSchema` enum values = active langIds (from `listLanguages()` filtered to `status: 'ok'`, deduped)
- [x] `ManifestEnum`, `ViaSchema`, `ManifestsSchema` enum values = ok manifest names (from `router.entries` filtered to `status: 'ok'`)
- [x] Empty router / all-binary_not_found router → schemas fall back to plain `z.string()` (no enum constraint, tool remains callable)
- [x] `symbol_search.langs` schema items expose `enum` with active langs (regression-tested)
- [x] `symbol_search.manifests` schema items expose `enum` with ok manifest names; binary_not_found names EXCLUDED (regression-tested)
- [x] Every positional tool (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) publishes `via.enum` with ok manifest names; `via` stays optional
- [x] `set_primary.lang` schema is a required enum of active langs
- [x] `set_primary.manifest` schema is a required enum of ok manifest names (binary_not_found EXCLUDED)
- [x] `lsp.lang` schema is a required enum of active langs (same factory output as `set_primary.lang`; `.describe(...)` text preserved)
- [x] `lsp.lang.enum` deep-equals `set_primary.lang.enum` for the same router (single LangEnum source invariant; regression-locked in adversarial battery)
- [x] Module-scope `ViaSchema` const removed; R7 TODO comments at line ~32 and ~86 deleted
- [x] Tool schemas are STABLE across `set_primary` swaps — enum values identical before and after (regression-tested; critical anti-pattern lock)
- [x] Multi-langId manifest contributes all its langIds to the lang enum (no dedupe that drops)
- [x] Duplicate langIds across two manifests appear once in the lang enum (Set dedupe works)
- [x] Dense router (20 ok manifests) → enum lists all 20 names, preserves `router.entries` order
- [x] Single-manifest router → well-formed enum with one value; JSON Schema shape intact
- [x] 10 sequential `set_primary` swaps → schema enum values unchanged at every step (dense regression lock)
- [x] 226 baseline tests stay green; new tests land (~10–15 new; target ~236–241)
- [x] `scripts/smoke-mcp-tool.mjs` extended with `--inspect-schema <tool>` flag (does not break existing positional usage); observed enum arrays for `symbol_search.langs/manifests`, `defs.via`, `set_primary.lang/manifest`, `lsp.lang/via` recorded in `bn log lspm-4vb`
- [x] Step 8b: 4 existing R7 negative-test cases (mcp-server.test.ts:447, :754, :755, :761) migrated to router-direct calls (router unit-test layer); ONE new MCP-layer test added asserting Zod rejects out-of-enum values (negative enum-contract coverage)
- [x] Empty-router fallback preserves required-vs-optional semantics per param: `set_primary.lang/manifest` and `lsp.lang` stay required; `via` / `langs` / `manifests` stay optional (Step 9 asserts this)
- [x] `bun run test` green; `bun run typecheck` clean; `bun run build` succeeds
- [x] Sub-epic `lspm-cnq` SC "MCP tool input schemas built dynamically at startup..." flipped `[ ]` → `[x]`
- [x] Single commit on `dev`, pushed via bare `git push`. Commit notes R7b complete; R9 still open

## Anti-Patterns

- **NO schema regen on `set_primary` swap.** Schemas are built once at `createMcpServer` time. `set_primary` mutates primary-pointer, not the manifest/lang membership set. The MCP protocol expects tool schemas to be stable across a session — re-registration would confuse clients and break cached tool descriptions.
- **NO enum on binary_not_found manifests.** The schema advertises what's dispatchable. Binary_not_found names are internal routing metadata; publishing them in the enum would encourage users to call `defs via: "broken-lsp"` and get surprising errors. Filter at the factory.
- **NO module-scope const schemas that depend on router state.** The old `ViaSchema` const lived at module scope but hardcoded `z.string()` — OK then. R7b's `ViaSchema` depends on router state, so it MUST live inside `createMcpServer` (or the factory it calls). Module-scope variants silently capture whichever router was last constructed, which breaks when the server is instantiated multiple times in tests.
- **NO empty-array `z.enum([])`.** Zod throws. Factory must branch on `arr.length === 0` and return plain `z.string()` / array-of-string.
- **NO relaxing the required-ness of `set_primary` params.** `lang` and `manifest` stay required — enum is a type constraint, not an optionality change.
- **NO inlining enum literals at tool-registration sites.** Every enum schema flows through the factory. This keeps the "which tool uses which enum" mapping visible in one place.
- **NO leaking `ManifestEntry` or `LspServer` references via the schema shape.** Schemas return string-typed values only; `ManifestEnum` yields `string`, not `ManifestEntry`.
- **NO pre-optimizing via WeakMap / caching across createMcpServer calls.** Each `createMcpServer` call builds fresh schemas from that call's router. Don't cache across calls — tests build many Routers.
- **NO `.sort()` / `.reverse()` on `router.entries` or `router.listLanguages()` results inside the factory.** Both methods return references to internal state (or arrays derived from internal-state ordering) — in-place mutation corrupts router invariants (R5 first-registered-wins tie-break, `_byName` lookup ordering reflected in error messages). Slice (`[...arr]` / `.slice()`) before any reordering. Default behavior preserves `router.entries` order — no sort needed at all per SC.
- **NO designing the enum factory to pass-through unknown values to keep negative tests green.** When existing R7 negative tests break (Zod rejecting unknown lang/manifest before router sees them), the correct fix is to migrate those tests to call the router directly (Step 8b). Designing the enum to admit unknown values defeats the entire R7 promise — clients would see the enum hint but find that any string still works, and the schema becomes advisory in name only.

## Key Considerations

- **MCP protocol schema publication.** When the server advertises a tool via `ListToolsRequestSchema`, the `inputSchema` is serialized as JSON Schema. Zod-to-JSON-Schema conversion emits `enum: [...]` for `z.enum([...])` — relied on by R7b's tests. MCP SDK version (`@modelcontextprotocol/sdk` per `package.json`) should handle this; verify during Step 2.
- **Empty-enum fallback affects tool UX, not correctness.** When schemas fall back to plain `z.string()`, the tool still works — callers just don't see the enum hint. The Router's runtime validation (R5 `_requireByName`, R7 `setPrimary` validations) still rejects unknown names. The enum is advisory, not authoritative.
- **Dedup ordering.** Active langs from `listLanguages()` come in (entry × langIds) order. Using `new Set(arr)` and `Array.from(set)` preserves insertion order in V8 — deterministic output matching registration order. Avoid `.sort()`, which would reorder in ways that the existing listLanguages test suite does NOT depend on (so it's safe) but would obscure the "first-registered wins" ordering that other code relies on.
- **zod enum tuple typing.** `z.enum` requires `[string, ...string[]]` (non-empty tuple). TS-narrow via assertion: `z.enum(names as [string, ...string[]])` after the `names.length > 0` branch. The cast is safe because the length check precedes it.
- **Test fixture portability.** Existing `describe('Tool schemas expose via/manifests'...)` uses `beforeAll` / `afterAll` for a single shared client. R7b's tests can either reuse that pattern OR use per-test `buildClientServer` (costlier but isolates state). Prefer per-test for empty-router and all-missing fixtures (beforeAll would couple them to a single default router).
- **Interaction with R9 `using-lsp-mcp` skill.** R9's skill content will reference the published schema as a discovery mechanism ("agents can see the lang enum to know which LSPs are available"). R7b makes this claim true; R9 documents it. No content overlap in R7b's scope.
- **Future R7c (Phase 2 fork wrappers).** If a fork wrapper registers itself with a new manifest name, the enum values reflect that at next server construction (typically next CC session). No mid-session hot-reload — parent epic contract. R7b doesn't need to anticipate this.
- **MCP schema caching by clients.** Most MCP clients fetch tool lists once per session. The "built once at startup" design aligns with client expectations — no cache invalidation story needed.

### Failure catalog (adversarial planning)

Walked components: factory `buildDynamicSchemas`, lang-enum derivation, manifest-enum derivation, tool-surface wiring, empty-list fallback, module-const removal, test fixtures, smoke harness extension. Categories with no applicable finding for a given component are noted as skipped at the end.

#### `buildDynamicSchemas(router)` factory

**State Corruption: factory accidentally mutates router.entries via in-place sort**
- Assumption: factory reads `router.entries` and `router.listLanguages()` without mutation.
- Betrayal: developer reaches for `router.entries.sort(...)` (or `.reverse()`) to normalize ordering — `Array.prototype.sort` mutates in place.
- Consequence: subsequent `Router.setPrimary` error messages list "Known: ..." in a corrupted order; `_byName` lookup still works but downstream invariants on `_entries` order silently break (R5 first-registered-wins tie-break).
- Mitigation: factory MUST iterate or slice (`[...router.entries]` or `router.entries.slice()`) before any reordering. Default of preserving `router.entries` insertion order — already required by SC "Dense router → preserves `router.entries` order" — needs no sort at all. **Add to anti-patterns: NO `.sort()` on `router.entries` or `router.listLanguages()` results.**

**Dependency Treachery: MCP SDK zod-to-JSON-Schema converter drift**
- Assumption: `@modelcontextprotocol/sdk` emits `enum: [...]` JSON Schema for `z.enum([...])`.
- Betrayal: SDK upgrade changes converter to emit `const`, `oneOf` of literals, or `anyOf`.
- Consequence: assertions on `inputSchema.properties.X.enum` fail; observable behavior may still be correct from the client's perspective but the regression battery breaks.
- Mitigation: Step 2 verifies the converter emits `enum` for `z.enum` empirically before downstream tests are written. If the converter misbehaves, fallback is a manual JSON Schema builder (out of R7b unless triggered).

#### Lang enum + manifest enum derivation

**Input Hostility: duplicate langIds across manifests**
- Assumption: dedupe is required because multi-candidate routing yields multiple `listLanguages()` rows for the same lang.
- Betrayal: naive `.map()` produces duplicates.
- Consequence: zod enum with duplicate values is technically valid but JSON Schema enums lose semantic clarity; some validators warn.
- Mitigation: Set-based dedupe in factory; Step 15 adversarial test "Duplicate langIds across manifests" locks the invariant.

**Encoding Boundaries: empty / whitespace manifest names or langIds**
- Assumption: `PluginManifestSchema` rejects empty strings upstream.
- Betrayal: schema admits `name: ""` or `langIds: ["", "python"]` — factory would publish empty-string enum value, which is valid JSON Schema but breaks UX.
- Consequence: agents see `""` as a callable choice; tools route to "" and fail at runtime.
- Mitigation: out of R7b scope to fix upstream — flag for a future task to verify `PluginManifestSchema` enforces non-empty strings on `name` and `langIds[]`. R7b factory passes strings through verbatim; if upstream tightens later, R7b stays correct.

#### Tool-surface wiring (set_primary, lsp, symbol_search)

**Input Hostility: existing R7 negative tests now fail Zod validation BEFORE reaching the router** — **CRITICAL, IMPLEMENTATION-BLOCKING**
- Assumption: existing tests asserting router-level error messages (`Unknown manifest: nope`, `Unknown lang: cobol`, `binary_not_found`) reach the router unimpeded.
- Betrayal: enum-ified `set_primary.lang` and `set_primary.manifest` (and `lsp.lang`) reject "unknown" values at the MCP schema layer. The router never sees them; the test sees a Zod validation error instead of the router's specific error string.
- Consequence: 4 existing test cases break:
  - `src/tests/mcp-server.test.ts:447-458` — `lsp` tool called with `lang: 'rust'` when only `python` is configured.
  - `src/tests/mcp-server.test.ts:754` — `set_primary` with `manifest: 'nope'` (unknown name).
  - `src/tests/mcp-server.test.ts:755` — `set_primary` with `lang: 'cobol'` (unknown lang).
  - `src/tests/mcp-server.test.ts:761` — `set_primary` with `manifest: 'pyright-missing'` (binary_not_found, EXCLUDED from enum).
  - (`src/tests/mcp-server.test.ts:757` — `set_primary` with `manifest: 'rust-analyzer'` for `lang: 'python'` — SURVIVES because both names ARE in the enum; router catches the cross-dispatch.)
- Mitigation: implementing agent must update these 4 cases to call `Router.setPrimary` / `router.raw` directly (router-unit testing) instead of through MCP. Router-direct tests preserve the runtime-validation invariant being tested without coupling to the MCP schema layer. Rejecting at Zod is the *correct* new behavior — the test surface, not the router behavior, is what changes.
- Anti-pattern lock: do NOT design `LangEnum` or `ManifestEnum` to pass-through unknown values just to keep these MCP tests green. That defeats the point of dynamic enums (clients would see the enum hint but still be allowed to call with unknown values).
- Add Step 8b after Step 8: explicitly migrate the 4 affected cases to Router-direct calls. New regression test should remain at MCP layer asserting that Zod validation rejects out-of-enum values (negative coverage of the enum contract itself).

**State Corruption: schema regen on set_primary**
- Assumption: schemas built once at `createMcpServer` time, immutable for session lifetime.
- Betrayal: a future "smart" optimization tries to re-register tools when primary changes.
- Consequence: MCP clients cache tool schemas at session start; mid-session re-registration silently invalidates client state.
- Mitigation: Step 13 regression test (10 swaps → schemas unchanged); anti-pattern explicit; design invariant — `set_primary` mutates `_langMap.primary` only, not membership.

**Coherence Drift: `lsp.lang` and `set_primary.lang` enum divergence**
- Assumption: both consumers wire to the same `LangEnum` factory output.
- Betrayal: a future patch creates a parallel enum (e.g., `LangEnumForRawLsp`) for one consumer.
- Consequence: enum drift; users see different valid langs depending on which tool's schema they read.
- Mitigation: Step 15 adversarial deep-equal test (`lsp.lang.enum === set_primary.lang.enum`); SC bullet locks the invariant.

#### Empty-list fallback

**State Corruption: empty-list path silently picks wrong fallback**
- Assumption: when `arr.length === 0`, factory returns plain `z.string()` (not `z.string().optional()` for required params, and the right wrapper for optional ones).
- Betrayal: factory branches on length but returns a uniformly-shaped output that doesn't preserve required-vs-optional semantics for each param.
- Consequence: `set_primary.lang` becomes optional in empty-router edge case; tool callable without `lang`, router throws confusing error.
- Mitigation: Factory returns FIVE distinct schemas (LangEnum, LangsSchema, ManifestEnum, ViaSchema, ManifestsSchema) — each with its own optional/required wrapping in BOTH the enum and string-fallback branches. Step 9 RED tests must assert required-ness preserved in the empty-router fallback.

#### Test fixtures

**Temporal Betrayal: shared-router fixtures cross-test pollution**
- Assumption: `beforeAll`-shared router doesn't carry mutated state across tests in the describe block.
- Betrayal: a test invokes `set_primary` to verify swap behavior; a later test in the same block reads the (now-mutated) primary and gets unexpected results.
- Consequence: test order dependency — passes alone, fails in suite.
- Mitigation: Skeleton's Key Considerations already addresses ("Prefer per-test for empty-router and all-missing fixtures"). For the existing `describe('Tool schemas expose via/manifests')` block which uses `beforeAll`, the new R7b tests that invoke `set_primary` (Step 13) MUST use a per-test router via `buildClientServer(new Router([...]))` — not the shared `pyServer`-only router.

#### `scripts/smoke-mcp-tool.mjs --inspect-schema` extension

**Dependency Treachery: smoke runs against stale build**
- Assumption: harness uses fresh `dist/index.js` matching current source.
- Betrayal: agent forgets to `bun run build` before smoke; harness reports pre-R7b schemas (no enums).
- Consequence: agent records observed enums as "no enum present" and falsely concludes R7b regressed.
- Mitigation: Step 16 must explicitly include `bun run build` as a prerequisite. Step 17 already runs build last; bring the build step forward to before Step 16.

**Input Hostility: `--inspect-schema` invoked without tool name**
- Assumption: caller passes a valid tool name after the flag.
- Betrayal: `node scripts/smoke-mcp-tool.mjs --inspect-schema` (no value) — flag-arg parser may consume nothing or crash.
- Consequence: confusing failure mode for whoever runs the smoke later.
- Mitigation: validate flag value present; print one-line usage and exit 1 if not. Hygiene only — not behavior-affecting.

#### Categories skipped (no applicable finding)

- **Resource Exhaustion** (factory): manifest count is bounded by author-controlled discovery (~12 builtin + handful of user-added). 20-manifest dense test at Step 15 covers reasonable upper bound. No defensive cap warranted.
- **Encoding Boundaries** (tool-surface wiring): no transformation between manifest names and schema enum values; bytes pass through.
- **Temporal Betrayal** (factory call ordering): factory must be called BEFORE any `registerTool` — single linear sequence inside `createMcpServer`. No concurrency. No deferred initialization.
- **Resource Exhaustion** (smoke harness): one-shot script, bounded I/O.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R7b closes the dynamic-schemas SC bullet)
- **Blocked by:** none — R7 (`lspm-zw9`) closed; router exposes `listLanguages()` and `entries` accessor already
- **Unlocks:** Phase 1 acceptance demo (fresh CC session inspects tool schema to discover active LSPs); R9 using-lsp-mcp skill (skill content references the enum-surfaced discovery UX)

## Log

- [2026-04-20T08:21:28Z] [Seth] Step 16 smoke (post bun run build, dist/index.js): scripts/smoke-mcp-tool.mjs --inspect-schema observed enums on dev box (12 builtins, 7 ok / 5 binary_not_found): symbol_search.langs.items.enum=[c,cpp,objective-c,objective-cpp,go,python,rust,svelte,typescript,typescriptreact,javascript,javascriptreact,zig] (13 langs); symbol_search.manifests.items.enum=[clangd,gopls,pyright,rust-analyzer,svelte-language-server,typescript-language-server,zls] (7 ok, binary_not_found EXCLUDED); defs.via.enum=same 7 ok manifests; set_primary.lang.enum=same 13 langs (REQUIRED); set_primary.manifest.enum=same 7 ok manifests (REQUIRED, binary_not_found EXCLUDED); lsp.lang.enum=same 13 langs (REQUIRED, deep-equals set_primary.lang.enum); lsp.via.enum=same 7 ok manifests. Original positional invocation 'list_languages' still works (regression check passed).
- [2026-04-20T08:25:17Z] [Seth] Debrief: shipped buildDynamicSchemas factory + 5-tuple + enumOrString helper; wired set_primary.lang/manifest, lsp.lang, all 10 positional via, symbol_search.langs/manifests; module-const ViaSchema removed; both R7 TODOs deleted. Tests 226→243 (+17 net). Smoke harness gained --inspect-schema flag.
Reflections: SRE caught skeleton miss (lsp.lang absent from R7b scope; flagged in starting-state + design + steps + SCs + adversarial). Adversarial planning predicted 4 R7-test breakages; only 1 outer test (3 inner cases) actually broke — the lsp returns-error test still passed because it asserted only isError:true (Zod's rejection satisfies that). Cycle 5/6 RED tests passed first run thanks to enumOrString helper landing in Cycle 2 — design extraction paid forward. Step 14 final REFACTOR caught a misordered doc comment (buildDynamicSchemas's docblock was attached to enumOrString); fixed.
Next task inheritance for Phase 1 remainder (R9 + acceptance demo): MCP tool surface now self-documents active LSPs via JSON Schema enums — R9 skill can teach 'inspect schema before probing'; acceptance demo can lead with --inspect-schema rather than list_languages.
