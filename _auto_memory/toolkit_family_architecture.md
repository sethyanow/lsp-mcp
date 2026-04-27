---
name: lsp-mcp toolkit family architecture
description: The lsp-mcp project is the broker in a toolkit family (lsp-mcp + chunkhound + bones + markymark + future memory plugin), not a monolith. Shared LSP processes, shared conventions, composed via lsp-manifest.json discovery.
type: project
originSessionId: eb135b9a-a838-4af9-93c3-122d1ba14bd9
---
lsp-mcp is designed as the **LSP process broker** for a family of agent-toolkit plugins, not as a standalone LSP wrapper. The architecture emerged from riff session 2026-04-19 surveying cclsp, serena, chunkhound, pyright-mcp.

**Why:** Agent-toolkit plugins (chunkhound for indexed graph, cclsp-equivalent for name-keyed lookup, serena-equivalent for symbol-aware edits, pyright-mcp for opinionated LSP, future tools) each want LSP access. Each currently spawns its own LSP processes → N × pyright/tsserver/rust-analyzer per workspace. The family architecture collapses that to one LSP per (workspace, manifest) pair, owned by lsp-mcp, consumed by siblings.

**How to apply:**

1. **lsp-mcp owns LSP processes.** Every consumer (chunkhound indexing, agent live queries, future tools) routes through lsp-mcp's multi-candidate layer. No double-spawn.
2. **chunkhound owns the precomputed graph.** Don't re-implement `impact_cascade` / `semantic_diff` / `test_targeting` / `cross_language_check` / `structural_search` in lsp-mcp. Those stay in chunkhound. The integration edge is "chunkhound reads LSP state from lsp-mcp broker instead of spawning its own servers."
3. **Siblings declare LSPs via `lsp-manifest.json`** at their plugin root. R8c's scan (lspm-mcp task) is the discovery mechanism. Any plugin adding `lsp-manifest.json` is picked up and routed via multi-candidate.
4. **Shared conventions:** `name_path` for symbol identity (from serena); `sourceKind` tagging (`builtin` | `plugin-tree` | `config-file` | `manifests-dir`) for provenance; type_signature + doc inline in symbol lookup output (from chunkhound).
5. **Orthogonal concerns stay separate:** memory / persistent context is a companion plugin, NOT inside lsp-mcp. bones handles task/planning. markymark handles markdown intel.

**Agent-facing tool surface (distilled from the family survey, ~18 verbs total):**

Live LSP (lsp-mcp): `symbol_search`, `symbol_refs`, `symbol_body`, `outline`, `diagnostics`, `call_tree`, `replace_symbol_body`, `insert_before_symbol`, `insert_after_symbol`, `safe_delete_symbol`, `lsp` (passthrough).

Precomputed graph (chunkhound): `impact_cascade`, `test_targeting`, `semantic_diff`, `cross_language_check`, `structural_search`.

Filesystem intelligence (probably lsp-mcp): `list_dir` (gitignore-aware), `find_file`, `search_for_pattern` (code-only filter).

**Explicitly NOT on this surface:** onboarding ceremony, project activation, memory subsystem, shell exec, double-JSON envelopes, firehose-default output.

**Connects to:** R8c task (lspm-mcp) scan scope locked to sibling plugins (NOT lsp-mcp's own root) precisely because of this cross-plugin contract intent.
