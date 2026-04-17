---
id: lspm-y5n
title: 'lsp-mcp marketplace: polyglot workspace/symbol that agents reach for over grep'
status: open
type: epic
priority: 1
depends_on: [lspm-cnq, lspm-erd]
---

## Context

Agents in polyglot codebases default to grep when they need cross-language semantic intel because:

1. Claude Code's built-in LSP support is missing `workspace/symbol` entirely — the one LSP verb that doesn't require `(file, line, character)` position counting.
2. Per-language MCPs (pyright-mcp, etc.) solve one language island; cross-language boundaries (Python↔Rust via pyo3, anything↔C via FFI, Zig↔C, gRPC-bound TS↔Go, C# P/Invoke, Lua embedded in C) have no routable tool.
3. `symbol_search` is the keystone verb because it's the entry point for every downstream LSP call — every `defs` / `refs` / `hover` needs an anchor, and agents can't reliably count character positions from Read output. If anchor-finding is missing, the whole LSP chain is broken and the fallback is grep.
4. Stock LSPs botch workspace-scoped operations on cold cache (Pyright's Phase 5 lesson from pyright-mcp). Users have been forking and fixing LSPs specifically to address this; those forks need a distribution path that doesn't require "uninstall to compare."

This epic delivers `lsp-mcp` as a Claude Code plugin marketplace with multi-candidate LSP routing. Phase 1 ships the core plugin + default manifest library over PATH-available LSPs — enough to kill the grep reflex in a polyglot session. Phase 2 ships the fork wrappers, per-project settings, and authoring docs.

**Starting state on this branch (`dev`):** the router TypeScript source already lives at `src/` (router, lsp-server, mcp-server, types, index, tests). This epic adds plugin scaffolding, extends the router with multi-candidate routing, and wires the supporting features that make it installable as a Claude Code plugin and usable outside Claude Code too.

**Toolchain:** bun for package management (`bun install`; `bun.lock` is authoritative). Build via `bun run build` (tsc). Tests via `bun run test` (jest).

## Requirements (IMMUTABLE)

**R1** — Ship a `.claude-plugin/marketplace.json` hosting an `lsp-mcp` core plugin installable via Claude Code's `/plugin install` flow.

**R2** — Core plugin ships default manifests for at minimum: `pyright`, `typescript-language-server`, `gopls`, `rust-analyzer`, `zls`, `clangd`, `lua-language-server`, `elixir-ls`, `svelte-language-server`, `bash-language-server`, `starpls`, `bazel-lsp`. Each is a JSON file declaring binary name, langIds, fileGlobs, workspaceMarkers, capability flags. Additional manifests may be added in implementation tasks without amending this requirement.

**R3** — Router performs a PATH probe of every manifest's `cmd[0]` at startup. Missing binaries do not abort startup; they are registered with `status: "binary_not_found"` and are invisible to routing but visible to `list_languages`.

**R4** — Router supports multiple manifests declaring the same `langId`. Routing model: `Map<langId, {candidates: ManifestEntry[], primary: string}>`. Positional operations (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) route to the lang's primary unless a `via` parameter names a specific manifest. `symbol_search` fans across primaries of all langs by default (or a specified subset via `langs`); a `manifests` parameter scopes fan-out to specific named manifests.

**R5** — Router exposes a `list_languages` MCP tool returning `{lang, manifest, primary: bool, status, capabilities}[]`. Agents use this to discover what's routable without guessing.

**R6** — Router exposes a `set_primary(lang, manifest)` MCP tool for runtime hot-swap of the primary per lang. Change is in-memory only; resets to config default on restart.

**R7** — Every MCP tool with a `lang` or `langs` parameter declares those as an enum over currently active manifest languages. `via` and `manifests` parameters declare enums over currently active manifest names. Schemas are built dynamically at startup from the active manifest set.

**R8** — Router discovers manifests from multiple sources, merged and deduplicated by manifest name (later source wins, conflict logged to stderr):
1. Built-in defaults at `plugins/lsp-mcp/manifests/*.json` (resolved relative to the router's `dist/index.js` location).
2. `$CLAUDE_PLUGIN_ROOT` plugin-tree auto-discovery of `**/lsp-manifest.json`.
3. Classic single-file `LSP_MCP_CONFIG` (preserved from current `src/index.ts` behavior).
4. New `LSP_MCP_MANIFESTS_DIR` environment variable (scans a directory for `*.json` manifests).

**R9** — Core plugin ships `skills/using-lsp-mcp/SKILL.md` teaching agents to reach for `symbol_search` before grep in polyglot contexts, with concrete cross-language examples (Python↔Rust via pyo3, TS↔Go via gRPC, C embedded in anything). Triggers on polyglot analysis, symbol lookup, cross-language refactor queries.

**R10** — `.mcp.json` path resolution must work when the plugin is installed via Claude Code's marketplace caching mechanism. The path from the plugin directory to the router's `dist/index.js` must be verified empirically or via a fallback that places `dist/` inside the plugin directory at release time.

**R11** — Non-CC compatibility: router must function correctly when run outside Claude Code (e.g., from Cursor, custom agents, a bare stdio MCP client) with no `$CLAUDE_PLUGIN_ROOT` set. In that case, discovery falls back to built-in defaults plus whichever env vars the user supplies. No `.claude/`-specific features may be required for baseline operation.

## Success Criteria

- [ ] `.claude-plugin/marketplace.json` exists at repo root and `/plugin marketplace add <this-repo>` succeeds in Claude Code.
- [ ] `/plugin install lsp-mcp` from this marketplace makes the router available as an MCP server in Claude Code.
- [ ] `list_languages` in a CC session reports every default-manifest lang with `status: "ok"` if the binary is on PATH, `status: "binary_not_found"` otherwise.
- [ ] In a real polyglot repo, `symbol_search("SomeSymbol")` returns cross-language hits with correct `(uri, range)` for each. Follow-up `defs` / `refs` using those anchors work without the agent counting positions.
- [ ] Installing two manifests declaring the same lang (e.g., `starpls` and `bazel-lsp`) results in both being spawnable; `list_languages` shows both with one marked `primary: true`. `set_primary` swaps the primary without restart.
- [ ] Router with zero env vars and no `$CLAUDE_PLUGIN_ROOT` (bare stdio) loads built-in defaults, PATH-probes, and serves queries.
- [ ] `bun run test` passes: existing tests + new tests covering multi-candidate routing, PATH probe, `list_languages` shape, `set_primary`, layered discovery merge + dedupe + conflict logging.
- [ ] `skills/using-lsp-mcp/SKILL.md` passes `skill-reviewer` agent review — trigger phrases specific, description third-person, body imperative.
- [ ] Phase 1 demo runs cold (see Phase 1 sub-epic `lspm-cnq`).
- [ ] Phase 2 fork wrappers install and A/B against their stock counterparts without uninstall (see Phase 2 sub-epic `lspm-erd`).

## Anti-Patterns (FORBIDDEN)

- **NO uninstall-to-compare.** (Reason: multi-candidate routing is the whole point of R4/R6. Any workflow requiring uninstall of the default to enable a fork defeats the feature.)
- **NO silent binary-absence.** (Reason: R3 + R5 together are the user-visible story. Silent skipping breaks agent discoverability — the whole reason for `list_languages` is showing what's routable and what's not.)
- **NO static tool-schema enums.** (Reason: R7 requires enums built from active manifests at startup. Hardcoded enums mean fork wrappers and new manifests never appear to CC's tool registry.)
- **NO `.claude/`-only features on the router's critical path.** (Reason: R11. The router must keep working in Cursor, bare MCP clients, etc. Settings via `.local.md` is a CC-path feature; the `LSP_MCP_SETTINGS` env var is the non-CC fallback. Phase 2 lands both; Phase 1 must not regress non-CC baseline.)
- **NO hardcoded 1:1 langId-to-manifest routing.** (Reason: R4. Retrofitting multi-candidate later is a deeper refactor than doing it correctly now.)
- **NO position-counting in agent-facing docs.** (Reason: R9 — the `using-lsp-mcp` skill must frame `symbol_search` as the entry verb precisely because it takes no position. Teaching agents to count characters from Read output perpetuates the failure mode the product exists to solve.)
- **NO fork wrappers that "replace" defaults by shadowing the same name.** (Reason: R4 makes coexistence the first-class path. Fork wrappers add candidates; users pin primary via `set_primary` or settings.)
- **NO bundling an LSP server binary in the core plugin.** (Reason: the core plugin ships manifests and the router only. Binaries come from PATH, or from Phase 2 fork wrappers via `buildHook`. Bundling violates "works with what you have" and bloats the plugin.)
- **NO shipping Phase 1 without Phase 2 on the roadmap.** (Reason: fork wrappers + settings are the observable delivery moment for the audience this product was built for. Phase 1 alone is half the story.)

## Approach

**Multi-candidate routing as the central abstraction.** The router's internal model changes from `Map<langId, LspServer>` to `Map<langId, {candidates: LspServer[], primary: string}>`. Every tool handler gets optional `via?: string` (positional ops) or `manifests?: string[]` (fan-out ops) to target specific candidates. `list_languages` and `set_primary` round out the surface. This makes fork wrappers (Phase 2) essentially free — a fork just registers another manifest under an existing langId, and A/B falls out.

**Layered manifest discovery.** Four sources, merged in priority order, deduped by manifest name. Built-in defaults are the baseline; CC plugin-tree auto-discovery lets fork wrappers register themselves; `LSP_MCP_CONFIG` preserves the contract shipped in the current `src/index.ts`; `LSP_MCP_MANIFESTS_DIR` is the non-CC hook for users who want to drop manifests into a directory. All sources produce `ManifestEntry` objects flowing into the same PATH-probe + routing pipeline.

**Dynamic tool schemas.** MCP tool input schemas are built at startup, not hardcoded. `lang` / `langs` / `via` / `manifests` parameters become JSON Schema enums over the currently-active manifest set. CC's tool registry (and the agent reading it) sees what's actually routable — without this, the agent falls back to string guessing and the grep reflex returns.

## Architecture

**Repo layout:**

```
lsp-mcp/                              # repo = marketplace
├── src/                              # router TypeScript source (already here)
├── dist/                             # committed build output (new: committed)
├── tests/                            # existing tests
├── .claude-plugin/
│   └── marketplace.json              # NEW
├── plugins/
│   └── lsp-mcp/                      # NEW: core plugin subtree
│       ├── .claude-plugin/plugin.json
│       ├── .mcp.json                 # points at dist/index.js (path verified in first task)
│       ├── manifests/
│       │   ├── pyright.json
│       │   ├── typescript.json
│       │   ├── gopls.json
│       │   ├── rust-analyzer.json
│       │   ├── zls.json
│       │   ├── clangd.json
│       │   ├── lua.json
│       │   ├── elixir-ls.json
│       │   ├── svelte.json
│       │   ├── bash.json
│       │   ├── starpls.json
│       │   └── bazel-lsp.json
│       └── skills/
│           └── using-lsp-mcp/SKILL.md
├── package.json                      # existing; scripts invoked via `bun run <name>`
├── bun.lock                          # existing
└── README.md
```

**Data flow at startup:**

```
env vars + $CLAUDE_PLUGIN_ROOT + built-in defaults dir
      │
      ▼
  loadManifests() — glob + parse + dedup by name
      │
      ▼
  pathProbe() — check cmd[0] availability
      │
      ▼
  routingMap: Map<langId, { candidates: ManifestEntry[], primary: string }>
      │
      ▼
  mcpServer = createMcpServer(router) — tool schemas built from routingMap
      │
      ▼
  stdio transport ← MCP client (CC / Cursor / custom)
```

**Tool surface (additions marked NEW):**

| Tool | Params | Behavior |
|---|---|---|
| `symbol_search` | `name`, `kind?`, `langs?`, **NEW** `manifests?` | Fan across primaries (or `manifests` subset); dedupe `(uri, range)` |
| `defs` / `refs` / `impls` / `hover` / `outline` / `diagnostics` | `file`, `pos`, **NEW** `via?` | Route to primary for file's lang, or to `via` manifest |
| `call_hierarchy_prepare` / `incoming_calls` / `outgoing_calls` | (existing), **NEW** `via?` | As above |
| `lsp` | `lang`, `method`, `params`, **NEW** `via?` | Raw passthrough to primary or `via` |
| **NEW** `list_languages` | — | Returns `{lang, manifest, primary, status, capabilities}[]` |
| **NEW** `set_primary` | `lang`, `manifest` | In-memory primary swap |

## Phases

### Phase 1: Core plugin + multi-candidate routing
**Sub-epic:** `lspm-cnq`
**Scope:** R1 through R11 for the core plugin over PATH-available LSPs.
**Gate:**
- `bun run test` → all tests pass (existing + new: multi-candidate routing, PATH probe, `list_languages`, `set_primary`, layered discovery dedupe + conflict logging)
- `node dist/index.js` with no env vars starts cleanly, loads built-in defaults, serves stdio MCP protocol → verified via stdio echo test
- In a CC session with the plugin installed: `/mcp` shows `lsp` server connected, its tool list includes `list_languages` and `set_primary`, and `lang` / `via` / `manifests` params show enum values matching currently-active manifests
- [GATE TBD — marketplace install smoke test command; defined by outcome of first task `lspm-501`'s path-resolution verification]
**Demo:** polyglot symbol trace.
- Open a real polyglot repo in a fresh CC session. Install the lsp-mcp plugin from this marketplace.
- Call `list_languages` → agent sees the subset of defaults that match the box's installed LSPs with `status: "ok"`.
- Call `symbol_search("SomeSymbol")` → returns cross-language hits with `(uri, range)` for each.
- Follow-up `defs` / `refs` using one of those anchors returns correctly without the agent counting character positions.
- Demonstrate `via` pinning a query to one specific manifest; contrast with default primary-routing.
- Demonstrate `binary_not_found`: a lang whose binary isn't installed appears in `list_languages` with that status and is skipped by fan-out.

### Phase 2: Fork wrappers + settings + authoring
**Sub-epic:** `lspm-erd`
**Scope:** Fork wrappers (pyright-fork, zls-fork, markymark) with buildHooks + standalone install scripts + fork-specific skills + CI smoke tests; `.claude/lsp-mcp.local.md` settings + `LSP_MCP_SETTINGS` env + XDG fallback; `authoring-lsp-plugin` skill; `lsp-mcp-settings` skill; `validate-manifest` utility; default manifest library expansion beyond Phase 1 contract.
**Gate:**
- `bun run test` → Phase 2 tests pass (settings parsing, fork buildHook idempotency, `validate-manifest` on every shipped manifest)
- Fork wrappers: CI smoke test starts each fork's buildHook output and hits a trivial LSP request → passes
- `authoring-lsp-plugin` and `lsp-mcp-settings` skills pass `skill-reviewer` review
- [GATE TBD — settings override test: manifest with override applied produces different observable behavior than without]
**Demo:** (PROPOSED — confirm during Phase 2 brainstorming)
- Single CC session, polyglot repo, cold cache.
- Install `pyright-fork` via the marketplace. Both `pyright` (stock from PATH) and `pyright-fork` now live side-by-side.
- Reproduce a cold-cache scenario that stock pyright botches (timeout, partial result, or the specific repro from pyright-mcp Phase 5). Same query via `manifests: ["pyright-fork"]` returns cleanly — observable before/after in one session.
- Write `.claude/lsp-mcp.local.md` pinning `pyright-fork` as primary for Python. Restart CC. Verify `list_languages` now shows the fork as primary without any `via` parameter needed.
- Edit settings to disable `bazel-lsp`. Restart. `list_languages` no longer reports bazel-lsp as active; `starpls` remains.

## Agent Failure Mode Catalog

### Phase 1

| Shortcut | Rationalization | Pre-block |
|---|---|---|
| Hardcode tool schema enums from a fixed lang list | "Dynamic schemas are complex; the list is stable for Phase 1's 12 defaults" | R7 requires dynamic schemas. Anti-pattern names this. Task-level: schema construction test asserts enum values match a runtime-computed set, not a hardcoded one. |
| Ship 1:1 `Map<langId, LspServer>` refactor "for now, multi-candidate later" | "Scope reduction, ship faster, revisit in Phase 2" | R4 is immutable and is the Phase 1 delta over the current router. Without it, Phase 2 fork wrappers have no contract to build against. |
| Skip the PATH probe and let missing binaries fail at spawn time | "LSP servers that don't start log errors anyway; probe is redundant" | R3 requires probe at startup and `binary_not_found` status in `list_languages`. Spawn-time failures are invisible to agents asking `list_languages` upfront. Test: mock a manifest with nonexistent cmd → assert `status: binary_not_found`. |
| Auto-pick primary by alphabetical manifest name | "Deterministic; simpler than first-registered" | Decision: primary defaults to first-registered per source priority. Alphabetical breaks intent (a built-in default should be primary over a later-discovered fork). Test: register default then fork for same lang; primary == default. |
| Skip `via` param on positional tools "to avoid breaking changes" | "Backward compat with current TypeScript API" | Nobody outside this repo consumes the TypeScript router API directly. R4 requires `via` throughout. |
| Implement discovery sources but silently override one with another | "Dedup by name; whichever we saw last wins" | R8 is explicit: later source wins on conflict AND conflict is logged to stderr. Silent override hides behavior. Test: assert stderr on name collision. |
| Use Read + position counting in `using-lsp-mcp` skill examples | "Some operations need position anchors" | R9 + anti-pattern. Skill must start with `symbol_search` (no position), then use the returned `(uri, range)` as anchor for downstream ops. `skill-reviewer` catches position-from-text examples. |
| Skip empirical verification of `${CLAUDE_PLUGIN_ROOT}/../../dist/` path resolution | "It should work by convention" | R10. First Phase 1 task (`lspm-501`) explicitly verifies; if it fails, fall back to copying `dist/` into the plugin dir. Epic contract demands empirical check, not assumption. |

### Phase 2

| Shortcut | Rationalization | Pre-block |
|---|---|---|
| Ship fork wrappers without standalone install scripts | "CC buildHook covers install; non-CC users can figure it out" | R11 + Phase 2 scope. Each fork wrapper must expose install logic as a script callable outside CC. |
| Settings override mechanism that requires router restart after every edit | "Hot-reload is a distraction" | Restart IS acceptable (MCP servers don't hot-reload config); but it must be explicitly documented in the `lsp-mcp-settings` skill. |
| `.local.md` parsing that silently ignores malformed YAML | "Be lenient to user edits" | Malformed settings must log an error to stderr AND fall back to defaults (not silently apply partial overrides). |

## Seam Contracts

### Phase 1 → Phase 2
**Delivers:**
- Multi-candidate routing model (`Map<langId, { candidates, primary }>`)
- `ManifestEntry` type with `sourceKind: "builtin" | "plugin-tree" | "config-file" | "manifests-dir"` so Phase 2 settings can reason about origin when applying overrides
- `list_languages` / `set_primary` tools (Phase 2 settings layer wraps these, doesn't replace them)
- PATH-probe pipeline (Phase 2's `disabled:` list plugs in after probe, before routing-map construction)
- Built-in defaults dir at `plugins/lsp-mcp/manifests/` (Phase 2 fork wrappers register manifests via the plugin-tree auto-discovery path)
- Core `.mcp.json` path-resolution strategy (Phase 2 fork wrapper plugins inherit it)

**Assumes:**
- Phase 2 fork wrappers register LSPs via `lsp-manifest.json` files picked up by R8's plugin-tree auto-discovery — no Phase 1 changes required to accommodate forks.
- Phase 2 settings parsing slots in after R8 discovery and before routing-map construction; it mutates the manifest set (disable, override) but doesn't add discovery sources.
- Phase 2 `validate-manifest` consumes the same `PluginManifestSchema` from `src/types.ts`.

**If wrong:**
- 1:1 routing (R4 violation) → fork wrappers can't coexist, A/B demo is broken, rework cascades through every tool handler.
- `list_languages` missing `primary` / `status` → Phase 2 settings can't reason about state; schema change + all callers rework.
- Fragile `.mcp.json` path resolution → Phase 2 fork wrappers inherit the fragility. First task verifies to prevent.

## Design Rationale

### Problem
Agents fall back to grep in polyglot codebases because no single tool fans `workspace/symbol` across languages, and Claude Code specifically lacks `workspace/symbol` entirely — so positional LSP calls have no anchor-finding step and the chain breaks at the first query. Users who've forked LSPs to fix cold-cache + polyglot rough edges have no ergonomic distribution path; "install to test" requires uninstalling the stock version.

### Research Findings

**Codebase (this branch, `dev`):**
- `src/router.ts` — current routing is 1:1 `langId → server`; the `workspace/symbol` fan-out pattern exists. R4 adds multi-candidate.
- `src/mcp-server.ts` — tool schemas currently hardcoded; R7 makes them startup-dynamic.
- `src/types.ts` — `PluginManifestSchema` via Zod; extend for `via` / `manifests` parameter validation and expose capability flags consistently.
- `src/index.ts` — loads a single `LSP_MCP_CONFIG` file; R8 layers the other sources on top.
- `src/lsp-server.ts` — persistent JSON-RPC bridge; already handles spawn → initialize → warm `didOpen` correctly. Each candidate in a multi-candidate setup is an independent `LspServer` instance; no shared state, no interference.
- Recent commit history on `dev`: `1112f0e` (path absolutization), `476a855` (buildHook stdio + warm-up timeout budget), `a707ff8` (warm-up cache + schema/URI polish), `c06e013` (Copilot review feedback), `1b7b6fe` (cold-cache polling + error propagation). These are the groundwork the Phase 1 changes layer on.

**External:**
- Claude Code marketplace install caches plugins at `~/.claude/plugins/cache/<marketplace>/<plugin>/<hash>/`. Whether this preserves repo-relative paths for `${CLAUDE_PLUGIN_ROOT}/../../` navigation is `[UNVERIFIED — assumption]`; first Phase 1 task (`lspm-501`) verifies empirically or triggers the fallback.
- `workspace/symbol` is universal across mature LSPs, which is why it works as the keystone fan-out verb.
- pyright-mcp's Phase 5 handoff documents cold-cache discipline; `stringPrefilter: true/false` flag maps to that lesson directly.

### Approaches Considered

#### 1. Multi-candidate routing with `via` + `set_primary` (selected)
**Chosen because:** Makes fork wrappers coexist-by-default (R4). Makes A/B a first-class dev workflow — user explicitly called out "uninstall to compare" as unacceptable. `symbol_search` with `manifests?` gives head-to-head without round-tripping through settings. No router restart needed for primary swap. Aligns with "forks are upgrades, not replacements."

#### 2. Fork wrappers as manifest replacement
**Why explored:** Simpler routing model stays 1:1; fork "overrides" the default by matching the same name.
**REJECTED BECAUSE:** Violates core dev workflow — A/B requires uninstalling to compare.
**DO NOT REVISIT UNLESS:** Multi-candidate routing proves infeasible due to LSP server state interference (no evidence; `LspServer` instances are isolated processes).

#### 3. Four-phase breakdown (router → manifests → forks → authoring)
**Why explored:** Initial scope-reduction instinct; each phase was "different content type."
**REJECTED BECAUSE:** Demo moments were fake (unit tests and install flows aren't demos). Most phases were content files with no real risk boundary. User called this out directly during brainstorming.
**DO NOT REVISIT UNLESS:** Phase 1 work splits along a genuine risk seam that makes shipping the whole demo unworkable in one pass.

#### 4. Single-phase epic (all work together)
**Why explored:** Fewest moving pieces.
**REJECTED BECAUSE:** Fork wrappers couple to the router's manifest contract; shipping forks in parallel with core means any contract change forces fork rework. Core-before-forks is a real seam.
**DO NOT REVISIT UNLESS:** Phase 1 completes faster than expected and fork wrappers can piggyback without rework risk.

#### 5. Router as separate npm package + thin plugin shell
**Why explored:** Clean publish story; non-CC users install from a registry.
**REJECTED BECAUSE:** Registry round-trip on every MCP start; version drift between plugin and registry; cloud envs still need network. Committed `dist/` in this repo handles non-CC case via `node /path/to/lsp-mcp/dist/index.js` directly.
**DO NOT REVISIT UNLESS:** A specific user demand emerges for registry-style invocation independent of this marketplace.

#### 6. Bundle LSP server binaries in the core plugin
**Why explored:** "Just works" for users with nothing installed.
**REJECTED BECAUSE:** Bloat (clangd alone is 100+ MB); licensing and platform issues; violates "works with what you have." Fork wrappers in Phase 2 handle "needs this specific build" via `buildHook`.
**DO NOT REVISIT UNLESS:** A specific LSP has zero reasonable PATH-install story AND a fork plugin isn't appropriate.

### Scope Boundaries

**In scope (Phase 1 + 2):**
- Marketplace + core plugin installable in CC
- Multi-candidate routing with A/B capability
- Default manifest library per R2, plus natural expansion in Phase 2
- Non-CC compatibility via env vars (R11)
- Fork wrappers for pyright-fork, zls-fork, markymark (Phase 2)
- Per-project settings via `.local.md` (Phase 2)
- Core agent-facing skill + settings + authoring skills
- Empirical verification of `${CLAUDE_PLUGIN_ROOT}` path resolution

**Out of scope:**
- csharp manifests (no active user need; Phase 2 candidate if adopted later)
- Outer-layer `workspace/symbol` prefilter (cold-cache discipline implemented at router layer); current design relies on manifest `stringPrefilter: true` for servers that prefilter internally (pyright, pyright-fork)
- Bundled LSP server binaries
- Remote/hosted LSP transports
- `list_languages` re-probing at runtime (manifests are fixed post-startup)
- Cross-manifest result merging beyond `(uri, range)` dedupe — agent drives any "show where pyright and pyright-fork disagree" workflow via two explicit `manifests`-scoped queries

### Open Questions

- `${CLAUDE_PLUGIN_ROOT}/../../dist/` path resolution under CC marketplace cache — `lspm-501` resolves empirically.
- Starlark lang ID coherence between `starpls` and `bazel-lsp`: LSPs may declare different langIds. Multi-candidate routing requires shared canonical langId or a normalization step; verify during the bazel-manifest task.
- `csharp-ls` vs Roslyn `Microsoft.CodeAnalysis.LanguageServer` — deferred to Phase 2 per user decision.

## Design Discovery

### Key Decisions Made

| Question | Answer | Implication |
|---|---|---|
| Marketplace topology | Single repo, LSP-only scope | Repo root IS the marketplace; forks stay in their own repos, referenced via `buildHook` |
| Router distribution | Prebuilt `dist/` committed to repo | CI release must build-then-commit; zero install step in plugin; cloud-safe |
| Config discovery | Layered: built-in + plugin-tree auto-discovery + `LSP_MCP_CONFIG` + `LSP_MCP_MANIFESTS_DIR` | Belt-and-suspenders for CC + non-CC |
| Repo layout | `src/` and `dist/` at repo root; plugin subdir references via `${CLAUDE_PLUGIN_ROOT}/../../dist/` (path verified by first task) | Router remains a first-class project; non-CC users invoke `dist/` directly |
| Disable mechanism | `.claude/lsp-mcp.local.md` (CC) + `LSP_MCP_SETTINGS` env (non-CC) + XDG fallback | Phase 2 feature. Phase 1 doesn't need disable; don't install a manifest you don't want or don't install its binary. |
| Phase 1 default manifests | pyright, tsserver, gopls, rust-analyzer, zls, clangd, lua, elixir-ls, svelte, bash, starpls, bazel-lsp | Manifests are config data; contract fixes minimum, additions are task-level |
| csharp | Push to Phase 2 | No active user need |
| bazel | Ship both `starpls` + `bazel-lsp` in Phase 1 as the A/B exemplar | Forces multi-candidate routing to prove itself on real need |
| Multi-candidate routing | First-class feature | R4/R5/R6/R7; makes fork wrappers coexist-by-default |
| `symbol_search` fan-out default | Primaries only; `manifests?` for explicit candidate scoping | Prevents duplicate-ish results when multiple candidates share a lang |
| Primary-selection default | First-registered (deterministic given fixed plugin tree) | Built-in defaults beat later-discovered forks; user overrides via settings or `set_primary` |
| Phase count | Two phases anchored on real demos | Phase 1 = core product (polyglot symbol trace); Phase 2 = fork wrappers + settings + authoring |
| Package manager | bun (`bun.lock` is authoritative) | All install / dep management via bun |
| Script invocation | `bun run test` (jest) and `bun run build` (tsc) | Invokes the `package.json` scripts via bun's script runner |

### Dead-End Paths

- **Four-phase breakdown** (router / manifests / forks / authoring): artificial scope theatre; most "phases" were content files. Demos were verification commands, not demonstrations.
- **Fork wrappers as overrides that replace stock manifests**: would have required uninstall-to-compare, which is explicitly the user pain this product exists to solve.
- **Publish manifests as standalone npm packages**: package sprawl; no discoverability win over bundled defaults + plugin-tree auto-discovery.
- **Separate repos for router and marketplace**: two version streams, coupled releases, more coordination overhead, no user-visible benefit.

### Open Concerns

- **`${CLAUDE_PLUGIN_ROOT}` path resolution to repo-root `dist/`**: `[UNVERIFIED — assumption]`. First Phase 1 task (`lspm-501`) includes empirical verification; fallback is release-time copy of `dist/` into the plugin dir. Single concrete unknown that could force a layout change.
- **Bazel LSP langId coherence**: `starpls` and `bazel-lsp` may declare different langIds. Multi-candidate routing needs either per-manifest langId normalization or manifests declaring a shared canonical langId. Phase 1 bazel manifest task verifies.
- **LSP server process multiplication**: N candidates per lang = N processes when all active. Lazy spawn (current `LspServer` behavior) keeps dormant candidates at zero cost. Active A/B doubles memory for one language; acceptable given the explicit user need.
