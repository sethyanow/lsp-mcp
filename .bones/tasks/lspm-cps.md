---
id: lspm-cps
title: 'Phase 1: Core plugin + multi-candidate routing'
status: open
type: epic
priority: 1
depends_on: [lspm-7t9]
parent: lspm-m3f
---






## Context

Parent epic: `lspm-m3f`, Phase 1 (no prior phase).

Delivers the product core: the `lsp-mcp` Claude Code plugin installable via marketplace, default manifest library over PATH-available LSPs, multi-candidate routing model, and the `using-lsp-mcp` skill that kills the grep reflex in polyglot sessions.

The underlying TypeScript router already exists (merged PR #1 on `main`). Phase 1 extends the router with multi-candidate routing, PATH probe, dynamic tool schemas, `list_languages` + `set_primary` tools, and layered manifest discovery — plus adds the plugin scaffolding around it.

## Requirements

Covers parent epic R1, R2, R3, R4, R5, R6, R7, R8, R9, R10, R11. All router code changes land here; all CC plugin scaffolding lands here; one agent-facing skill (`using-lsp-mcp`) lands here.

Out of Phase 1 (→ Phase 2): fork wrappers, `.local.md` settings, `authoring-lsp-plugin` skill, `lsp-mcp-settings` skill, `validate-manifest` utility, extended manifest library beyond R2's contract.

## Success Criteria

- [ ] `.claude-plugin/marketplace.json` exists at repo root and validates against the CC marketplace schema.
- [ ] `plugins/lsp-mcp/.claude-plugin/plugin.json` + `plugins/lsp-mcp/.mcp.json` exist; `.mcp.json` path resolution to repo `dist/index.js` is empirically verified under CC marketplace install (or fallback path — see Key Considerations).
- [ ] `plugins/lsp-mcp/manifests/` contains a JSON manifest for each of: pyright, typescript-language-server, gopls, rust-analyzer, zls, clangd, lua-language-server, elixir-ls, svelte-language-server, bash-language-server, starpls, bazel-lsp.
- [ ] Router routing model is `Map<langId, { candidates: ManifestEntry[], primary: string }>`; 1:1 hardcoding removed from all tool handlers.
- [ ] PATH probe at startup sets `status: "ok" | "binary_not_found"` per manifest; only `ok` manifests join the routing map; all are visible to `list_languages`.
- [ ] `list_languages` MCP tool returns `{lang, manifest, primary: bool, status, capabilities}[]`.
- [ ] `set_primary(lang, manifest)` MCP tool swaps primary in-memory without restart.
- [ ] `via?` param threaded through all positional tool handlers (`defs`, `refs`, `impls`, `hover`, `outline`, `diagnostics`, `lsp`, call-hierarchy tools); default behavior preserved when omitted.
- [ ] `manifests?` param threaded through `symbol_search`; default fans across primaries only; explicit list scopes to named manifests.
- [ ] MCP tool input schemas built dynamically at startup; `lang` / `langs` / `via` / `manifests` parameters expose enum values reflecting currently-active manifests.
- [ ] Layered manifest discovery: built-in defaults dir + `$CLAUDE_PLUGIN_ROOT` glob + `LSP_MCP_CONFIG` file + `LSP_MCP_MANIFESTS_DIR` all merge; later source wins on name collision and the conflict is logged to stderr.
- [ ] `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` ships with third-person description, specific trigger phrases for polyglot / symbol lookup / cross-language refactor queries, imperative body, concrete examples for Python↔Rust (pyo3), TS↔Go (gRPC), and C embedded in anything. No position-counting from text in examples.
- [ ] `npm test` passes: all pre-existing PR #1 tests + new tests for multi-candidate routing, PATH probe, `list_languages` shape, `set_primary`, layered discovery merge + dedupe + conflict-logging.
- [ ] Router with zero env vars, no `$CLAUDE_PLUGIN_ROOT` set, stdio transport: loads built-in defaults, PATH-probes, serves queries — smoke-tested via stdio echo.
- [ ] Fresh CC session with plugin installed: `/mcp` shows `lsp` server connected; `list_languages` reports whichever defaults match the box's installed LSPs; `symbol_search` on a real polyglot repo returns cross-language hits.

## Anti-Patterns

Inherited from parent epic — see `.bones/tasks/lspm-m3f.md` Anti-Patterns section. Phase-1-specific reinforcements:

- **NO shipping the 1:1 routing refactor as "good enough for now."** Multi-candidate (R4) is the Phase 1 delta over PR #1; without it fork wrappers (Phase 2) have no contract to build against.
- **NO skipping the empirical CC-cache path verification.** R10 — the first task must resolve this or explicitly trigger the fallback.
- **NO hardcoding lang enums.** R7 — schemas built at startup from the active manifest set.
- **NO silent source-override in layered discovery.** R8 — stderr log on name collision; user must be able to notice when a fork wrapper shadows a default.

## Key Considerations

- **`${CLAUDE_PLUGIN_ROOT}` path resolution**: The `.mcp.json` in `plugins/lsp-mcp/` needs to resolve to repo-root `dist/index.js`. Empirical check: install the plugin locally in a CC session, observe whether the cache preserves repo layout or only copies the plugin subtree. If the plugin subtree is copied in isolation, `../../dist/` escapes the cache. Fallback: a release-time prepare step that copies (or symlinks) `dist/` into `plugins/lsp-mcp/dist/`; `.mcp.json` uses `${CLAUDE_PLUGIN_ROOT}/dist/index.js`.
- **Bazel lang ID coherence**: `starpls` and `bazel-lsp` may declare different LSP language IDs (`starlark`, `bzl`, `bazel`). Multi-candidate routing requires a shared canonical langId in both manifests for them to be registered as candidates for the same lang. Bazel manifest task must verify the LSPs' actual `textDocument/languageIds` and set `langIds` in manifests accordingly — or introduce a per-manifest langId normalization step.
- **Built-in defaults dir path**: When the router runs from repo root (non-CC), the built-in defaults live at `./plugins/lsp-mcp/manifests/`. When the router runs under CC marketplace cache, the same dir is at `${CLAUDE_PLUGIN_ROOT}/plugins/lsp-mcp/manifests/` (or wherever the cache put them). Discovery must locate them correctly in both environments — resolve relative to `dist/index.js`'s own `__dirname` rather than `cwd`.
- **LSP server process multiplication**: N candidates per lang = N processes when all are active. Lazy spawn (current `LspServer` behavior) keeps dormant candidates at zero cost. Active A/B doubles memory for one language; acceptable.
- **Tool-schema enum liveness**: MCP protocol expects tool schemas to be known at tool-list time. Rebuilding on every tool call is out of spec; built-at-startup is the contract. `set_primary` changes the *default primary*, not the enum values — so the schema stays valid.
- **Manifest source-tagging**: `ManifestEntry.sourceKind: "builtin" | "plugin-tree" | "config-file" | "manifests-dir"` threaded through the discovery pipeline so Phase 2 settings can reason about origin when applying overrides.
- **PATH probe portability**: `cmd[0]` may be an absolute path (e.g., a user-specified binary) or a bare name (PATH lookup). Probe must handle both. Recommend `which`-style lookup with PATHEXT on Windows if we care about Windows — and we probably should since CC runs there.

## Acceptance Requirements

**Agent Documentation:** Update stale docs only — don't generate summaries or tutorials.
- [ ] `README.md`: update sections covering install flow, tool surface (add `list_languages` / `set_primary` / `via` / `manifests`), configuration (add `LSP_MCP_MANIFESTS_DIR` + layered discovery explanation), and MCP client config example (change to marketplace-install path).
- [ ] `CLAUDE.md` (if present in repo): update any LSP-tool guidance that predates `symbol_search` being available via lsp-mcp.
- [ ] Skill file itself (`plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md`) IS new content and part of the phase deliverable, not stale-doc update.

**User Demo:** Polyglot symbol trace in a real CC session.
- Fresh CC session. Marketplace added; `/plugin install lsp-mcp`; MCP server connects.
- `list_languages` returns the subset of default manifests whose binaries were found on PATH, each with `primary: true/false` and `status: "ok"`. Langs with missing binaries appear with `status: "binary_not_found"`.
- Open a real polyglot repo (candidate: a local checkout containing Python + Rust bindings, or any repo of the user's that mixes langs). Call `symbol_search` on a symbol that exists in at least two language domains. Receive hits across files with different extensions, each with correct `(uri, range)`.
- Follow-up `defs` or `refs` using one of the returned anchors works — agent does not need to count character positions.
- Demonstrate `via`: call `defs` with an explicit `via: "<manifest-name>"` pinning the query to one specific server.
- Demonstrate `set_primary`: if bazel is in-scope on the demo box, show two candidates (`starpls`, `bazel-lsp`) in `list_languages`, swap primary with `set_primary`, verify the change is reflected on next `list_languages` call.
- Error path: a `binary_not_found` lang. Show it appearing in `list_languages` and verify `symbol_search(langs: ["<that lang>"])` returns an empty result set with an informative message, not a hard error.
