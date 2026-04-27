---
name: Claude Code plugin cache layout
description: What CC copies into its plugin cache at install time, and how `${CLAUDE_PLUGIN_ROOT}` resolves relative to the cache — affects .mcp.json paths and hook command args.
type: reference
originSessionId: 4545fd7d-2b8e-45ed-b1ae-04aecc789d23
---
When Claude Code installs a plugin from a marketplace, it copies ONLY the plugin subtree (the directory referenced by `marketplace.json`'s `plugins[].source`) into its cache — NOT the surrounding repo.

**Verified layout (macOS, April 2026):**

```
~/.claude/plugins/cache/<marketplace-name>/<plugin-name>/<plugin-version>/
    .claude-plugin/plugin.json
    .mcp.json
    skills/
    commands/
    agents/
    hooks/
    (... whatever else lives inside the plugin subtree)
```

`${CLAUDE_PLUGIN_ROOT}` resolves to that version-stamped directory at spawn time (not cache time — the cached `.mcp.json` still contains the literal `${CLAUDE_PLUGIN_ROOT}` string; CC substitutes when invoking the MCP command).

**Consequence:** Any path in `.mcp.json` args, hook commands, or scripts that uses `${CLAUDE_PLUGIN_ROOT}/../` or similar to escape into the repo root will fail — the repo root isn't in the cache. Paths must stay **inside** the plugin subtree.

**Design implication for plugins that wrap a build artifact:** If your repo has router code at `src/` and compiled output at repo-root `dist/`, and you want the plugin to invoke the compiled router via MCP, the cleanest pattern is root-as-plugin: `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` at the repo root, `source: "./"` in marketplace.json (trailing slash is load-bearing — the validator rejects plain `"."`), and `dist/index.js` (bundled, deps inlined via `bun build --target node --format cjs`) also at the repo root. CC caches the whole repo tree; `${CLAUDE_PLUGIN_ROOT}` resolves to the cached repo root; `${CLAUDE_PLUGIN_ROOT}/dist/index.js` is valid.

**MCP server registration — inline in plugin.json, NOT a separate `.mcp.json`**, when using root-as-plugin layout. A top-level `.mcp.json` at the repo root (sibling of `.claude-plugin/marketplace.json`) is read by CC as a top-level MCP config where `${CLAUDE_PLUGIN_ROOT}` is NOT bound, producing "missing env CLAUDE_PLUGIN_ROOT" at spawn time. Put the `mcpServers` block inline inside `.claude-plugin/plugin.json` instead — that registers it as plugin-owned, so CC binds `CLAUDE_PLUGIN_ROOT` when spawning the MCP server. The `plugin-structure` skill's "Method 1: dedicated `.mcp.json`" works only when the plugin is in its own subdirectory (e.g., `./markymark-plugin/.mcp.json` where the subdir itself is the plugin root); for root-as-plugin, use Method 2 (inline in plugin.json).

**Cache-refresh protocol** when editing an already-installed plugin and re-testing:
```
/plugin uninstall <plugin-name>
/plugin marketplace update <marketplace-name>    (or: remove marketplace, re-add)
/plugin install <plugin-name>
/mcp
```

Just re-running `/plugin install` may serve the pre-edit cached tree.

**How to diagnose MCP-server-failed-to-load issues:**
- `ls ~/.claude/plugins/cache/<marketplace>/<plugin>/<version>/` — see what CC actually cached.
- Read the cached `.mcp.json` — confirm the args you expect are there (substitution has NOT happened yet at cache time).
- Resolve `${CLAUDE_PLUGIN_ROOT}` mentally to that cached version dir; check the resolved path actually exists.
- A literal `${CLAUDE_PLUGIN_ROOT}` in the MCP server error message would indicate substitution-contract failure (not observed in practice — CC does substitute).
