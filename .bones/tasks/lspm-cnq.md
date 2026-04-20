---
id: lspm-cnq
title: 'Phase 1: Core plugin + multi-candidate routing'
status: open
type: epic
priority: 1
depends_on: [lspm-501, lspm-z4z, lspm-177, lspm-h1n, lspm-kgj, lspm-mcp, lspm-hlm, lspm-rot]
parent: lspm-y5n
---















## Context

Parent epic: `lspm-y5n`, Phase 1 (no prior phase).

Delivers the product core: `lsp-mcp` Claude Code plugin installable via marketplace, default manifest library over PATH-available LSPs, multi-candidate routing model, and `using-lsp-mcp` skill that redirects agents from grep to `symbol_search` in polyglot sessions.

The router TypeScript source already lives at `src/` on this branch. Phase 1 extends the router with multi-candidate routing, PATH probe, dynamic tool schemas, `list_languages` + `set_primary` tools, and layered manifest discovery — plus adds the plugin scaffolding around it.

## Requirements

Covers parent epic R1 through R11. All router code changes land here; all CC plugin scaffolding lands here; one agent-facing skill (`using-lsp-mcp`) lands here.

Out of Phase 1 (→ Phase 2, `lspm-erd`): fork wrappers, `.local.md` settings, `authoring-lsp-plugin` skill, `lsp-mcp-settings` skill, `validate-manifest` utility, manifest library expansion beyond R2.

## Success Criteria

> **Layout note (2026-04-17, post-`lspm-501`):** Repo refactored to **root-as-plugin** — `.claude-plugin/plugin.json` lives at repo root with `mcpServers` inlined (no separate `.mcp.json`); `manifests/` and `skills/using-lsp-mcp/` sit at repo root; no `plugins/lsp-mcp/` subtree exists. Criteria below reflect the refactored layout.

