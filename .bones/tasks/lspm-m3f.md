---
id: lspm-m3f
title: 'lsp-mcp marketplace: polyglot workspace/symbol that agents reach for over grep'
status: open
type: epic
priority: 1
depends_on: [lspm-cps, lspm-eue]
---





## Context

Agents in polyglot codebases default to grep when they need cross-language semantic intel because:
1. Claude Code's built-in LSP support is missing `workspace/symbol` entirely — the one LSP verb that doesn't require `(file, line, character)` position counting.
2. Per-language MCPs (pyright-mcp, etc.) solve one island; cross-language boundaries (Python↔Rust via pyo3, anything↔C via FFI, Zig↔C, gRPC-bound TS↔Go, C# P/Invoke, Lua embedded in C) have no routable tool.
3. `symbol_search` is the keystone verb because it's the entry point for every downstream LSP call — every `defs`/`refs`/`hover` needs an anchor, and agents can't reliably count character positions. If anchor-finding is missing, the whole LSP chain is broken and the fallback is grep.
4. Stock LSPs botch workspace-scoped operations on cold cache (Pyright's Phase 5 lesson from pyright-mcp). Users have been forking and fixing LSPs specifically to address this; those forks need a distribution path that doesn't require "uninstall to compare."

This epic delivers `lsp-mcp` as a Claude Code plugin marketplace with multi-candidate LSP routing. Phase 1 ships the core plugin + default manifest library over PATH-available LSPs — enough to kill the grep reflex in a polyglot session. Phase 2 ships the fork wrappers, per-project settings, and authoring docs.

The underlying TypeScript router already exists (merged PR #1 on `main`). This epic adds plugin scaffolding, the multi-candidate routing model, and the supporting features that make it installable and usable.

## Requirements (IMMUTABLE)

**R1** — Ship a `.claude-plugin/marketplace.json` hosting a `lsp-mcp` core plugin installable via Claude Code's `/plugin install` flow.

**R2** — Core plugin ships default manifests for at minimum: `pyright`, `typescript-language-server`, `gopls`, `rust-analyzer`, `zls`, `clangd`, `lua-language-server`, `elixir-ls`, `svelte-language-server`, `bash-language-server`, `starpls`, `bazel-lsp`. Each is a JSON file declaring binary name, langIds, fileGlobs, workspaceMarkers, capability flags. Additional manifests may be added in implementation tasks without amending this requirement.

**R3** — Router performs a PATH probe of every manifest's `cmd[0]` at startup. Missing binaries do not abort startup; they are registered with `status: "binary_not_found"` and are invisible to routing but visible to `list_languages`.

**R4** — Router supports multiple manifests declaring the same `langId`. Routing model: `Map<langId, {candidates: ManifestEntry[], primary: string}>`. Positional operations (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`) route to the lang's primary unless a `via` parameter names a specific manifest. `symbol_search` fans across primaries of all langs by default (or a specified subset via `langs`); `manifests` parameter scopes fan-out to specific named manifests.

**R5** — Router exposes a `list_languages` MCP tool returning `{lang, manifest, primary: bool, status, capabilities}[]`. Agents use this to discover what's routable without guessing.

**R6** — Router exposes a `set_primary(lang, manifest)` MCP tool for runtime hot-swap of the primary per lang. Change is in-memory only; resets to config default on restart.

**R7** — Every MCP tool with a `lang` or `langs` parameter declares those as an enum over currently active manifest languages. `via` and `manifests` parameters declare enums over currently active manifest names. Schemas are built dynamically at startup from the active manifest set.

**R8** — Router discovers manifests from multiple sources, merged and deduplicated by manifest name (later source wins, conflict logged to stderr):
1. Built-in defaults at `<repo>/plugins/lsp-mcp/manifests/*.json`
2. `$CLAUDE_PLUGIN_ROOT` plugin-tree auto-discovery of `**/lsp-manifest.json` (relative to whichever plugin dir the router is installed in)
3. Classic single-file `LSP_MCP_CONFIG` (preserved for backward compat with PR #1 behavior)
4. New `LSP_MCP_MANIFESTS_DIR` environment variable (scan a dir for `*.json` manifests)

**R9** — Core plugin ships `skills/using-lsp-mcp/SKILL.md` teaching agents to reach for `symbol_search` before grep in polyglot contexts, with concrete cross-language examples (Python↔Rust via pyo3, TS↔Go via gRPC, C embedded in anything). Triggers on polyglot analysis, symbol lookup, cross-language refactor queries.

**R10** — `.mcp.json` path resolution must work when the plugin is installed via Claude Code's marketplace caching mechanism. The path from the plugin dir to the router's `dist/index.js` must be verified empirically or via a fallback that copies/symlinks `dist/` into the plugin dir at release time.

**R11** — Non-CC compatibility: router must function correctly when run outside Claude Code (e.g., from Cursor, custom agents, a bare stdio MCP client) with no `$CLAUDE_PLUGIN_ROOT` set. In that case, discovery falls back to built-in defaults plus whichever env vars the user supplies. No `.claude/`-specific features may be required for baseline operation.

## Success Criteria

- [ ] `.claude-plugin/marketplace.json` exists at repo root and `/plugin marketplace add <this-repo>` succeeds in Claude Code.
- [ ] `/plugin install lsp-mcp` from this marketplace makes the router available as an MCP server in Claude Code.
- [ ] `list_languages` in a CC session reports every default-manifest lang with `status: "ok"` if the binary is on PATH, `status: "binary_not_found"` otherwise.
- [ ] In a real polyglot repo, `symbol_search("SomeSymbol")` returns cross-language hits with correct `(uri, range)` for each. Follow-up `defs`/`refs` using those anchors work without the agent counting positions.
- [ ] Installing two manifests declaring the same lang (e.g., `starpls` and `bazel-lsp`) results in both being spawnable; `list_languages` shows both with one marked `primary: true`. `set_primary` swaps the primary without restart.
- [ ] Router with zero env vars and no `$CLAUDE_PLUGIN_ROOT` (bare stdio) loads built-in defaults, PATH-probes, and serves queries.
- [ ] All pre-existing PR #1 tests pass; new tests cover multi-candidate routing, PATH probe, `list_languages` shape, `set_primary`, layered discovery dedupe.
- [ ] `skills/using-lsp-mcp/SKILL.md` passes `skill-reviewer` agent review — trigger phrases specific, description third-person, body imperative.
- [ ] Phase 1 demo runs cold (see `Demo:` under Phase 1).
- [ ] Phase 2 fork wrappers install and A/B against their stock counterparts without uninstall.

## Anti-Patterns (FORBIDDEN)

- **NO uninstall-to-compare.** (Reason: the whole point of multi-candidate routing is side-by-side A/B. Any workflow requiring uninstall of the default to enable a fork invalidates R4/R6.)
- **NO silent binary-absence.** (Reason: PATH probe must report `binary_not_found` via `list_languages`. Silent skipping breaks agent discoverability — R3 + R5 together are the user-visible story.)
- **NO static tool-schema enums.** (Reason: R7 requires enums built from active manifests at startup. Hardcoded enums mean fork wrappers and new manifests don't appear to CC's tool registry.)
- **NO `.claude/`-only features on the router's critical path.** (Reason: R11. The router must keep working in Cursor, bare MCP clients, etc. Settings/override via `.local.md` is a CC-path feature — the `LSP_MCP_SETTINGS` env var is the non-CC fallback. Phase 2 lands this; Phase 1 doesn't regress on non-CC.)
- **NO hardcoded 1:1 langId-to-manifest routing.** (Reason: R4. The routing map must be multi-candidate from the start. Retrofitting later is a deeper refactor than doing it correctly now.)
- **NO position-counting in agent-facing docs.** (Reason: R9 — the `using-lsp-mcp` skill must frame `symbol_search` as the entry verb precisely because it takes no position. Teaching agents to count characters from Read output perpetuates the failure mode.)
- **NO fork wrappers that "replace" defaults via uninstall-the-stock.** (Reason: R4 makes coexistence the first-class path. Fork wrappers just add a candidate; user sets primary via `set_primary` or settings.)
- **NO bundling an LSP server binary in the core plugin.** (Reason: the core plugin ships manifests and the router only. Binaries come from PATH, or from Phase 2 fork wrappers via buildHook. Bundling violates the "works with what you have" promise and bloats the plugin.)
- **NO "skip Phase 2, ship partial." (Reason: fork wrappers + settings are the observable delivery moment for users who've been forking LSPs — the audience this product was built for. Phase 1 alone is half the story.)

## Approach

**Multi-candidate routing as the central abstraction.** The router's internal model changes from `Map<langId, LspServer>` to `Map<langId, {candidates: LspServer[], primary: string}>`. Every tool handler gets optional `via?: string` (positional ops) or `manifests?: string[]` (fan-out ops) to target specific candidates. `list_languages` and `set_primary` round out the surface. This makes fork wrappers (Phase 2) essentially free — a fork just registers another manifest under an existing langId; A/B falls out.

**Layered manifest discovery.** Four sources, merged in priority order, deduped by manifest name. Built-in defaults are the baseline; CC plugin-tree auto-discovery lets fork wrappers register themselves; `LSP_MCP_CONFIG` preserves the PR #1 contract for existing users; `LSP_MCP_MANIFESTS_DIR` is the non-CC hook for users who want to drop manifests into a directory. All sources produce `ManifestEntry` objects that flow into the same PATH-probe + routing pipeline.

**Dynamic tool schemas.** MCP tool input schemas are built at startup, not hardcoded. `lang` / `langs` / `via` / `manifests` parameters become JSON Schema enums over the currently-active manifest set. This is what makes CC's tool registry (and the agent reading it) aware of what's actually routable — without it, the agent falls back to string guessing and the grep reflex returns.

## Architecture

**Repo layout (unchanged from PR #1 at root):**
```
lsp-mcp/
├── src/                              # router TypeScript source (existing)
├── dist/                             # committed build output (new: committed)
├── tests/
├── .claude-plugin/
│   └── marketplace.json              # NEW: marketplace manifest
├── plugins/
│   └── lsp-mcp/                      # NEW: core plugin subtree
│       ├── .claude-plugin/plugin.json
│       ├── .mcp.json                 # → ${CLAUDE_PLUGIN_ROOT}/../../dist/index.js
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
├── package.json                      # existing
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

**Tool surface (Phase 1 additions marked NEW):**
| Tool | Params | Behavior |
|---|---|---|
| `symbol_search` | `name`, `kind?`, `langs?`, **NEW** `manifests?` | Fan across primaries (or `manifests` subset); dedupe `(uri, range)` |
| `defs`/`refs`/`impls`/`hover`/`outline`/`diagnostics` | `file`, `pos`, **NEW** `via?` | Route to primary for file's lang, or to `via` manifest |
| `call_hierarchy_prepare`/`incoming_calls`/`outgoing_calls` | (existing), **NEW** `via?` | As above |
| `lsp` | `lang`, `method`, `params`, **NEW** `via?` | Raw passthrough to primary or `via` |
| **NEW** `list_languages` | — | Returns `{lang, manifest, primary, status, capabilities}[]` |
| **NEW** `set_primary` | `lang`, `manifest` | In-memory primary swap |

## Phases

### Phase 1: Core plugin + multi-candidate routing
**Scope:** R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11 — everything that delivers the "agents reach for LSP over grep" story with PATH-available LSPs.
**Gate:**
- `npm test` → all tests pass (existing + new: multi-candidate routing, PATH probe, list_languages, set_primary, layered discovery dedupe)
- `node dist/index.js` with no env vars starts cleanly, loads built-in defaults, serves stdio MCP protocol → verified via stdio echo test
- In a CC session with the plugin installed: `/mcp` shows `lsp` server connected, its tool list includes `list_languages` and `set_primary`, and `lang`/`via`/`manifests` params show enum values matching currently-active manifests
- [GATE TBD — marketplace install smoke test command; depends on verifying CC cache path behavior in task 1]
**Demo:** (captured from brainstorming — "Demo A: polyglot symbol trace")
- Open a real polyglot repo in a fresh CC session. Install the lsp-mcp plugin from this marketplace.
- Call `list_languages` → agent sees the subset of defaults that match the box's installed LSPs with `status: "ok"`.
- Call `symbol_search("SomeSymbol")` → returns cross-language hits with `(uri, range)` for each.
- Follow-up `defs`/`refs` using one of those anchors returns correctly without the agent counting character positions.
- Show a deliberate `via` call pinning a query to one specific manifest; contrast with the default primary-routing.
- Show a `binary_not_found` case — a lang whose binary isn't installed appears in `list_languages` with that status and is skipped by fan-out.

### Phase 2: Fork wrappers + settings + authoring
**Scope:** Fork wrappers (pyright-fork, zls-fork, markymark) with buildHooks + standalone install scripts + fork-specific skills + CI smoke tests; `.claude/lsp-mcp.local.md` settings (disable, overrides, per-project primary); `authoring-lsp-plugin` skill; `lsp-mcp-settings` skill; `validate-manifest` utility; default manifest library expansion beyond Phase 1 contract.
**Gate:**
- `npm test` → all Phase 2 tests pass (settings parsing, fork buildHook idempotency, validate-manifest on every shipped manifest)
- Fork wrappers: CI smoke test starts each fork's buildHook output and hits a trivial LSP request → passes
- `authoring-lsp-plugin` and `lsp-mcp-settings` skills pass `skill-reviewer` review
- [GATE TBD — settings override test: manifest with override applied produces different behavior than without]
**Demo:** (PROPOSED — confirm during Phase 2 brainstorming)
- Single CC session, polyglot repo, cold cache.
- Install `pyright-fork` via the marketplace. Both `pyright` (stock from PATH) and `pyright-fork` now live side-by-side.
- Reproduce the stock-pyright cold-cache failure mode (workspace/symbol timeout or partial result). Same query via `manifests: ["pyright-fork"]` returns cleanly — observable before/after in one session.
- Write `.claude/lsp-mcp.local.md` pinning `pyright-fork` as primary for Python. Restart CC. Verify `list_languages` now shows fork as primary without any `via` parameter needed.
- Edit settings to disable `bazel-lsp`. Restart. `list_languages` no longer reports bazel-lsp as active; `starpls` remains.

## Agent Failure Mode Catalog

### Phase 1

| Shortcut | Rationalization | Pre-block |
|---|---|---|
| Hardcode tool schema enums from a fixed lang list | "Dynamic schemas are complex; the list is stable for Phase 1's 12 defaults" | R7 states dynamic schemas are required. Anti-pattern names this explicitly. Task-level: schema construction test asserts enum values match a runtime-computed set, not a hardcoded one. |
| Ship the 1:1 `Map<langId, LspServer>` refactor "for now, multi-candidate later" | "Scope reduction, ship faster, revisit in Phase 2" | R4 is immutable and makes Phase 1's fork-wrapper-friendly contract. Multi-candidate routing IS the Phase 1 delta over PR #1 code. Anti-pattern names this. |
| Skip the PATH probe and let missing binaries fail at spawn time | "LSP servers that don't start log errors anyway; the probe is redundant" | R3 requires probe at startup and `binary_not_found` status in `list_languages`. Spawn-time failures are invisible to agents asking `list_languages` upfront. Test: mock a manifest with nonexistent cmd → assert `status: binary_not_found`. |
| Auto-pick primary by alphabetical manifest name | "Deterministic; simpler than first-registered" | R4 + decision note: primary defaults to first-registered. Alphabetical breaks intent (built-in default should be primary over a later-discovered fork). Test: register default then fork for same lang; primary == default. |
| Skip the `via` param on existing positional tools "to avoid breaking changes" | "Backward compat with PR #1 callers" | PR #1 just merged; no external callers of the ts API yet. R4 requires `via` throughout. Anti-pattern names silent no-op for `via` on tools. |
| Implement discovery sources but make one source silently override another | "Dedup by name; whichever we saw last wins" | R8 is explicit: later source wins on conflict AND conflict is logged to stderr. Silent override hides behavior from user. Test: asserts stderr on name collision. |
| Use Read + position counting in `using-lsp-mcp` skill examples | "Some operations require position anchors" | R9 + anti-pattern. Skill must start with `symbol_search` (no position), then use returned `(uri, range)` as anchor for downstream ops. Skill-reviewer agent catches position-from-text examples. |
| Skip empirical verification of `${CLAUDE_PLUGIN_ROOT}/../../dist/` path resolution | "It should work by convention" | R10. First Phase 1 task explicitly includes the verification; if it fails, we fall back to copying `dist/` into the plugin dir at release time. The epic contract demands empirical check, not assumption. |

### Phase 2

| Shortcut | Rationalization | Pre-block |
|---|---|---|
| Ship fork wrappers without standalone install scripts | "CC buildHook covers the install path; non-CC users can figure it out" | R11 + Phase 2 scope. Each fork wrapper must expose its install logic as a script callable outside CC. Explicit in phase scope. |
| Settings override mechanism that requires router restart after every edit | "Hot-reload is a distraction" | Settings file change SHOULD require restart (MCP servers don't hot-reload config); this is fine. Anti-pattern: if restart is needed, settings file must document that clearly in the `lsp-mcp-settings` skill. |
| `.local.md` parsing that silently ignores malformed YAML | "Be lenient to user edits" | Malformed settings must log an error to stderr AND fall back to defaults (not silently apply partial overrides). |

## Seam Contracts

### Phase 1 → Phase 2
**Delivers:**
- Multi-candidate routing model (`Map<langId, { candidates, primary }>`)
- `ManifestEntry` type with `sourceSource: "builtin" | "plugin-tree" | "config-file" | "manifests-dir"` so Phase 2 settings can reason about origin when applying overrides
- `list_languages` / `set_primary` tools (settings layer in Phase 2 wraps these, doesn't replace them)
- PATH-probe pipeline (settings `disabled:` list plugs in after probe, before routing map construction)
- Built-in defaults dir at `plugins/lsp-mcp/manifests/` (fork wrappers in Phase 2 register manifests via the plugin-tree auto-discovery path)
- Core `.mcp.json` path-resolution strategy (fork wrapper plugins inherit the same strategy)

**Assumes:**
- Phase 2 fork wrappers register their LSPs via `lsp-manifest.json` files picked up by R8's plugin-tree auto-discovery — no Phase 1 changes required to accommodate forks.
- Phase 2 `.local.md` parsing slots in after R8 discovery and before routing-map construction; it mutates the manifest set (disable, override) but doesn't add new discovery sources.
- Phase 2 `validate-manifest` tool consumes the same `PluginManifestSchema` from `src/types.ts`.

**If wrong:**
- If the routing model ships 1:1 (R4 violation), Phase 2 fork wrappers can't coexist and the A/B demo is broken. Rework cascades through every tool handler.
- If `list_languages` shape omits `primary` / `status`, Phase 2 settings UI can't reason about state and `authoring-lsp-plugin` skill can't teach manifest authors how their work will appear. Rework is a schema change + all callers.
- If `.mcp.json` path resolution is fragile, Phase 2 fork wrappers inherit the same fragility. Verifying in Phase 1 prevents this.

## Design Rationale

### Problem
Agents fall back to grep in polyglot codebases because no single tool fans `workspace/symbol` across the languages present; CC specifically lacks workspace/symbol support, so positional LSP calls have no anchor-finding step and the chain breaks at the first query. Users who've been forking LSPs to fix cold-cache + polyglot issues have no ergonomic distribution path — "install to test" requires uninstalling the stock version.

### Research Findings

**Codebase:**
- `src/router.ts` (in PR #1 / `main` branch) — current routing is 1:1 `langId → server`; fan-out for `workspace/symbol` already exists in pattern but needs `manifests?` param added.
- `src/mcp-server.ts` — tool schemas currently hardcoded; dynamic-at-startup is the R7 delta.
- `src/types.ts` — `PluginManifestSchema` via Zod; needs extension for capability flags like `stringPrefilter` per-method (already partially present).
- `src/index.ts` — loads single `LSP_MCP_CONFIG` file; needs layered discovery per R8.
- `src/lsp-server.ts` — persistent JSON-RPC bridge; already handles spawn / initialize / warm `didOpen` lifecycle correctly for multi-candidate use (each candidate is a separate `LspServer` instance, no shared state).

**External:**
- Claude Code marketplace install behavior caches plugins at `~/.claude/plugins/cache/<marketplace>/<plugin>/<hash>/` — whether this preserves repo-relative paths for `${CLAUDE_PLUGIN_ROOT}/../../` navigation is `[UNVERIFIED — assumption]` and Phase 1 task 1 verifies empirically or triggers fallback.
- `workspace/symbol` is universal across mature LSPs, which is why it works as the keystone fan-out verb.
- pyright-mcp's Phase 5 handoff documents cold-cache discipline in detail — `stringPrefilter: true/false` flag directly maps to that lesson.

### Approaches Considered

#### 1. Multi-candidate routing with `via` + `set_primary` (selected)
**Chosen because:** Makes fork wrappers coexist-by-default (R4). Makes A/B a first-class dev workflow from the start (user's core pain: "uninstall to compare" is unacceptable). `symbol_search` with `manifests?` param gives head-to-head without round-tripping through settings. No router restart needed for primary swap. Aligns with the "forks are upgrades, not replacements" framing.

#### 2. Fork wrappers as manifest-replacement
**Why explored:** Simpler routing model (1:1 stays intact); fork "overrides" the default by matching the same name.
**REJECTED BECAUSE:** Violates the core dev workflow — A/B requires uninstalling to compare. Primary user pain.
**DO NOT REVISIT UNLESS:** Multi-candidate routing proves infeasible due to LSP server state interference (no evidence this will happen; `LspServer` instances are isolated processes).

#### 3. Four-phase breakdown (router → manifests → forks → authoring)
**Why explored:** Initial scope-reduction instinct; each phase was "different content type."
**REJECTED BECAUSE:** Demo moments were fake (unit tests and install flows aren't demos). Most phases were just content files with no real risk boundary. Anti-pattern surfaced by user.
**DO NOT REVISIT UNLESS:** Phase 1 work proves to split along a genuine risk seam that makes shipping the whole demo unworkable in one pass.

#### 4. Single-phase epic (A + B + C + D together)
**Why explored:** Fewest moving pieces.
**REJECTED BECAUSE:** Fork wrappers do couple to the router's manifest contract; shipping them in parallel with the core work means any router contract change forces fork rework. Splitting core from forks is a real seam.
**DO NOT REVISIT UNLESS:** Phase 1 completes faster than expected and fork wrappers can piggyback without rework risk.

#### 5. Router as separate npm package + thin plugin shell
**Why explored:** Clean publish story; non-CC users `npm i lsp-mcp`.
**REJECTED BECAUSE:** Registry round-trip on every MCP start; version drift between plugin and npm; cloud envs still need network. Committed `dist/` in the repo handles non-CC case via `node /path/to/lsp-mcp/dist/index.js` directly.
**DO NOT REVISIT UNLESS:** A clear user demand emerges for `npx lsp-mcp` style invocation independent of this marketplace.

#### 6. Bundle LSP server binaries in the core plugin
**Why explored:** "Just works" out of the box for users with nothing installed.
**REJECTED BECAUSE:** Bloat (clangd alone is 100+ MB); license/platform issues; violates "works with what you have" — the product is a router, not a binary distribution. Fork wrappers in Phase 2 handle the "needs this specific build" case via buildHook.
**DO NOT REVISIT UNLESS:** A specific LSP has zero reasonable PATH-install story AND a fork plugin isn't appropriate.

### Scope Boundaries

**In scope (Phase 1 + 2):**
- Marketplace + core plugin installable in CC
- Multi-candidate routing with A/B capability
- Default manifest library for the listed langs (R2) plus natural expansion
- Non-CC compatibility via env vars (R11)
- Fork wrappers for pyright-fork, zls-fork, markymark (Phase 2)
- Per-project settings via `.local.md` (Phase 2)
- Core agent-facing skill + settings + authoring skills
- Empirical verification of `${CLAUDE_PLUGIN_ROOT}` path resolution

**Out of scope:**
- csharp manifests (no active user need; Phase 2 candidate if user adopts csharp)
- Outer-layer workspace/symbol prefilter (cold-cache discipline) — flagged as follow-up; current design relies on manifest's `stringPrefilter: true` for servers that do it internally (pyright, pyright-fork)
- Bundled LSP server binaries
- Hosted / remote LSP protocol transports
- `list_languages` caching (manifests are fixed post-startup; re-probing is out of Phase 1)
- Cross-manifest result merging beyond `(uri, range)` dedupe (e.g., "show me where pyright and pyright-fork disagree") — agent can drive this via two manifests-scoped queries

### Open Questions

- `${CLAUDE_PLUGIN_ROOT}/../../dist/` path resolution: empirical behavior in CC marketplace install. First Phase 1 task resolves this; fallback is committing a symlink or copying `dist/` into plugin dir at release time.
- Starlark lang ID for the two bazel candidates: LSPs may declare different langIds (`bazel`, `starlark`, `bzl`). The manifests need coherent langIds to trigger multi-candidate routing; may require a per-manifest langId normalization step or a shared langId in both manifests.
- `csharp-ls` vs Roslyn `Microsoft.CodeAnalysis.LanguageServer` — deferred to Phase 2 per user decision.

## Design Discovery

### Key Decisions Made

| Question | Answer | Implication |
|---|---|---|
| Marketplace topology | Single repo, LSP-only scope | Repo root IS the marketplace; forks stay in their own repos referenced via buildHook |
| Router distribution | Prebuilt `dist/` committed to repo | CI release must build-then-commit; no install step in plugin; cloud-safe |
| Config discovery | Layered: built-in + plugin-tree auto-discovery + `LSP_MCP_CONFIG` + `LSP_MCP_MANIFESTS_DIR` | Belt-and-suspenders for CC + non-CC use |
| Repo layout | `src/` and `dist/` stay at repo root; plugin subdir references via `${CLAUDE_PLUGIN_ROOT}/../../dist/` | Router remains a first-class npm project; non-CC users invoke `dist/` directly |
| Disable mechanism | `.claude/lsp-mcp.local.md` (CC path) + `LSP_MCP_SETTINGS` env (non-CC path) | Settings layer is Phase 2; Phase 1 has no disable (don't install a manifest you don't want, or don't install the binary) |
| Phase 1 default manifests (batch 1) | pyright, tsserver, gopls, rust-analyzer, zls | R2 minimum starter set |
| Phase 1 default manifests (batch 2) | clangd, lua-language-server, elixir-ls, svelte, bash, starpls, bazel-lsp | Included in R2 |
| csharp | Push to Phase 2 | No active user need |
| bazel | Ship both starpls + bazel-lsp in Phase 1 as the first A/B exemplar | Forces multi-candidate routing to prove itself on real need |
| Multi-candidate routing | First-class feature | R4, R5, R6, R7; makes fork wrappers coexist-by-default; A/B is the first-class path |
| `symbol_search` fan-out default | Primaries only; `manifests?` param for explicit candidate scoping | Prevents duplicate-ish results when multiple candidates share a lang |
| Primary-selection default | First-registered (deterministic given fixed plugin tree) | Built-in defaults beat later-discovered forks; user overrides via settings or `set_primary` |
| Phase count | Two phases, anchored on real demos | Phase 1 = core product (Demo A: polyglot symbol trace); Phase 2 = fork wrappers + settings + authoring (Demo C/D: A/B fork vs stock + per-project override) |

### Dead-End Paths

- **Four-phase breakdown** (router / manifests / forks / authoring): artificial scope theatre; most "phases" were just content files. Demos were verification commands, not demonstrations. User called this out directly.
- **Fork wrappers as overrides that replace stock manifests**: would have required uninstall-to-compare workflow, which is explicitly the user pain this product exists to solve.
- **Publish manifests as standalone npm packages**: package sprawl; no discoverability win over bundled defaults + plugin-tree auto-discovery.
- **Separate repos for router (`lsp-mcp`) and marketplace (`lsp-mcp-marketplace`)**: two version streams, coupled releases, more coordination overhead with no user-visible benefit.

### Open Concerns

- **`${CLAUDE_PLUGIN_ROOT}` path resolution to repo root `dist/`**: `[UNVERIFIED — assumption]`. First Phase 1 task includes empirical verification; fallback is copy-dist-into-plugin-dir at release time. This is the single concrete unknown that could force a layout change.
- **Bazel LSP langId coherence**: `starpls` and `bazel-lsp` may declare different langIds. If they do, multi-candidate routing requires either per-manifest langId normalization or manifests declaring a shared canonical langId. Phase 1 task covering bazel manifests must verify.
- **LSP server process multiplication**: N candidates per lang means N processes. Lazy spawn (current behavior) keeps dormant candidates at zero cost. Active A/B doubles memory for one language. Acceptable given user's explicit request for A/B capability.
