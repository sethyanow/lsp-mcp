---
name: lsp-mcp — log-first discipline and tool hierarchy
description: In this repo, read the full bn log chronologically (load any referenced skills/docs) BEFORE running Step-0-style probes, and use chunkhound/serena as primary per project CLAUDE.md — rg/Grep are fallbacks, not the reflex.
type: feedback
originSessionId: 3993c512-2428-43e0-9473-e6afaa57afde
---
Two rules specific to `/Volumes/code/lsp-mcp`:

**1. Log-first on bn tasks.** Before running any Step-0 empirical probe from a skeleton, read every log entry chronologically. When a log says "References for future sessions (don't re-derive)" or flags a knowledge capture, load the referenced skill/doc via the Skill tool. Skeleton Step 0 instructions do NOT override newer log entries that already answered the probe — check log timestamps against the skeleton's written-on date.

**2. Tool hierarchy is primary, not preference.** Project CLAUDE.md has a Tool Hierarchy table. For regex over code: `chunkhound.search type=regex path=<file>` or `serena.search_for_pattern restrict_search_to_code_files=true`. For symbol lookup: `chunkhound.search type=symbols` or serena's symbol verbs. `rg` and `Grep` are FALLBACKS. Reaching for rg because it's shorter to type is the violation.

**Why:** 2026-04-19 session opened `lspm-mcp` R8c. The bn log entry dated 2026-04-19T06:50:26Z already captured: (a) CC cache layout `~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/`, (b) THREE LSP-declaration surfaces — `plugin.json` with inline `lspServers`, `.lsp.json` sibling-file, and lsp-mcp's own `lsp-manifest.json`, (c) references to `plugin-dev:plugin-structure` skill and CC's `plugins-reference.md` with "don't re-derive" guidance. The session ignored the log, ran `find`/`ls` to re-derive the cache layout, and asked the user a scan-depth question — missing the bigger finding that CC's native `lspServers` may supersede the premise of R8c's custom globbing. Session also used `rg` for symbol/test-count lookups when `chunkhound.search type=regex` was the stated primary.

**How to apply at session start for any bones task in this repo:**
1. `bn show <id> --json` → read body AND every log entry chronologically, most-recent last.
2. For each log entry that names a skill or doc with "References" / "don't re-derive" / "knowledge capture" markers — load it via Skill tool BEFORE any bash probe.
3. Compare skeleton Step-0-style probe instructions against newer log dates. If a log post-dates the skeleton section and answers the probe, use the log's answer; treat the Step 0 instructions as historical.
4. For code exploration: `chunkhound.search` (regex / structural / symbols) and serena (`find_symbol`, `find_referencing_symbols`, `search_for_pattern`, `get_symbols_overview`) are primary. Reach for `rg` / `Grep` only after the primary tool is unavailable or returns insufficient signal — not because you'd rather type less.
