---
name: lsp-mcp tool absorption matrix
description: Per-tool decisions for cclsp, serena, chunkhound, pyright-mcp, pyright-fork. Classifies each as absorb-shape / vendor-code / compose-sibling / first-class-manifest so future epics don't re-open the fork-vs-vendor question.
type: project
originSessionId: eb135b9a-a838-4af9-93c3-122d1ba14bd9
---
Survey session 2026-04-19 classified each tool in the ecosystem into a handling strategy. Future sessions should consult this before re-deriving.

**Why:** Each tool has a distinct footprint — cclsp is abandoned MIT with useful interface; serena is a behemoth with great shapes; chunkhound has precomputed graph features that are complementary not redundant; pyright-mcp is user's own. Without a matrix, future sessions re-open "do we fork cclsp?" and "should serena's memory be in lsp-mcp?" repeatedly.

**How to apply:** When scoping post-Phase-1 epics or facing a new tool surface that overlaps, consult this matrix first. New tools get classified against the same 4-5 actions: absorb-shape / vendor-code / compose-sibling / leave-alone / new-decision.

## Matrix

| Tool | Action | Detail |
|------|--------|--------|
| **cclsp** (abandoned MIT) | **Vendor-and-extract** | Lift `find_definition` / `find_references` / `find_workspace_symbols` interface shape (name-keyed, position-returning, symbol_kind filter, strict-mode disambiguation) into lsp-mcp. Rewrite internals clean. Preserve MIT notice + copyright in vendored files or NOTICES. cclsp gets abandoned in favor of lsp-mcp's broker. |
| **Serena's symbol tooling** | **Absorb shapes, rewrite clean** | Lift `find_symbol`, `find_referencing_symbols` (containing-symbol + inline context), `get_symbols_overview`, symbol-aware edit verbs (`replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `safe_delete_symbol`), `name_path` identity, filesystem intel (`list_dir`/`find_file`/`search_for_pattern`). |
| **Serena's memory subsystem** | **Leave out entirely** | Companion plugin territory, not lsp-mcp. User finds auto-memory detrimental as a primary interface; progressive disclosure via docs preferred. |
| **Serena's onboarding / activation / shell** | **Drop** | Onboarding ceremony, `activate_project`, `execute_shell_command`, double-JSON envelope — all friction. Don't absorb. |
| **Chunkhound's graph tools** | **Compose as sibling** | Keep `impact_cascade`, `semantic_diff`, `test_targeting`, `cross_language_check`, `structural_search` in chunkhound. Do NOT re-implement in lsp-mcp. Chunkhound's precomputed-graph model is complementary to lsp-mcp's live-query model. Integration edge: chunkhound reads LSP from lsp-mcp broker instead of spawning its own servers. |
| **Chunkhound's type_signature + doc inline** | **Absorb output shape** | `symbol_search` in lsp-mcp should return `{name_path, kind, file, range, type_signature, doc}` by default — that's the output chunkhound showed was the right shape. |
| **Chunkhound (user's fork)** | **Clean in place; eventual Rust/Zig rewrite** | Current fork adds graph + LSP ops on top of cAST indexing, skipping LLM graphrag in favor of LSP-derived structural view. LLM graphrag layered on later. Rust/Zig rewrite is long-term; interface shapes defined now survive the language transition. |
| **pyright-mcp** (user's work) | **Becomes a fork wrapper, first-class** | Ships `lsp-manifest.json` at its root. lsp-mcp R8c scan discovers it. Routed via `via: "pyright-fork"` / multi-candidate. Cold-read proxy becomes a capability flag in the manifest (`capabilities.coldReadProxy: true` or similar). |
| **pyright-fork** (the LSP itself, user's fork of actual pyright) | **First-class manifest in Phase 1 default library (open question)** | Could ship now as a second pyright candidate alongside stock `pyright` in Phase 1's default manifest library, exercising multi-candidate routing with a real fork-vs-stock scenario. Or defer to Phase 2. Depends on fork + cold-read proxy readiness. User decision pending. |

**Post-Phase-2 epics this implies** (not yet created in bones):

- `cclsp-extract` — vendor name-keyed interface, deprecate cclsp install
- `serena-ux-absorb` — lift refs-with-context, outline, symbol-aware edits, filesystem intel
- `chunkhound-integration` — chunkhound consumes lsp-mcp as LSP source; shared broker
- `toolkit-memory-plugin` — separate companion for persistent context
- `rust-zig-rewrite` — long-term, same interfaces, different substrate
