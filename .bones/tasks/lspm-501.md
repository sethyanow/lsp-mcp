---
id: lspm-501
title: Scaffold marketplace + core plugin; verify CLAUDE_PLUGIN_ROOT path resolution
status: open
type: task
priority: 1
parent: lspm-cnq
---

## Context

First task in Phase 1 sub-epic `lspm-cnq`, parent epic `lspm-y5n`.

The epic's R10 flags `${CLAUDE_PLUGIN_ROOT}/../../dist/index.js` as `[UNVERIFIED — assumption]`: whether Claude Code's marketplace-install caching preserves repo-relative paths to the router's `dist/` directory, or only copies the plugin subtree in isolation. Every downstream Phase 1 task assumes the `.mcp.json` path resolves correctly. This task resolves the assumption by building minimal scaffolding and testing installation.

**Deliberately small scope.** No router code changes. No manifest library. No multi-candidate routing. One `using-lsp-mcp` placeholder is fine. The only goal: prove the layout works (or switch to the fallback) and leave the repo ready for subsequent tasks to fill in router features without revisiting path resolution.

## Requirements

- Scaffold `.claude-plugin/marketplace.json` at repo root listing one plugin (`lsp-mcp`).
- Scaffold `plugins/lsp-mcp/.claude-plugin/plugin.json` with name, version, description, author.
- Scaffold `plugins/lsp-mcp/.mcp.json` invoking `node ${CLAUDE_PLUGIN_ROOT}/../../dist/index.js` (primary path attempt) OR `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js` (fallback path — see Implementation step 3).
- Ensure `dist/` is built and committed (update `.gitignore` if it currently excludes `dist/`; commit the build output).
- Verify empirically: `/plugin marketplace add <local-path>` followed by `/plugin install lsp-mcp` in a real Claude Code session produces a connected MCP server on `/mcp`. If primary path fails, apply fallback per step 3 and re-verify.
- Update `README.md` Installation section to document marketplace install flow.
- Do NOT introduce multi-candidate routing, PATH probe, `list_languages`, or any other Phase 1 router change in this task. Those are subsequent tasks.

## Implementation

1. **Build and commit `dist/`.**
   - `bun install` (if `node_modules/` is stale).
   - `bun run build` (invokes the `build` script from `package.json` — tsc).
   - Edit `.gitignore`: remove `dist/` if present, or add a `!dist/` exception.
   - `git add dist/` and confirm it's staged.

2. **Scaffold marketplace and core plugin (primary path attempt).**
   - `.claude-plugin/marketplace.json`:
     ```json
     {
       "name": "lsp-mcp",
       "owner": {"name": "Seth Yanow"},
       "plugins": [
         {
           "name": "lsp-mcp",
           "source": "./plugins/lsp-mcp",
           "description": "Meta-LSP MCP router: polyglot workspace/symbol for agents"
         }
       ]
     }
     ```
   - `plugins/lsp-mcp/.claude-plugin/plugin.json`:
     ```json
     {
       "name": "lsp-mcp",
       "version": "0.1.0",
       "description": "Meta-LSP MCP router: polyglot workspace/symbol for agents",
       "author": {"name": "Seth Yanow"}
     }
     ```
   - `plugins/lsp-mcp/.mcp.json` (primary attempt, repo-root dist):
     ```json
     {
       "mcpServers": {
         "lsp": {
           "command": "node",
           "args": ["${CLAUDE_PLUGIN_ROOT}/../../dist/index.js"]
         }
       }
     }
     ```

3. **Empirical verification in a real CC session.**
   - In a separate Claude Code session (not this agent), run `/plugin marketplace add /Volumes/code/lsp-mcp` followed by `/plugin install lsp-mcp`.
   - Check `/mcp` for a connected `lsp` server.
   - If the MCP server fails with `dist/index.js not found` or similar: the primary path escapes the cache. Apply **fallback**:
     - Add a `prepare-plugin-dist` script to `package.json` that copies `dist/` into `plugins/lsp-mcp/dist/` (invoked as `bun run prepare-plugin-dist`). Call it after every `bun run build` during release.
     - Update `plugins/lsp-mcp/.mcp.json` to `${CLAUDE_PLUGIN_ROOT}/dist/index.js`.
     - Commit the copy explicitly (do not rely on the script to run at install — CC plugin cache does not run arbitrary scripts).
     - Re-run the marketplace install + verify `/mcp` connects.
   - Document which path (primary or fallback) won via `bn log lspm-501 "..."`.

