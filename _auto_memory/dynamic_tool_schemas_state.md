---
name: lsp-mcp dynamic tool schemas (post-R7b)
description: Per commit 13a0b31 (lspm-4vb), the MCP tool surface publishes JSON Schema enums for lang/manifest params derived from active manifests at startup. Affects how R9 skill and acceptance demo are framed.
type: project
originSessionId: 3d04462a-67ca-4f26-a1cb-889c67ec4c9f
---
Per commit 13a0b31 (`lspm-4vb` close), the MCP tool surface publishes JSON Schema `enum` values for every `lang` / `langs` / `manifest` / `manifests` / `via` parameter, derived from the router's active manifest set at `createMcpServer` time. Schemas are STABLE across `set_primary` swaps; binary_not_found manifests are EXCLUDED from enums.

Concretely on a dev box with 12 builtins (7 ok, 5 missing):
- `symbol_search.langs.items.enum` = 13 active langs
- `symbol_search.manifests.items.enum` = 7 ok manifests (binary_not_found excluded)
- `set_primary.lang.enum` / `set_primary.manifest.enum` — required, same shape
- `lsp.lang.enum` — same as `set_primary.lang.enum` (single LangEnum source, regression-locked)
- `defs.via.enum` (and 9 other positional tools) — same 7 ok manifests

**Why:** When agents (or any MCP client) call `listTools()`, they SEE which langs and manifests are routable on the current box without first calling `list_languages`. The polyglot UX promise from R11.

**How to apply:**
- **R9 `using-lsp-mcp` skill** can frame `symbol_search` as "look at the published schema enum to know which langs are available — no probe round-trip needed." That's the discovery mechanism the skill teaches.
- **Acceptance demo** can demonstrate this by inspecting the schema (via the new `scripts/smoke-mcp-tool.mjs --inspect-schema <tool>` flag) before any tool call. "Look — the schema already tells you what's available."
- **Phase 2 fork wrappers** that register additional manifests via `lsp-manifest.json` will appear in the enum at next CC session start (no mid-session hot-reload — schemas are session-stable per MCP protocol contract).
- **Adversarial-planning predicted that enum-ifying `set_primary.lang/manifest` and `lsp.lang` would intercept Zod-rejection BEFORE existing R7 router-error tests could fire.** 1 of 4 cases materialized; the migration to Router-direct test calls is the canonical pattern when tightening input validation at a higher layer.
