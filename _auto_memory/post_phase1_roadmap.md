---
name: lsp-mcp post-Phase-1 roadmap
description: Epics queued after Phase 1 (lspm-cnq) and Phase 2 (lspm-erd) close. Captures the riff-session-derived roadmap for absorption, integration, and ecosystem work without committing to bones epics prematurely.
type: project
originSessionId: eb135b9a-a838-4af9-93c3-122d1ba14bd9
---
Architectural riff session 2026-04-19 surfaced post-parent-epic work. These epics are NOT yet created in bones — they live here until Phase 1 + Phase 2 close, at which point they become explicit bones epics.

**Why:** Creating bones epics now would clutter the ready-list and fragment focus from Phase 1. But losing the roadmap means future sessions re-derive it from scratch. This memory is the holding area.

**How to apply:** When Phase 2 (lspm-erd) closes, consult this to scope the next epic set. When a question mid-work touches one of these areas, refer back to the absorption matrix memory for the per-tool action.

## Timing

- **Phase 1** (`lspm-cnq`) currently in-flight: R8c (`lspm-mcp`) is the last layered-discovery task. Also remaining: R5/R6 PATH probe, `list_languages`, `set_primary`, R7 dynamic schemas, R9 using-lsp-mcp skill.
- **Phase 2** (`lspm-erd`): fork wrappers, `.local.md` settings, authoring docs, `lsp-mcp-settings` skill, `validate-manifest` utility. Parent epic `lspm-y5n` closes when both phases close.
- **Post-parent-epic roadmap below.** Everything here lands AFTER `lspm-y5n` closes.

## Queued epics

### 1. cclsp-extract

Vendor cclsp's name-keyed tool interface into lsp-mcp. Deprecate cclsp install in favor of lsp-mcp's broker. Preserve MIT notice.

Interface to extract: `find_definition(file?, symbol_name, symbol_kind?)`, `find_references(file?, symbol_name, symbol_kind?)`, `find_workspace_symbols(query)`, symbol_kind filter, rename_symbol_strict disambiguation.

Rewrite internals backed by lsp-mcp's multi-candidate router (not cclsp's vibed internals).

Bridge strategy while cclsp still installed: lsp-mcp can proxy to running cclsp for features not yet absorbed (temporary appendage per Phase A → B → C plan). Once all cclsp-equivalent features are in lsp-mcp, cclsp gets uninstalled.

### 2. serena-ux-absorb

Lift serena's UX patterns into lsp-mcp (and possibly a companion filesystem-intel plugin). Explicit absorption list:

- `symbol_refs` with containing-symbol + inline context (serena's `find_referencing_symbols`)
- `outline` with compact names+kinds (serena's `get_symbols_overview`)
- `symbol_body` by name_path (serena's `find_symbol` with include_body)
- Symbol-aware edit verbs: `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `safe_delete_symbol`
- Filesystem intel: `list_dir` (gitignore-aware), `find_file`, `search_for_pattern` (code-only filter, path glob)
- `name_path` identity system

Drop: onboarding ceremony, `activate_project`, memory subsystem, shell exec, double-JSON envelope.

### 3. chunkhound-integration

Chunkhound's fork (user-owned) currently spawns its own LSP servers. Integration epic: chunkhound consumes lsp-mcp as its LSP source. One pyright/tsserver per workspace feeds both chunkhound's index and lsp-mcp's live queries.

Integration points:
- Chunkhound's `lsp` tool routes through lsp-mcp's `lsp` passthrough instead of directly
- Chunkhound's workspace-symbol calls use lsp-mcp's multi-candidate routing
- chunkhound's `lsp-manifest.json` (if needed for registration) follows the cross-plugin contract

Dependency: lsp-mcp multi-candidate routing is stable (Phase 1 complete), chunkhound daemon supports pluggable LSP source (chunkhound work).

Long-term: eventual chunkhound rewrite in Rust/Zig keeps these interfaces.

### 4. toolkit-memory-plugin

Separate companion plugin for persistent context. Explicitly NOT auto-memory-dump. Progressive disclosure via docs. Replaces serena's opinionated memory system with something more aligned to user preference.

Scope TBD. Likely bones-adjacent — captures session decisions/learnings in a queryable doc surface, not a JSON blob.

### 5. pyright-fork first-class manifest (decision pending)

Could happen IN Phase 1 (ship alongside stock pyright in default manifest library, exercising multi-candidate with a real fork) OR defer to Phase 2 fork-wrappers work. User decision pending based on fork + cold-read proxy readiness.

### 6. rust-zig-rewrite (long-term)

Current lsp-mcp + chunkhound are TypeScript + Python respectively. Long-term ideal is a Rust or Zig implementation. Interfaces defined in the earlier epics (cclsp-extract, serena-ux-absorb) are the durable surface; language is implementation detail. No near-term timeline.

## Open decisions (as of 2026-04-19)

1. Document the family architecture in a durable doc (project README or `docs/architecture.md` or dedicated bones epic). Currently lives only in this memory + the riff conversation.
2. Whether to create bones epics for items 1-4 above now (visibility) or wait until Phase 2 closes (leanness).
3. pyright-fork timing (item 5).
