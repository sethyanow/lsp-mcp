---
id: lspm-7t9
title: Scaffold marketplace + core plugin; verify CLAUDE_PLUGIN_ROOT path resolution
status: open
type: task
priority: 1
parent: lspm-cps
---



## Context

First task in Phase 1 sub-epic `lspm-cps`, parent epic `lspm-m3f`.

The epic's R10 flags `${CLAUDE_PLUGIN_ROOT}/../../dist/index.js` as `[UNVERIFIED — assumption]`: whether Claude Code's marketplace-install caching preserves repo-relative paths to the router's `dist/` directory, or only copies the plugin subtree in isolation. Every downstream Phase 1 task assumes the `.mcp.json` path resolves correctly. This task resolves the assumption by building minimal scaffolding and testing installation.

**Deliberately small scope.** No router code changes. No manifest library. No multi-candidate routing. One `using-lsp-mcp` skill is optional — a placeholder is fine. The only goal: prove the layout works (or switch to the fallback) and leave the repo in a state where subsequent tasks can fill in the router features without revisiting path resolution.

## Requirements

- Scaffold `.claude-plugin/marketplace.json` at repo root listing one plugin (`lsp-mcp`).
- Scaffold `plugins/lsp-mcp/.claude-plugin/plugin.json` with name, version, description, author.
- Scaffold `plugins/lsp-mcp/.mcp.json` invoking `node ${CLAUDE_PLUGIN_ROOT}/../../dist/index.js` (primary path) OR `node ${CLAUDE_PLUGIN_ROOT}/dist/index.js` (fallback path — see Implementation step 3).
- Ensure `dist/` is built and committed (change `.gitignore` if `dist/` is currently ignored; commit `dist/` contents).
- Verify empirically: `/plugin marketplace add <local-path>` followed by `/plugin install lsp-mcp` in a real Claude Code session produces a connected MCP server on `/mcp`. If primary path fails, apply fallback per step 3 and re-verify.
- Update `README.md` "Installation" section to document marketplace install flow.
- Do NOT introduce the multi-candidate routing, PATH probe, `list_languages`, or any other Phase 1 router change in this task. Those are subsequent tasks.

## Implementation

1. **Build and commit `dist/`.**
   - Confirm current branch is the working branch (per earlier observation: `dev`).
   - Install deps (`npm install` if needed given new `bun.lock` — decide and document whether this repo now uses bun or npm; for this task, stay on whichever produced the current `package-lock.json` state OR update build scripts for bun if `bun.lock` is authoritative).
   - `npm run build` (or `bun run build`).
   - Edit `.gitignore`: remove `dist/` if present, or add a `!dist/` exception.
   - `git add dist/` and confirm the directory is staged.

2. **Scaffold marketplace and core plugin (primary path attempt).**
   - Create `.claude-plugin/marketplace.json`:
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
   - Create `plugins/lsp-mcp/.claude-plugin/plugin.json`:
     ```json
     {
       "name": "lsp-mcp",
       "version": "0.1.0",
       "description": "Meta-LSP MCP router: polyglot workspace/symbol for agents",
       "author": {"name": "Seth Yanow"}
     }
     ```
   - Create `plugins/lsp-mcp/.mcp.json` (primary attempt, repo-root dist):
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
   - In a separate Claude Code session (not this agent), run `/plugin marketplace add /Volumes/code/lsp-mcp` and then `/plugin install lsp-mcp`.
   - Check `/mcp` for a connected `lsp` server.
   - If MCP server fails to start with path-not-found, `dist/index.js not found`, or similar: the primary path escapes the cache. Apply **fallback**:
     - Add a `prepublishOnly` or `prepare` npm script that copies (or symlinks) `dist/` into `plugins/lsp-mcp/dist/` before each commit.
     - Update `plugins/lsp-mcp/.mcp.json` to `${CLAUDE_PLUGIN_ROOT}/dist/index.js`.
     - Commit the copy/symlink explicitly (do not rely on the script to run at install — CC plugin cache does not run arbitrary scripts).
     - Re-test the install.
   - Document which path (primary or fallback) won in the Success Criteria checkbox below.

