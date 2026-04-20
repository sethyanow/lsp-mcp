---
id: lspm-4vb
title: R7b — dynamic tool schemas (lang/langs/via/manifests enums from active manifests)
status: open
type: task
priority: 1
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
- `set_primary` uses `z.string().describe(...)` for both `lang` and `manifest` (lines ~140-149).
- Positional file-URI tools (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) all reference the shared `ViaSchema` const.
- `src/tests/mcp-server.test.ts` has `describe('Tool schemas expose via/manifests'...)` at line ~461. Current assertions: `inputSchema.properties.via` defined + optional; `symbol_search.manifests` is `array` of `string`. R7b extends this to assert `enum` values.
- `Router.listLanguages()` returns every (lang, manifest) row including binary_not_found — R7b's schema factory filters by `status === 'ok'` and dedupes langIds.
- `Router.entries` (accessor) exposes all manifest entries in registration order — source for manifest-name enum.
- Test baseline (post R7 close): 223 green across 7 suites.

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

Positional file-URI tools (unchanged pattern, just use factory-derived `ViaSchema`):
- `defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls` — replace module-const `ViaSchema` with factory's `ViaSchema`.

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

### Step 7 — RED: set_primary.lang is an enum of active langIds

Test: `set_primary.inputSchema.properties.lang.enum` contains all active langs; `lang` is in `required`. Same for `manifest` → ok manifest names.

### Step 8 — GREEN: replace set_primary plain z.string() with LangEnum and ManifestEnum

Drop the `.optional()` suffix for these (already required). Preserve the `.describe(...)` text.

### Step 9 — RED: empty router falls back to plain string (no enum)

Fixture: `new Router([])`. `client.listTools()`; for each affected tool, verify enum is UNDEFINED on the relevant property and the schema accepts arbitrary strings.

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

### Step 16 — Smoke via harness

