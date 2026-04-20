---
id: lspm-xxk
title: 'Phase 1 Acceptance: README + zero-env-vars smoke + cold CC session polyglot demo'
status: open
type: task
priority: 1
parent: lspm-cnq
---

## Context

Closes sub-epic `lspm-cnq` (Phase 1: Core plugin + multi-candidate routing). All implementation SCs (R1-R9) are satisfied by prior tasks: `lspm-501` (marketplace/plugin scaffolding + path resolution), `lspm-z4z` (multi-candidate routing), `lspm-177` (default manifest library), `lspm-hlm` (PATH probe), `lspm-rot` (list_languages), `lspm-zw9` (set_primary), `lspm-h1n`+`lspm-kgj`+`lspm-mcp` (layered manifest discovery), `lspm-4vb` (R7b dynamic schemas), `lspm-8cu` (using-lsp-mcp skill).

This task is the final acceptance gate before Phase 1 sub-epic closes and Phase 2 (`lspm-erd` — fork wrappers + settings + authoring) unblocks.

**Two deliverables:**

1. **Agent Documentation** — update stale sections of `README.md` to reflect shipped Phase 1 surface (marketplace install, tool inventory including `list_languages` / `set_primary` / `via` / `manifests`, `LSP_MCP_MANIFESTS_DIR` env var, layered discovery chain). No new summaries or tutorials — the code and bones carry the details.
2. **User Demo** — cold Claude Code session, plugin installed via marketplace, real polyglot repo in view. Walk through `list_languages` / `symbol_search` / `defs` / `via` / `set_primary` / `binary_not_found` error path. Demo seed lives in `.bones/tasks/lspm-cnq.md` → User Demo section (lines 91-98).

## Starting state (verified on branch `dev`, post-`lspm-8cu` commit 9b5fe27)

- Parent sub-epic `lspm-cnq` has 10 of 11 children closed; `lspm-xxk` (this task) is the final child.
- `.claude-plugin/marketplace.json` + `.claude-plugin/plugin.json` ship at repo root; plugin installs cleanly via marketplace (verified by lspm-501).
- `dist/index.js` is the bundled MCP server (`bun build --target node`); committed.
- `manifests/` ships 12 default manifests; PATH probe excludes `binary_not_found`; 13 MCP tools published when callHierarchy-capable manifests are active.
- `skills/using-lsp-mcp/SKILL.md` shipped at 1822 words (lspm-8cu); description/trigger phrases in place for skill auto-discovery.
- `scripts/smoke-mcp-tool.mjs` ships with `--inspect-schema` flag; portable (resolves `dist/index.js` relative to script).
- 243 tests green; typecheck clean; no regressions.
- Outstanding sub-epic SCs satisfied by THIS task:
  - [ ] `bun run test` passes (verify still green at acceptance time)
  - [ ] Router with zero env vars + stdio smoke
  - [ ] Fresh CC session demo (the User Demo)
  - [ ] Acceptance Req #1: README.md updates

## Deliverable 1 — Agent Documentation

### README.md — stale sections only

Read `README.md` in full first; only then update. Working principle: README reflects what the code actually does on `dev` today. No new sections, tutorials, or expository content.

**Target updates:**

- **Installation section** — add marketplace install path: `/plugin install lsp-mcp` (or equivalent CC command). Remove any "coming soon" or local-install-only framing.
- **Tool Surface section** — add / update listing to cover all 13 MCP tools with their current argument shapes:
  - `symbol_search {name, kind?, langs?, manifests?}`
  - `list_languages` (no args)
  - `set_primary {lang, manifest}` both required
  - `defs` / `impls` / `refs` `{file, pos, via?}`
  - `hover {file, pos, via?}` (pos required)
  - `outline` / `diagnostics` `{file, via?}` (no pos)
  - `lsp {lang, method, params, via?}`
  - `call_hierarchy_prepare {file, pos, via?}` (gated)
  - `incoming_calls` / `outgoing_calls` `{item, via?}` (gated)
- **Configuration section** — document the env vars:
  - `LSP_MCP_CONFIG` (single-file manifest, hard-exit on parse error)
  - `LSP_MCP_MANIFESTS_DIR` (dir-based; soft-skip on parse error)
  - `LSP_MCP_ROOT` / `LSP_MCP_PLUGINS_DIR` (plugin-tree overrides, post-lspm-mcp)
  - `CLAUDE_PLUGIN_ROOT` (auto-set by CC; plugin-tree glob root)
- **Layered discovery** — document the 4-source merge order (builtin → plugin-tree → config-file → manifests-dir, later wins on name collision, stderr on conflict).
- **MCP client config example** — add a working example for marketplace-install path using `${CLAUDE_PLUGIN_ROOT}/dist/index.js`.