4. **Placeholder skill (keeps scaffolding valid).**
   - Create `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` with ONLY the required frontmatter and a single-line body stating the content lands later. No trigger phrases, no examples — those are owned by a dedicated later task to avoid `skill-reviewer` churn here.
     ```markdown
     ---
     name: using-lsp-mcp
     description: Placeholder — skill content lands in a subsequent Phase 1 task.
     ---

     Placeholder.
     ```
   - Do not claim this skill is complete. Epic R9 is explicitly a later task.

5. **README install section update.**
   - Replace the current `Installation` / `Usage` / `MCP client configuration` sections with a marketplace-install path:
     ```markdown
     ## Installation

     In Claude Code:

     ```
     /plugin marketplace add https://github.com/sethyanow/lsp-mcp
     /plugin install lsp-mcp
     ```

     Or for local dev:

     ```
     /plugin marketplace add /path/to/lsp-mcp
     /plugin install lsp-mcp
     ```
     ```
   - Keep the `LSP_MCP_CONFIG` / `LSP_MCP_ROOT` / `LSP_MCP_PLUGINS_DIR` env-var reference section; that remains the non-CC path.
   - Do NOT yet document `LSP_MCP_MANIFESTS_DIR`, `list_languages`, `set_primary`, `via`, or `manifests` — those land in the tasks that implement them.

6. **Commit discipline.**
   - Commit bones skeletons (`.bones/`) + this task's changes together:
     - `.bones/` directory state
     - `.gitignore` change
     - `dist/` contents
     - `.claude-plugin/marketplace.json`
     - `plugins/lsp-mcp/` subtree
     - `README.md` install section update
     - If fallback path was used: `package.json` script addition + copied `plugins/lsp-mcp/dist/`
   - Commit message references `lspm-501` and explains "scaffold marketplace + core plugin; resolve CLAUDE_PLUGIN_ROOT path resolution".
   - Do NOT push. User reviews first given the architectural nature.

## Success Criteria

- [ ] `.claude-plugin/marketplace.json` exists, valid JSON, lists the `lsp-mcp` plugin.
- [ ] `plugins/lsp-mcp/.claude-plugin/plugin.json` exists with complete manifest.
- [ ] `plugins/lsp-mcp/.mcp.json` exists pointing at `dist/index.js` via whichever path (primary or fallback) was empirically verified.
- [ ] `dist/` is committed (not gitignored) and present in the working tree.
- [ ] Empirical verification record: fresh CC session → `/plugin marketplace add <repo>` → `/plugin install lsp-mcp` → `/mcp` shows `lsp` server connected — documented via `bn log lspm-501 "..."` with which path worked.
- [ ] If fallback path was needed: `plugins/lsp-mcp/dist/` is also present (copy) and the `prepare-plugin-dist` script exists in `package.json` to keep it in sync.
- [ ] `README.md` Installation section updated to marketplace-install path.
- [ ] `bun run test` still passes (no router code was changed; existing tests must remain green).
- [ ] Placeholder skill file exists at `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` with clear placeholder marker.
- [ ] Single commit on the current branch staging all the above; not yet pushed.

## Anti-Patterns

- **NO router code changes in this task.** Keep scope surgical. Multi-candidate routing, PATH probe, `list_languages`, `set_primary`, dynamic schemas — all subsequent tasks.
- **NO manifest library in this task.** The 12 default manifests are a dedicated task downstream. This task only needs the plugin to install cleanly — no manifests required for the install flow to succeed.
- **NO `using-lsp-mcp` content beyond placeholder.** A real skill with triggers + examples is a separate task so `skill-reviewer` feedback doesn't contaminate this scaffolding work.
- **NO pushing without user review.** Marketplace scaffolding is architectural; user should eyeball the commit before it goes remote.
- **NO `npm install -g` or global pollution.** Build + commit `dist/`; do not ship install scripts that modify the user's global node env.
- **NO declaring path resolution "works" without the empirical CC-session test.** Running `node dist/index.js` directly does NOT verify CC marketplace cache behavior. The test is an actual `/plugin install` in a real session.
- **NO scope creep into "while I'm here, let me also add X".** Every addition beyond the scaffolding delays the path-resolution verification that blocks everything else.

## Key Considerations

- **CC cache path behavior** is the single unknown this task resolves. If the plugin subtree is copied in isolation (not the whole repo), `${CLAUDE_PLUGIN_ROOT}/../../dist/` escapes the cache. The fallback of copying `dist/` into the plugin dir sidesteps this. Bias toward empirical results over convention.
- **`prepare-plugin-dist` script is for repo maintainers, not end users.** CC plugin cache does not run arbitrary scripts at install time. The committed copy of `dist/` inside `plugins/lsp-mcp/` is what CC caches and serves. The script's job is keeping the two `dist/` copies in sync during dev.
- **Marketplace schema** may require additional fields (tags, categories, homepage, repository URL). Start minimal; iterate if `/plugin marketplace add` reports errors.