4. **Placeholder skill (optional — keeps scaffolding valid).**
   - Create `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` with ONLY the required frontmatter and a single-line body stating "Placeholder — content lands in a subsequent Phase 1 task." No trigger phrases, no examples — those are owned by a dedicated later task to avoid skill-reviewer churn.
     ```markdown
     ---
     name: using-lsp-mcp
     description: Placeholder — skill content lands in a subsequent Phase 1 task.
     ---

     Placeholder.
     ```
   - Do not claim this skill is complete. The epic's R9 is explicitly a later task.

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
   - Commit message: short, references `lspm-7t9`, explains "scaffold marketplace + core plugin; resolve CLAUDE_PLUGIN_ROOT path resolution".
   - Do NOT push; let the user review the commit first given the architectural nature.

## Success Criteria

- [ ] `.claude-plugin/marketplace.json` exists, valid JSON, lists the `lsp-mcp` plugin.
- [ ] `plugins/lsp-mcp/.claude-plugin/plugin.json` exists with complete manifest.
- [ ] `plugins/lsp-mcp/.mcp.json` exists pointing at `dist/index.js` via whichever path (primary or fallback) was empirically verified.
- [ ] `dist/` is committed (not gitignored) and present in the working tree.
- [ ] Empirical verification record: fresh CC session → `/plugin marketplace add <repo>` → `/plugin install lsp-mcp` → `/mcp` shows `lsp` server connected — documented in the task log (via `bn log`) with which path worked.
- [ ] If fallback path was needed: `dist/` is also present at `plugins/lsp-mcp/dist/` (copy or symlink) and the `prepare` script is in place to keep it in sync.
- [ ] README.md install section updated to marketplace-install path.
- [ ] `npm test` still passes (no router code was changed; existing tests must remain green).
- [ ] Placeholder skill file exists at `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` with clear placeholder marker.
- [ ] Single commit on the current branch staging all the above; not yet pushed.

## Anti-Patterns

- **NO router code changes in this task.** Keep the scope surgical. Multi-candidate routing, PATH probe, `list_languages`, `set_primary`, dynamic schemas — all subsequent tasks.
- **NO manifest library in this task.** The 12 default manifests are a dedicated task downstream. This task only needs the plugin to install cleanly — no manifests required for the install flow to succeed.
- **NO `using-lsp-mcp` content beyond placeholder.** A real skill with triggers + examples is a separate task so `skill-reviewer` feedback doesn't contaminate this scaffolding work.
- **NO pushing without user review.** The marketplace scaffolding is architectural; user should eyeball the commit before it goes remote.
- **NO `npm install -g` or global pollution.** Build + commit dist; do not ship install scripts that modify the user's global node env.
- **NO silently changing the default `bun.lock` / `package-lock.json` situation.** If the repo now has both, either pick one and remove the other or document the divergence in the commit. Don't commit both and hope for the best.
- **NO declaring path resolution "works" without the empirical CC-session test.** Running `node dist/index.js` directly does not verify CC marketplace cache behavior. The test is an actual `/plugin install` in a real session.
- **NO scope creep into "while I'm here, let me also add X".** Every addition beyond the scaffolding delays the path-resolution verification that blocks everything else.

## Key Considerations

- **bun vs npm**: `bun.lock` is newly staged; this repo may be mid-transition. Decide which package manager this task assumes. Safest bet: keep `package.json` with npm scripts, ignore `bun.lock` if it's incidental, OR commit the bun switch deliberately with `npm install` removed from docs. Task should not arbitrate this — if it's ambiguous, surface to user via `bn log` before committing.
- **CC cache path behavior**: If the primary path fails, the fallback's `prepare` script needs to run somewhere that actually executes. `npm prepare` runs on `npm install` in dev, not in the cache. A safer fallback: commit the copy directly (or use a git post-commit hook) so the dist/ is already in the plugin dir when CC caches it. Decide during step 3 based on CC's observed behavior.
- **Marketplace schema**: CC marketplace schema may require additional fields (tags, categories, homepage, repository URL). Start with minimal set; iterate if `/plugin marketplace add` reports errors.
- **Branch state**: Current branch is `dev` (observed earlier). This task's commit lands there. The user will decide later whether `dev` merges to `main` or becomes the new primary.
- **PR #1's merged src/ is on main**: The `dev` branch appears to be a fresh starting point for the marketplace work. Confirm with user before this task starts whether `dev` should pull router source from `main` first, or whether some merge/rebase has already landed it. If router `src/` is absent from `dev`, step 1 (build dist/) fails and this task can't proceed — surface immediately.