Stale content to remove if present:

- Any "Phase 2 / fork wrappers" language framed as current state.
- Any `plugins/lsp-mcp/` subtree references (repo is root-as-plugin since lspm-501).
- Any instructions assuming `${CLAUDE_PLUGIN_ROOT}/../../dist/` path (obsolete per lspm-501).

**Verification:**

```bash
rg -n 'plugins/lsp-mcp/' README.md && echo "stale path refs found" || echo "clean"
rg -n 'coming soon|Phase 2' README.md  # review matches; remove if stale
```

### CLAUDE.md — no updates expected

`CLAUDE.md` was refreshed in `lspm-501` to reflect the root-as-plugin layout and smoke-test command. Re-read; only update if something has drifted since. If nothing is stale, note "no updates needed" and move on.

## Deliverable 2 — User Demo

Demo content seed lives in `.bones/tasks/lspm-cnq.md` → User Demo section (lines 91-98). This section defines the format; the sub-epic defines what to show.

### Environment Setup

Every step. Nothing assumed.

1. **Rebuild** the bundled MCP server:
   ```bash
   cd /Volumes/code/lsp-mcp
   bun run build
   ```

2. **Zero-env-vars stdio smoke** (satisfies sub-epic SC "Router with zero env vars..."):
   ```bash
   LSP_MCP_CONFIG=/nonexistent node dist/index.js < /dev/null 2>&1 | head -10
   ```
   Expected: stderr reports `[lsp-mcp] loaded N manifests (builtin: N)` and `[lsp-mcp] N manifests have binary_not_found: ...`. No crash; clean exit on stdin close.

3. **Full test suite** still green (satisfies sub-epic SC "bun run test passes"):
   ```bash
   bun run test 2>&1 | tail -5
   ```
   Expected: 243 tests passed, 7 suites.

4. **Fresh Claude Code session** — close any existing CC sessions. Open a new CC session in a real polyglot repo (not lsp-mcp itself — a real user repo mixing Python + Rust, or TS + Go, or similar). Install the plugin via marketplace:
   ```
   /plugin marketplace add <repo-url-or-local-path>
   /plugin install lsp-mcp
   ```
   Verify `/mcp` shows `lsp` server connected.

### Demo

Walk through each step; capture observable output.

1. **`list_languages`** — call the MCP tool. Expected: rows for each manifest with `{lang, manifest, primary, status, capabilities}`. Some manifests show `status: "ok"`; others show `status: "binary_not_found"` depending on which LSP binaries are on PATH.

2. **Schema self-discovery** — inspect the tool schema to see which langIds are routable:
   ```bash
   node scripts/smoke-mcp-tool.mjs --inspect-schema symbol_search | head -40
   ```
   Expected: `properties.langs.items.enum` lists active langIds; `properties.manifests.items.enum` lists active manifest names. `binary_not_found` manifests excluded from both enums.

3. **`symbol_search` cross-language** — pick a symbol name that exists across language domains in the real polyglot repo. Example choices: a pyo3 class name, a gRPC service method, a shared type name in TS/Go stub pairs. Call:
   ```json
   symbol_search({"name": "<the-symbol>"})
   ```
   Expected: hits across files with different extensions, each with correct `(uri, range)` and `manifest` fields identifying which LSP served the hit.

4. **`defs` follow-up using returned anchor** — pick one hit from #3. Feed its `range` directly to `defs`:
   ```json
   defs({"file": "<uri-from-hit>", "pos": {"line": <hit.range.start.line>, "character": <hit.range.start.character>}})
   ```
   Expected: `defs` returns the definition location. No character-position counting from Read output — the agent uses what `symbol_search` returned.

5. **`via` parameter demonstration** — pick a hit claimed by one specific manifest. Call `defs` with explicit `via`:
   ```json
   defs({"file": "<uri>", "pos": <pos>, "via": "<specific-manifest-name>"})
   ```
   Expected: `defs` routes to the named manifest; same result shape as #4 but pinned.

6. **`set_primary` demonstration** — pick a langId with multiple active candidates (if applicable on the demo box; if not, use any lang with exactly one candidate to demonstrate the no-op response). Call:
   ```json
   set_primary({"lang": "<langId>", "manifest": "<manifest-name>"})
   ```
   Expected: swap succeeds; next `list_languages` reflects the new primary. If already primary, the call is a no-op and stderr logs the unchanged state.

7. **`binary_not_found` error path** — pick a lang visible in `list_languages` with `status: "binary_not_found"` (e.g., `bash` if bash-language-server is not installed). Call:
   ```json
   symbol_search({"name": "whatever", "langs": ["bash"]})
   ```
   Expected: schema-level rejection (the `langs` enum excludes `binary_not_found` langIds) OR empty result with informative message — NOT a hard tool error.

