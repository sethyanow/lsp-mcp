# lsp-mcp — Project Guide for Agents

Multi-candidate LSP routing as a Claude Code plugin. The **broker** in a toolkit family (see `memory/toolkit_family_architecture.md`): owns LSP processes, routes to multiple manifests per language, exposes a high-level symbol surface that keeps agents away from position counting.

## Tool Hierarchy

The MCP servers enabled in this repo provide overlapping ops. Reach for the **right one**, not the first one that works. The primary tools below are preferred because they return higher-signal output (type signatures inline, name-keyed, position-returning) than the raw alternatives.

| Need | Primary | Fallback |
|---|---|---|
| **Find symbol by name** (workspace-wide) | `chunkhound.search type=symbols` — returns FQN + type signature + doc inline | `mcp__cclsp__find_workspace_symbols` |
| **Get body of a named symbol** | `serena.find_symbol include_body=true` | `chunkhound.search` then `Read` with offset/limit |
| **File outline** | `serena.get_symbols_overview` or `chunkhound.search type=symbols path=<file>` | `LSP.documentSymbol` (line-only, no columns) |
| **Find references with containing-symbol context** | `serena.find_referencing_symbols` — grouped by file + symbol kind, inline snippets | `LSP.findReferences` (positions only) |
| **Caller tree / impact of a change** | `chunkhound.impact_cascade` — tree with type signatures per node | Manual `LSP.incomingCalls` walk |
| **Tests to run for a set of changes** | `chunkhound.test_targeting` | Manual reasoning |
| **Behavior diff between git refs** | `chunkhound.semantic_diff base head` | `git diff` + manual |
| **Binding drift across scopes** (bindings vs core) | `chunkhound.cross_language_check` | Manual symbol-by-symbol |
| **Semantic / conceptual search across code + docs** | `chunkhound.search type=structural` (semantic + graph walk) or `type=semantic` | `Grep` / `rg` |
| **Regex over code files only** | `chunkhound.search type=regex` with `path` scope, OR `serena.search_for_pattern restrict_search_to_code_files=true` | `Grep` / `rg` |
| **Edit a function body** | `serena.replace_symbol_body` — by name_path, no string-match gymnastics | `Read` + `Edit` |
| **Insert import / method before/after a symbol** | `serena.insert_before_symbol` / `insert_after_symbol` | `Read` + `Edit` |
| **Delete a symbol (safely)** | `serena.safe_delete_symbol` — refuses if still referenced | Manual grep + Edit |
| **Dir listing (gitignore-aware)** | `serena.list_dir` | `Glob` |
| **Find file by name** | `serena.find_file` | `Glob` |
| **Hover / live type info at a position** | `LSP.hover` (raw) | `chunkhound.symbol_context` |
| **Python symbol intel specifically** | `pyright-mcp.lsp` (routes to held pyright instance) | `LSP.*` |

**One-sentence rule:** When you need *structured graph answers*, use chunkhound. When you need *symbol-aware navigation or editing*, use serena. When you need *live authoritative LSP state*, use the raw `LSP` tool. When a chunkhound symbol result hands you `type_signature` + docs, you probably don't need a follow-up `hover`.

## Symbol-Aware Edits Beat Read+Edit

Whenever the target is a named symbol (function, method, class, type), prefer serena's symbol-aware edit verbs over the generic `Read` → `Edit` loop:

- **`replace_symbol_body(name_path, file, body)`** — swap a function body in one call, no unique-match-string needed.
- **`insert_before_symbol` / `insert_after_symbol`** — anchored inserts for imports, new methods, sibling functions.
- **`safe_delete_symbol`** — refuses if references still exist, so you can't silently orphan callers.

Generic `Read` + `Edit` is fine for config files, docs, or ad-hoc string patches — but for code, symbol-aware is fewer calls, fewer indent-guessing mistakes, and fewer "old_string not unique" retries.

## Friction to Expect (Don't Be Surprised When...)

