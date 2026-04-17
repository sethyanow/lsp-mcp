---
id: lspm-501
title: Scaffold marketplace + core plugin; verify CLAUDE_PLUGIN_ROOT path resolution
status: active
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
- Scaffold placeholder `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` — real content in a later task (see Implementation step 4 + Anti-Patterns).
- Ensure `dist/` is built and committed (update `.gitignore` if it currently excludes `dist/`; commit the build output).
- Verify empirically: `/plugin marketplace add <local-path>` followed by `/plugin install lsp-mcp` in a real Claude Code session produces a connected MCP server on `/mcp`. If primary path fails, apply fallback per step 3 and re-verify.
- Update `README.md` Installation section to document marketplace install flow.
- Do NOT introduce multi-candidate routing, PATH probe, `list_languages`, or any other Phase 1 router change in this task. Those are subsequent tasks.

## Implementation

1. **Build and commit `dist/`.**
   - `bun install` (if `node_modules/` is stale).
   - `bun run build` (invokes the `build` script from `package.json` — tsc).
   - Edit `.gitignore`: the current file has a bare `dist` line under the `# Nuxt.js build / generate output` section (around line 72 — `.nuxt` followed by `dist`). **Delete that `dist` line.** (A `!dist/` exception alone won't work — the pattern is `dist` without a trailing slash, which matches files and dirs; the Git docs specify that a negation for a file excluded by its parent directory's pattern won't re-include it.) Leave `.nuxt` intact.
   - `tsconfig.json` has `"exclude": ["node_modules", "dist", ...]` — no change needed; tsc still writes to `outDir: "./dist"`.
   - `git add dist/` and confirm it's staged. Expected contents: compiled `.js` + `.js.map` + `.d.ts` files mirroring `src/` tree.

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
   - Current README structure (verified): `# lsp-mcp` → `## Problem` → `## Architecture` → `## Tool Surface` → `## Configuration` (manifest fields) → `## Usage` (npm install/build + run commands, env vars table, MCP client config example) → `## Development` → `## Cold-cache discipline` → `## Related`. **There is no `## Installation` section currently.**
   - Edits:
     - **Insert a new `## Installation` section** (after `## Tool Surface`, before `## Configuration`) covering the CC marketplace path. Use indented code blocks (4-space indent) rather than nested fenced code to avoid fence conflicts — or use `~~~` for the outer fence and ` ``` ` for the inner commands. Content:
       - Intro sentence: "In Claude Code (recommended):"
       - Commands shown as shell-style code: `/plugin marketplace add https://github.com/sethyanow/lsp-mcp` then `/plugin install lsp-mcp`
       - Second para: "Or from a local checkout:" + `/plugin marketplace add /path/to/lsp-mcp` + `/plugin install lsp-mcp`
       - Closing sentence: "The plugin auto-configures MCP; verify with `/mcp` — you should see an `lsp` server connected."
     - **Rewrite `## Usage`** to cover the non-CC path only. Remove the `npm install` / `npm run build` / `node dist/index.js` sequence; replace with `bun install && bun run build` and `node dist/index.js`. Keep the env vars table (`LSP_MCP_CONFIG` / `LSP_MCP_ROOT` / `LSP_MCP_PLUGINS_DIR`) unchanged — that remains the non-CC path.
     - **Keep the `MCP client configuration (Claude Code example)` subsection under `## Usage`** but reframe it as "For MCP clients other than Claude Code, or for a hand-configured setup" — the marketplace path in `## Installation` supersedes it for CC users.
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

- [x] `.claude-plugin/marketplace.json` exists, valid JSON, lists the `lsp-mcp` plugin.
- [x] `plugins/lsp-mcp/.claude-plugin/plugin.json` exists with complete manifest. *(refactored 2026-04-17 commit #3: plugin.json moved to `.claude-plugin/plugin.json` at repo root; marketplace source now `.`)*
- [x] `plugins/lsp-mcp/.mcp.json` exists pointing at `dist/index.js` via whichever path (primary or fallback) was empirically verified. *(5 commits: 46b0915 primary (failed cache-escape) → 4cea265 fallback (failed: deps not bundled + router-exits) → 14be9a0 root-as-plugin + Bun bundle + resolveManifests tolerance → 1a5bb41 marketplace source `./` (schema fix) → 633ea50 inline mcpServers in plugin.json (top-level `.mcp.json` with `source: "./"` did not bind `${CLAUDE_PLUGIN_ROOT}`; inline in plugin.json does). `/mcp` shows `lsp` connected; `symbol_search`/`outline`/`defs` tool calls routed successfully, all returning `[]` because zero manifests are loaded — expected.)*
- [x] `dist/` is committed (not gitignored) and present in the working tree.
- [x] Empirical verification record: fresh CC session → `/plugin marketplace add <repo>` → `/plugin install lsp-mcp` → `/mcp` shows `lsp` server connected — documented via `bn log lspm-501 "..."` with which path worked. *(confirmed: `/reload-plugins` output "Reloaded: 21 plugins · 22 skills · 25 agents · 9 hooks · 4 plugin MCP servers · 6 plugin LSP servers"; user confirmed "connected!"; three tool calls returned [] as expected for zero-manifest router.)*
- [x] If fallback path was needed: `plugins/lsp-mcp/dist/` is also present (copy) and the `prepare-plugin-dist` script exists in `package.json` to keep it in sync. *(both present, byte-identical to repo-root `dist/`)*
- [x] `README.md` Installation section updated to marketplace-install path.
- [x] `bun run test` still passes (no router code was changed; existing tests must remain green). *(64/64 green at commit 46b0915)*
- [x] Placeholder skill file exists at `plugins/lsp-mcp/skills/using-lsp-mcp/SKILL.md` with clear placeholder marker.
- [x] Each verification attempt's changes are in a single, well-scoped commit on the current branch; not yet pushed. Primary-path commit is commit #1 (`46b0915`). If fallback is adopted, fallback changes go in commit #2 — do not amend commit #1.
- [x] If the fallback path was adopted: `bun run build` is chained to also run `prepare-plugin-dist` (e.g., `"build": "tsc && bun run prepare-plugin-dist"`), and the copy step cleans the destination first so stale files don't persist. *(chained inline: `"build": "tsc && shx rm -rf plugins/lsp-mcp/dist && shx cp -r dist plugins/lsp-mcp/dist"`; standalone `prepare-plugin-dist` kept for maintainer ergonomics; `clean` wipes both dists)*
- [x] Pre-handoff pre-flight: agent checks `~/.claude.json` (and any project-local MCP config) for an existing MCP server named `lsp`; flags any collision in the hand-off message. *(no collision — `~/.claude.json` has only `deepwiki` globally; no project-local `lsp`)*

## Anti-Patterns

- **~~NO router code changes in this task.~~** WIDENED 2026-04-17: scope includes a minimal router change (`resolveManifests`: on missing config, write stderr notice and start with zero manifests). Required to satisfy the empirical `/mcp connected` SC — CC launches the plugin MCP server with no env, so the prior exit-on-missing-config path always failed `/mcp`. Multi-candidate routing, PATH probe, `list_languages`, `set_primary`, dynamic schemas remain subsequent tasks.
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
- **Marketplace name and plugin name both `lsp-mcp`** is intentional (matches repo identity) and not a conflict — CC keeps marketplace and plugin registries separate. If `/plugin marketplace add` rejects the collision, rename the marketplace to `lsp-mcp-marketplace` and document the rename in the bn log.
- **Package manager**: repo has both `package-lock.json` and `bun.lock`. Skeleton prescribes `bun`; stick with it. If `bun install` fails unexpectedly, fall back to `npm install` (the `package.json` scripts don't depend on Bun-specific features) and note the discrepancy in the bn log.
- **Empirical verification step 3 requires a USER in a separate CC session.** This agent cannot run `/plugin marketplace add` against itself. After committing the primary-path scaffolding, the agent STOPs and hands off to the user. The user reports back with the result; agent then either closes the task (primary path won) or applies the fallback (step 3 second half) and commits again, then re-hands off.

### Failure Catalog (from adversarial planning)

**Temporal Betrayal: `dist/` staleness in the commit**
- Assumption: `bun run build` produces a fresh `dist/` that reflects the current `src/`.
- Betrayal: A prior build on a different branch or src revision can leave `dist/` populated. If the agent skips `bun run clean` and just runs `bun run build`, files that no longer have a `src/` counterpart persist in `dist/`; the commit carries orphaned compiled modules.
- Consequence: Plugin ships with stale or orphaned code; downstream tasks debugging `dist/` pick up a ghost file.
- Mitigation: **Run `bun run clean && bun run build` before `git add dist/`.** Not "try clean" — always. The `clean` script already exists (`shx rm -rf ./dist`); use it.

**State Corruption: CC plugin cache staleness between primary and fallback attempts**
- Assumption: After editing `plugins/lsp-mcp/.mcp.json` and re-running `/plugin install lsp-mcp`, CC serves the new `.mcp.json`.
- Betrayal: CC's marketplace cache may serve the originally-installed plugin tree until the marketplace is refreshed or the plugin is explicitly reinstalled. A naive fallback attempt (edit `.mcp.json`, user re-runs `/plugin install`) can test against the cached primary-path version and report "still broken" even though the fallback fix is correct on disk.
- Consequence: False negative on the fallback verification; agent keeps "fixing" a working fix; user loses trust in the verification protocol.
- Mitigation: **The fallback protocol must explicitly `/plugin uninstall lsp-mcp`, then `/plugin marketplace update lsp-mcp` (or remove + re-add), then `/plugin install lsp-mcp` — in that order.** Document this in the hand-off message to the user, not just in the task body.

**Dependency Treachery: `${CLAUDE_PLUGIN_ROOT}` interpolation contract**
- Assumption: CC substitutes `${CLAUDE_PLUGIN_ROOT}` in `.mcp.json` `args` before launching node — i.e., the literal string becomes the cache path at launch time.
- Betrayal: If CC only substitutes in certain fields (e.g., `command` but not `args`), or substitutes at MCP-server-config load time vs. spawn time, the literal `${CLAUDE_PLUGIN_ROOT}` is passed to node, which then runs `node ${CLAUDE_PLUGIN_ROOT}/../../dist/index.js` — file-not-found.
- Consequence: Indistinguishable failure mode from the primary-path-escapes-cache hypothesis we're actually trying to test. Fallback gets adopted for the wrong reason; the real bug (substitution contract) is never diagnosed.
- Mitigation: **During hand-off, instruct the user to capture the actual MCP server error** (CC logs it; `/mcp` shows status). If the error string contains a literal `${CLAUDE_PLUGIN_ROOT}`, the substitution contract is the issue, not the cache layout. Distinguishing these two is cheap and blocks downstream misdiagnosis.

**State Corruption: User's pre-existing MCP config collision**
- Assumption: The `lsp` MCP server name defined by the plugin does not conflict with anything in the user's `~/.claude.json` or project-local MCP config.
- Betrayal: Any prior manual config — including one left over from the current development workflow — may register an MCP server also named `lsp`. CC's resolution order between plugin-provided and user-provided MCP servers is not formally specified; the active server may silently be the wrong one.
- Consequence: `/mcp` shows "connected" but the connection is to the wrong process; behavior looks right in isolation but diverges from what the plugin was supposed to provide.
- Mitigation: **Agent must check `~/.claude.json` and the repo's any local MCP config for a server named `lsp` before hand-off** and flag any collision to the user. Renaming the plugin server key to `lsp-mcp` (from `lsp`) is out of scope for this task (it'd churn the skill content later); diagnosis > avoidance.

**Temporal Betrayal: `dist/` drift under the fallback path**
- Assumption: If fallback is adopted, the `prepare-plugin-dist` script keeps `dist/` and `plugins/lsp-mcp/dist/` in sync during dev.
- Betrayal: The script is manual. A future developer runs `bun run build` without calling `bun run prepare-plugin-dist`, commits, and ships a `plugins/lsp-mcp/dist/` that reflects a prior src state.
- Consequence: Silent drift — CC installs a `dist/` that disagrees with `src/`; bugs fixed in code appear unfixed in the plugin.
- Mitigation: **If fallback is adopted, chain it into `build`: `"build": "tsc && bun run prepare-plugin-dist"`.** Do NOT leave `prepare-plugin-dist` as a standalone script that a dev must remember to invoke. Also: the copy step must clean the destination first (`rm -rf plugins/lsp-mcp/dist && cp -r dist plugins/lsp-mcp/dist`) so deleted src files don't leave orphans.

**State Corruption: README partial rewrite**
- Assumption: The agent edits the README incrementally; unedited sections remain coherent.
- Betrayal: The current `## Usage` section intertwines install steps, env-var documentation, and MCP client config example. Edits in one area affect the narrative in another. A partial rewrite that touches "install" but not "MCP client config example" leaves the doc claiming two incompatible install paths without cross-reference.
- Consequence: Reader follows both paths, gets confused, possibly ends up with a half-CC half-manual configuration.
- Mitigation: **Read the entire README once before the edit. Do the Installation insertion + Usage rewrite + MCP client config reframing as a single atomic pass** — not three isolated Edit calls separated by other work. Re-read after to confirm narrative coherence.

**Temporal Betrayal: "single commit" interacts badly with the fallback loop**
- Assumption: The task produces one commit. The skeleton says "Single commit on the current branch staging all the above; not yet pushed."
- Betrayal: If the primary path fails verification, the fallback requires additional changes (script + copied `dist/`). That's either a `git commit --amend` (rewriting the handed-off commit) or a second commit (violating "single commit"). The skeleton doesn't say which.
- Consequence: Agent either amends (risking disruption if the user has already checked out the commit) or creates a second commit (violating the SC), and either way does so without explicit authorization.
- Mitigation: **Treat "single commit" as "single commit per verification attempt."** Primary-path commit is commit #1. If fallback is needed, the fallback's changes land in commit #2 explicitly — not an amend. The final SC is re-read as "each verification attempt's changes are in a single, well-scoped commit; not yet pushed." Update SC wording accordingly.

## Log

- [2026-04-17T12:06:32Z] [Seth] Primary-path scaffolding committed (46b0915) on dev, not pushed. Files: .claude-plugin/marketplace.json, plugins/lsp-mcp/{.claude-plugin/plugin.json,.mcp.json,skills/using-lsp-mcp/SKILL.md}, dist/ (+ .gitignore/README edits). Regression: 64/64 jest tests green. Pre-flight: no 'lsp' MCP name collision (~/.claude.json has only 'deepwiki'). STOP — empirical verification (step 3) requires user in a separate CC session. If primary path fails, fallback protocol in task body; if primary passes, close task.
- [2026-04-17T12:18:20Z] [Seth] Primary path failed empirical verify (cache-escape). Diagnosed via ~/.claude/plugins/cache/lsp-mcp/lsp-mcp/0.1.0/: CC caches plugin subtree only, not repo root — ${CLAUDE_PLUGIN_ROOT}/../../dist/ resolves to a dir that doesn't exist. ${CLAUDE_PLUGIN_ROOT} substitution itself works (cached args still contain literal; substitution at spawn). Applied fallback: package.json build chain now 'tsc + shx rm + shx cp' producing plugins/lsp-mcp/dist/ byte-identical to dist/; .mcp.json updated to ${CLAUDE_PLUGIN_ROOT}/dist/index.js; clean wipes both. 64/64 tests still green.
- [2026-04-17T19:29:30Z] [Seth] Commit #3: refactor to root-as-plugin layout + bundle deps + router tolerance for missing config. (1) Layout: moved .claude-plugin/plugin.json, .mcp.json, skills/using-lsp-mcp to repo root; deleted plugins/lsp-mcp/; marketplace source now '.'. (2) Build: switched tsc to bun build (single bundled dist/index.js, 859KB, all deps inlined); dropped prepare-plugin-dist + dual-dist logic. (3) Router change (TDD, user-authorized scope widening): extracted loadManifests to src/config.ts; added resolveManifests — missing configPath now writes stderr notice and returns []. Regression: 66/66 tests green (64 prior + 2 new config.test.ts). Smoke test passed: bundled server with no config + CLAUDE_PLUGIN_ROOT stays up, MCP stdio transport up. Awaits user re-verify in fresh CC session after cache refresh.
- [2026-04-17T20:02:06Z] [Seth] Commit #3 marketplace schema rejected source='.'; working marketplaces (agent-deck) use source='./'. Fix: one-char change to './'. Commit #4.
- [2026-04-17T20:07:11Z] [Seth] User: '/mcp' still fails, CC reports 'missing env CLAUDE_PLUGIN_ROOT'. Hypothesis: when source='./' puts .mcp.json at the same level as marketplace.json, CC loads it as a top-level MCP config (without plugin context) rather than a plugin MCP config — so CLAUDE_PLUGIN_ROOT isn't bound. Switching to plugin-structure Method 2 (inline mcpServers in plugin.json); removed .mcp.json. Commit #5.
- [2026-04-17T20:21:40Z] [Seth] EMPIRICAL SUCCESS via commit 633ea50. Final layout: root-as-plugin with inline mcpServers in .claude-plugin/plugin.json. Five commits, four failure modes mapped + fixed along the way: (1) primary-path escapes cache, (2) fallback-path missing runtime deps, (3) router exits on no config, (4) marketplace schema rejects '.', (5) top-level .mcp.json doesn't bind CLAUDE_PLUGIN_ROOT. User confirmed '/mcp' shows 'lsp' connected; mcp tool calls (symbol_search, outline, defs) all routed and returned [] (zero manifests, expected). Memory file updated with all findings. Task closing.