```bash
node scripts/smoke-mcp-tool.mjs list_languages
```
(no change expected — this tool isn't schema-dependent)

Add a new smoke check: print `symbol_search` tool's inputSchema via a one-off script or extend the harness to print tool schemas. Actual command:

```bash
node -e "
import('./dist/index.js').then(async () => {
  // Stdio smoke of listTools — inspect schema shape
});
" 
```

Simpler: extend `scripts/smoke-mcp-tool.mjs` with a `--inspect-schema <tool>` flag OR add a sibling `scripts/smoke-list-tools.mjs` that calls `client.listTools()` and dumps selected tool schemas. Record the observed enum arrays for `symbol_search.langs`, `symbol_search.manifests`, `defs.via`, `set_primary.lang`, `set_primary.manifest` in `bn log lspm-4vb`.

Reusable harness preference per `feedback_prefer_reusable_tooling.md` — lean toward extending `smoke-mcp-tool.mjs` with a flag.

### Step 17 — Full verification

```bash
bun run test > /tmp/lspm-4vb-test.log 2>&1 && tail -15 /tmp/lspm-4vb-test.log
bun run typecheck
bun run build 2>&1 | tail -5
```

Expect 223 baseline + ~10-15 new = ~233-238 green. Typecheck clean. Build succeeds.

### Step 18 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC "MCP tool input schemas built dynamically at startup; `lang` / `langs` / `via` / `manifests` parameters expose enum values reflecting currently-active manifests." from `[ ]` to `[x]` with satisfaction note pointing at `lspm-4vb`.

### Step 19 — Commit + push

Stage `src/mcp-server.ts`, test files, `dist/index.js`, `dist/index.js.map`, `.bones/`, and any new smoke-harness changes. Commit message notes: `buildDynamicSchemas` factory + enum conversion on 4 params + schema-stability under set_primary swap + adversarial battery + R9 still open. Push via bare `git push`.

## Success Criteria

- [ ] `buildDynamicSchemas(router)` factory implemented in `src/mcp-server.ts` (or extracted to `src/schemas.ts` if mcp-server.ts crosses 500 LOC)
- [ ] Factory returns `{LangEnum, LangsSchema, ManifestEnum, ViaSchema, ManifestsSchema}` derived from router state at call time
- [ ] `LangEnum` and `LangsSchema` enum values = active langIds (from `listLanguages()` filtered to `status: 'ok'`, deduped)
- [ ] `ManifestEnum`, `ViaSchema`, `ManifestsSchema` enum values = ok manifest names (from `router.entries` filtered to `status: 'ok'`)
- [ ] Empty router / all-binary_not_found router → schemas fall back to plain `z.string()` (no enum constraint, tool remains callable)
- [ ] `symbol_search.langs` schema items expose `enum` with active langs (regression-tested)
- [ ] `symbol_search.manifests` schema items expose `enum` with ok manifest names; binary_not_found names EXCLUDED (regression-tested)
- [ ] Every positional tool (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) publishes `via.enum` with ok manifest names; `via` stays optional
- [ ] `set_primary.lang` schema is a required enum of active langs
- [ ] `set_primary.manifest` schema is a required enum of ok manifest names (binary_not_found EXCLUDED)
- [ ] Module-scope `ViaSchema` const removed; R7 TODO comments at line ~32 and ~86 deleted
- [ ] Tool schemas are STABLE across `set_primary` swaps — enum values identical before and after (regression-tested; critical anti-pattern lock)
- [ ] Multi-langId manifest contributes all its langIds to the lang enum (no dedupe that drops)
- [ ] Duplicate langIds across two manifests appear once in the lang enum (Set dedupe works)
- [ ] Dense router (20 ok manifests) → enum lists all 20 names, preserves `router.entries` order
- [ ] Single-manifest router → well-formed enum with one value; JSON Schema shape intact
- [ ] 10 sequential `set_primary` swaps → schema enum values unchanged at every step (dense regression lock)
- [ ] 223 baseline tests stay green; new tests land (~10–15 new; target ~233–238)
- [ ] Smoke: inspect `symbol_search` / `defs` / `set_primary` schemas via (extended) `scripts/smoke-mcp-tool.mjs` or sibling script; observed enum arrays recorded in `bn log lspm-4vb`
- [ ] `bun run test` green; `bun run typecheck` clean; `bun run build` succeeds
- [ ] Sub-epic `lspm-cnq` SC "MCP tool input schemas built dynamically at startup..." flipped `[ ]` → `[x]`
- [ ] Single commit on `dev`, pushed via bare `git push`. Commit notes R7b complete; R9 still open

## Anti-Patterns

- **NO schema regen on `set_primary` swap.** Schemas are built once at `createMcpServer` time. `set_primary` mutates primary-pointer, not the manifest/lang membership set. The MCP protocol expects tool schemas to be stable across a session — re-registration would confuse clients and break cached tool descriptions.
- **NO enum on binary_not_found manifests.** The schema advertises what's dispatchable. Binary_not_found names are internal routing metadata; publishing them in the enum would encourage users to call `defs via: "broken-lsp"` and get surprising errors. Filter at the factory.
- **NO module-scope const schemas that depend on router state.** The old `ViaSchema` const lived at module scope but hardcoded `z.string()` — OK then. R7b's `ViaSchema` depends on router state, so it MUST live inside `createMcpServer` (or the factory it calls). Module-scope variants silently capture whichever router was last constructed, which breaks when the server is instantiated multiple times in tests.
- **NO empty-array `z.enum([])`.** Zod throws. Factory must branch on `arr.length === 0` and return plain `z.string()` / array-of-string.
- **NO relaxing the required-ness of `set_primary` params.** `lang` and `manifest` stay required — enum is a type constraint, not an optionality change.
- **NO inlining enum literals at tool-registration sites.** Every enum schema flows through the factory. This keeps the "which tool uses which enum" mapping visible in one place.
- **NO leaking `ManifestEntry` or `LspServer` references via the schema shape.** Schemas return string-typed values only; `ManifestEnum` yields `string`, not `ManifestEntry`.
- **NO pre-optimizing via WeakMap / caching across createMcpServer calls.** Each `createMcpServer` call builds fresh schemas from that call's router. Don't cache across calls — tests build many Routers.

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

Filled in by `adversarial-planning` skill at session start. Starter notes:
- Input Hostility: duplicate langIds across manifests — Set dedupe expected, regression test in Step 15.
- State Corruption: re-registration on set_primary — forbidden, regression test in Step 13.
- Resource Exhaustion: dense 20-manifest router — test in Step 15; zod enum should handle arbitrarily many values.
- Encoding Boundaries: non-ASCII langIds in enum values — zod and JSON Schema preserve strings byte-identically; tests in R6 (`listLanguages`) already cover the underlying data.
- Dependency Treachery: MCP SDK zod-to-JSON-Schema converter version drift — verify at Step 2 that the converter emits `enum` for `z.enum`. Fallback: write a manual JSON Schema builder if the SDK's converter misbehaves (unlikely).

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R7b closes the dynamic-schemas SC bullet)
- **Blocked by:** none — R7 (`lspm-zw9`) closed; router exposes `listLanguages()` and `entries` accessor already
- **Unlocks:** Phase 1 acceptance demo (fresh CC session inspects tool schema to discover active LSPs); R9 using-lsp-mcp skill (skill content references the enum-surfaced discovery UX)