- **Raw `LSP.documentSymbol` strips columns** — returns `Line 17` but not `17:17`. Use chunkhound's symbol search for name + position + signature in one shot.
- **cclsp's workspace-symbol errors with "No Project"** when the TS server isn't rooted at this repo. Prefer chunkhound for cross-repo symbol work.
- **Serena nags about onboarding** (`check_onboarding_performed`, "read the Serena Instructions Manual"). **Skip it.** Symbol tools work without it.
- **Serena outputs are large** — `find_referencing_symbols` returned 30KB for 65 refs. Scope by path when you can; parse by file key.
- **Chunkhound's graph neighborhood floods with local vars** — `err`, `raw`, `full`, `parsed`, etc. Filter by `kind` (Function, Method, Class, Interface) when reading.
- **Chunkhound's `symbol_context` returns empty hover/def if the position is inside a comment** — retarget at the actual symbol line.
- **Any workspace-scoped LSP call can return empty without an error** when the LSP isn't configured for that path. Treat empty as "unknown" not as "doesn't exist" — cross-check with a regex search before concluding.

## Development

- **Package manager:** `bun` (authoritative via `bun.lock`). Do not use npm / yarn / pnpm.
- **Tests:** `bun run test` (full jest suite). Single file or pattern: `bun run test -- --testPathPattern=<regex>`.
- **Typecheck:** `bun run typecheck` (`tsc --noEmit`, strict).
- **Build:** `bun run build` — bundles `src/index.ts` + all deps into a single `dist/index.js` via `bun build`. The bundle is **committed** (not gitignored) because `.claude-plugin/plugin.json` references `${CLAUDE_PLUGIN_ROOT}/dist/index.js` at marketplace install. Rebuild + commit on any runtime-dep change.
- **Smoke-test the built server** (stdio transport, discovery phase visible on stderr):
  ```bash
  LSP_MCP_CONFIG=/nonexistent node dist/index.js < /dev/null 2>&1 | head -20
  ```
  `< /dev/null` closes the transport cleanly after the `[lsp-mcp] loaded N manifests (...)` line lands on stderr; never use `echo '' |` — the stray newline races the JSON-RPC reader.

## Conventions

- **ESM imports:** TypeScript source uses `.js` extensions in import paths (e.g., `import { foo } from './discover.js'`) even though the file is `.ts`. Node ESM requires it; don't strip when editing.
- **Test fixtures:** always `mkdtempSync(path.join(tmpdir(), '...'))` + `try { ... } finally { rmSync(dir, { recursive: true, force: true }) }`. Never write test manifests into the real `manifests/` directory — it stays as the 12 shipped defaults.
- **Stderr spies in tests:** `jest.spyOn(process.stderr, 'write').mockImplementation(() => true)` in `beforeEach`, `.mockRestore()` in `afterEach`. Discovery paths write to stderr; tests assert against the spy's `.mock.calls`.
- **Soft-skip vs hard-exit:** dir-based manifest sources (`builtin`, `plugin-tree`, `manifests-dir`) **soft-skip** on any FS/parse/schema error — stderr notice + continue. Only the single-file `LSP_MCP_CONFIG` **hard-exits** on malformed content (user-authored correctness expected). Preserve this asymmetry when adding new sources.

## Core Files

- `src/discover.ts` — manifest pipeline (4 sources: builtin → plugin-tree → config-file → manifests-dir). Shared `discoverFromJsonDir` helper; merge via `mergeDiscoveryPipeline`.
- `src/router.ts` — multi-candidate `Map<langId, { candidates, primary }>`.
- `src/mcp-server.ts` — MCP tool surface.
- `src/lsp-server.ts` — persistent JSON-RPC bridge per manifest.
- `src/index.ts` — entry, env-var wiring (LSP_MCP_CONFIG, LSP_MCP_MANIFESTS_DIR, LSP_MCP_ROOT, LSP_MCP_PLUGINS_DIR; R8c adds CLAUDE_PLUGIN_ROOT).
- `manifests/` — 12 built-in default manifests (pyright, tsserver, gopls, rust-analyzer, zls, clangd, lua-language-server, elixir-ls, svelte-language-server, bash-language-server, starpls, bazel-lsp).
- `.claude-plugin/plugin.json` — MCP server config, `mcpServers` inlined, `${CLAUDE_PLUGIN_ROOT}/dist/index.js` entry.
- `.claude-plugin/marketplace.json` — marketplace manifest at repo root.


@_auto_memory/MEMORY.md