### Sign-Off

- [ ] `bun run build` produces `dist/index.js` without errors
- [ ] Zero-env-vars stdio smoke loads 12 builtin manifests and reports the binary-not-found summary
- [ ] `bun run test` passes 243 green
- [ ] Fresh CC session: `/mcp` shows `lsp` connected
- [ ] `list_languages` returns rows for all manifests (both `ok` and `binary_not_found`)
- [ ] Schema `--inspect-schema symbol_search` shows active-only enums (excludes `binary_not_found`)
- [ ] `symbol_search` on a real polyglot repo returns cross-language hits with correct `(uri, range)` per hit
- [ ] `defs` follow-up using a returned `range` anchor resolves correctly (no position counting from Read)
- [ ] `via` parameter scopes a single query to a named manifest
- [ ] `set_primary` mutates the primary for a langId; `list_languages` reflects the change
- [ ] `binary_not_found` lang returns empty/schema-rejected rather than crashing
- [ ] README.md stale sections updated per Deliverable 1
- [ ] Phase 1 sub-epic `lspm-cnq` complete — ready for Phase 2 (`lspm-erd` fork wrappers + settings + authoring)

## Implementation order (agent-facing)

1. Read `README.md` in full. Identify stale sections per Deliverable 1 target list.
2. Apply README updates. Verify with `rg` checks above. Commit with a clear message ("Phase 1 acceptance: README updates — marketplace install, Tool Surface, env vars, layered discovery").
3. Run the zero-env-vars stdio smoke. Capture output to `/tmp/r-acc-smoke.log`. Include in the demo summary.
4. Run `bun run test`. Confirm 243 green.
5. Present the Demo section to the user in the conversation — do NOT bury it in the task body. The user runs the fresh CC session portion themselves. The agent cannot verify the marketplace install path or the plugin UX from its own session.
6. STOP. The user closes this task after running the demo and confirming the sign-off list.

## Anti-Patterns

- **NO grep-as-demo.** Do not use `grep -r` or `rg` hits as demo steps. The demo shows product behavior — `symbol_search` returning cross-language hits — not a grep finding a string.
- **NO tests-as-demo.** `bun run test` is a regression check (Environment Setup #3), not a demo step. Tests already passed when implementation SCs were checked off.
- **NO inventing demo steps from success criteria.** The demo content comes from the sub-epic's User Demo section (lines 91-98), already captured during brainstorming. If something is unclear, ASK — don't invent.
- **NO new documentation files.** Update `README.md` only. No new tutorials, no new walkthroughs, no "phase 1 summary" files. If a user needs more context, the skeletons and commit history carry it.
- **NO CLAUDE.md tutorials.** If anything in CLAUDE.md is stale, update it in place. Do not append new sections documenting what was built.
- **NO self-closing the task.** The agent STOPs after presenting the demo. The USER runs the demo and closes the task. The agent only closes if the user delegates explicitly.
- **NO bundling into a single commit.** Suggest splitting: (a) README updates, (b) any CLAUDE.md drift fixes, (c) smoke log + demo presentation. Let the user choose.

## Key Considerations

- **Demo is in the user's environment, not the agent's.** The agent can run `bun run build`, `bun run test`, and the zero-env-vars smoke from its session. It cannot run a fresh CC session with the marketplace-installed plugin. Present the demo steps; the user runs them.
- **Real polyglot repo is user-held.** The demo requires a non-lsp-mcp repo for the `symbol_search` walk. Any of the user's existing checkouts with cross-language bindings will do; the agent doesn't pick this — the user does.
- **README stale-only discipline.** The README is a living doc. Adding new sections creates drift. If a section doesn't exist for something the phase built, the question is whether that thing belongs in README at all — sometimes it belongs in a skill (already shipped for the agent-facing surface) or the bones skeleton (for decision history). Default to minimum useful README.
- **Phase 2 is now contract-bound to Phase 1's tool surface.** Once this task closes and `lspm-cnq` closes, Phase 2 fork wrappers will ship against the tool signatures documented in `README.md` + `SKILL.md`. Any README inaccuracy here propagates into Phase 2 expectations. Ground the doc in `src/mcp-server.ts`, not memory.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic — this task is the last unblocked gate)
- **Blocked by:** none — all R1-R9 implementation tasks closed
- **Unlocks:** Phase 2 sub-epic `lspm-erd` (fork wrappers + settings + authoring-lsp-plugin skill + lsp-mcp-settings skill + validate-manifest utility)