- [x] `.claude-plugin/marketplace.json` exists at repo root and validates against the CC marketplace schema. *(satisfied by `lspm-501`; schema accepts `source: "./"` and plugin installs cleanly)*
- [x] `.claude-plugin/plugin.json` exists at repo root with `mcpServers` inlined (path: `${CLAUDE_PLUGIN_ROOT}/dist/index.js`); path resolution empirically verified under CC marketplace install. *(satisfied by `lspm-501` commit 633ea50 — `/mcp` shows `lsp` connected; MCP tool calls route successfully)*
- [x] `manifests/` (at repo root) contains a JSON manifest for each of: pyright, typescript-language-server, gopls, rust-analyzer, zls, clangd, lua-language-server, elixir-ls, svelte-language-server, bash-language-server, starpls, bazel-lsp. *(satisfied by `lspm-177` — 12 files, schema-conformant, 6-test validation battery; data dormant until R8 layered discovery lands)*
- [x] Router routing model is `Map<langId, { candidates: ManifestEntry[], primary: string }>`; 1:1 hardcoding removed from all tool handlers. *(satisfied by `lspm-z4z`)*
- [x] PATH probe at startup sets `status: "ok" | "binary_not_found"` per manifest; only `ok` manifests join the routing map; all are visible to `list_languages`. *(satisfied by `lspm-hlm` — src/probe.ts with `probeBinaryOnPath` + `probeAll` + `formatMissingBinarySummary`; ManifestEntry.status field; Router._buildLangMap filter; _requireByName status gate throws informative error; _selectSymbolSearchTargets soft-skip with stderr; index.ts probes + alphabetical summary line with singular/plural. 21 new tests (probe unit + router integration + adversarial battery covering empty cmd, dir X_OK, non-exec file, relative path, trailing delim, bare-name dir, all-missing router, idempotency). Smoke: 5 of 12 builtins `binary_not_found` on dev box. `list_languages` SC remains [ ] — separate R6 task.)*
- [x] `list_languages` MCP tool returns `{lang, manifest, primary: bool, status, capabilities}[]`. *(satisfied by `lspm-rot` — `Router.listLanguages()` + `LanguageInfo` interface in src/router.ts, `list_languages` MCP tool in src/mcp-server.ts with empty `inputSchema` and try/jsonResult/toolError handler. 17 new tests: 13 router unit (ok+missing shape, multi-candidate primary, multi-langIds, empty, idempotency, all-missing, zero-langIds, spawn safety, primary-slot invariant, duplicate langIds, encoding boundaries, dense 50×4) + 3 MCP (registration, shape, JSON round-trip) + 1 e2e smoke over real builtin pipeline. Adversarial stress test with Three-Question Framework. Smoke on dev box: 12 manifests → 18 rows (13 ok + 5 missing, 13 primary langs). Generic reusable smoke harness added at `scripts/smoke-mcp-tool.mjs`. R7 `set_primary`, R7b dynamic schemas, R9 `using-lsp-mcp` skill still open.)*
- [ ] `set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart.
- [x] `via?` param threaded through all positional tool handlers (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, call-hierarchy tools); default behavior preserved when omitted. *(satisfied by `lspm-z4z`)*
- [x] `manifests?` param threaded through `symbol_search`; default fans across primaries only; explicit list scopes to named manifests. *(satisfied by `lspm-z4z`)*
- [ ] MCP tool input schemas built dynamically at startup; `lang` / `langs` / `via` / `manifests` parameters expose enum values reflecting currently-active manifests.
- [x] Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision; conflict logged to stderr. *(satisfied by R8a `lspm-h1n` + R8b `lspm-kgj` + R8c `lspm-mcp`; four-way merge test + smoke 2 override confirm chain)*
- [ ] `skills/using-lsp-mcp/SKILL.md` (at repo root) ships with third-person description, specific trigger phrases for polyglot / symbol lookup / cross-language refactor queries, imperative body, concrete examples for Python↔Rust (pyo3), TS↔Go (gRPC), and C embedded in anything. No position-counting from text in examples.
- [ ] `bun run test` passes: existing tests + new tests covering multi-candidate routing, PATH probe, `list_languages` shape, `set_primary`, layered discovery merge + dedupe + conflict-logging.
- [ ] Router with zero env vars, no `$CLAUDE_PLUGIN_ROOT` set, stdio transport: loads built-in defaults, PATH-probes, serves queries — smoke-tested via stdio echo.
- [ ] Fresh CC session with plugin installed: `/mcp` shows `lsp` server connected; `list_languages` reports whichever defaults match the box's installed LSPs; `symbol_search` on a real polyglot repo returns cross-language hits.

## Anti-Patterns

Inherited from parent epic — see `.bones/tasks/lspm-y5n.md`. Phase-1-specific reinforcements:

- **NO shipping the 1:1 routing refactor as "good enough for now."** Multi-candidate (R4) is the Phase 1 delta over the current router; without it Phase 2 fork wrappers have no contract to build against.
- **NO skipping the empirical CC-cache path verification.** R10 — the first task must resolve it or explicitly trigger the fallback.
- **NO hardcoding lang enums.** R7 — schemas built at startup from the active manifest set.
- **NO silent source-override in layered discovery.** R8 — stderr log on name collision; user must be able to notice when a fork wrapper shadows a default.

## Key Considerations

- **`${CLAUDE_PLUGIN_ROOT}` path resolution — RESOLVED in `lspm-501`.** Primary attempt (`${CLAUDE_PLUGIN_ROOT}/../../dist/`) failed because CC caches only the plugin subtree, escaping `../../`. Fallback considered (copy of `dist/` into plugin dir) also failed because the bundler didn't inline deps. Final outcome: root-as-plugin layout with `mcpServers` inlined into `.claude-plugin/plugin.json` (not a separate top-level `.mcp.json` — that form does not bind `${CLAUDE_PLUGIN_ROOT}`) and a single bundled `dist/index.js` with all deps inlined via `bun build`. `${CLAUDE_PLUGIN_ROOT}` now resolves to the repo root itself; downstream tasks must reference this layout.
- **Bazel lang ID coherence**: `starpls` and `bazel-lsp` may declare different LSP language IDs (`starlark`, `bzl`, `bazel`). Multi-candidate routing requires a shared canonical langId in both manifests so they register as candidates for the same lang. Bazel manifest task must verify the LSPs' actual language IDs and set `langIds` accordingly — or introduce a per-manifest langId normalization step.
- **Built-in defaults dir path**: Discovery must locate defaults in both CC and non-CC environments. Resolve relative to `dist/index.js`'s own `__dirname` (via `fileURLToPath(import.meta.url)`), then walk to `../manifests/` (sibling of `dist/` at repo root, per root-as-plugin layout). Do NOT use `process.cwd()` — CC invokes the server from arbitrary working directories.
- **LSP server process multiplication**: N candidates per lang = N processes when all active. Lazy spawn (current `LspServer` behavior) keeps dormant candidates at zero cost. Active A/B doubles memory for one language; acceptable.
- **Tool-schema enum liveness**: MCP protocol expects tool schemas known at tool-list time. Rebuilding on every tool call is out of spec; built-at-startup is the contract. `set_primary` changes the default primary, not enum values — schema stays valid.
- **Manifest source-tagging**: `ManifestEntry.sourceKind: "builtin" | "plugin-tree" | "config-file" | "manifests-dir"` threaded through the discovery pipeline so Phase 2 settings can reason about origin when applying overrides.
- **PATH probe portability**: `cmd[0]` may be an absolute path or a bare name (PATH lookup). Probe must handle both. Consider Windows support (PATHEXT, `.cmd` / `.exe` extensions) since Claude Code runs on Windows too.

## Acceptance Requirements

**Agent Documentation:** Update stale docs only — don't generate summaries or tutorials.
- [ ] `README.md`: update Installation section (marketplace install), Tool Surface section (add `list_languages` / `set_primary` / `via` / `manifests`), Configuration section (add `LSP_MCP_MANIFESTS_DIR` + layered discovery), MCP client config example (marketplace-install path).
- [ ] `skills/using-lsp-mcp/SKILL.md` ships as new content (R9); not a stale-doc update but a Phase 1 deliverable.

**User Demo:** Polyglot symbol trace in a real CC session.
- Fresh CC session. Marketplace added; `/plugin install lsp-mcp`; MCP server connects.
- `list_languages` returns the subset of default manifests whose binaries were found on PATH, each with `primary: true/false` and `status: "ok"`. Langs with missing binaries appear with `status: "binary_not_found"`.
- Open a real polyglot repo (any user-held checkout that mixes langs — Python + Rust bindings, TS + Go gRPC, etc.). Call `symbol_search` on a symbol that exists across language domains. Receive hits across files with different extensions, each with correct `(uri, range)`.
- Follow-up `defs` or `refs` using one of the returned anchors works — agent does not count character positions.
- Demonstrate `via`: call `defs` with explicit `via: "<manifest-name>"` pinning the query to one specific server.
- Demonstrate `set_primary`: if bazel is in-scope on the demo box, show two candidates (`starpls`, `bazel-lsp`) in `list_languages`, swap primary with `set_primary`, verify the change on the next `list_languages`.
- Error path: a `binary_not_found` lang appears in `list_languages`; `symbol_search(langs: ["<that lang>"])` returns an empty result set with an informative message, not a hard error.

## Log

- [2026-04-17T20:37:21Z] [Seth] Skeleton freshness update (2026-04-17): rewrote paths and Key Considerations to reflect root-as-plugin layout adopted by lspm-501. SC #1 and #2 marked done (satisfied by lspm-501 empirical verify at commit 633ea50). SC #3, #12 path-prefixes rewritten (manifests/, skills/). 'Built-in defaults dir path' Key Consideration rewritten to point at ../manifests/ relative to dist/. Parent epic lspm-y5n has matching stale paths (Architecture diagram, R8 bullet 1, Seam Contracts, Design Discovery) — flagged here, NOT edited this round per user scope (option 1 covered Phase 1 only). Next task: R4 multi-candidate routing refactor.
