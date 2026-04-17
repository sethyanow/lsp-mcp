---
id: lspm-eue
title: 'Phase 2: Fork wrappers + settings + authoring'
status: open
type: epic
priority: 1
depends_on: [lspm-cps]
parent: lspm-m3f
---




## Context

Parent epic: `lspm-m3f`, Phase 2. Depends on Phase 1 (`lspm-cps`).

Phase 1 delivers the core product: marketplace + core plugin + multi-candidate routing + default manifests + `using-lsp-mcp` skill. Phase 2 adds the layers that reward users who've been forking LSP tooling (the audience this product was specifically built for) plus the per-project override mechanism plus the docs/tooling for external contributors.

## Requirements

Covers parent epic's Phase 2 concerns:
- Fork wrappers for `pyright-fork`, `zls-fork`, `markymark`, each with: `lsp-manifest.json` consumed by Phase 1's plugin-tree auto-discovery, `buildHook` that clones + builds the fork, a standalone install script exposing the same build logic for non-CC users (parent R11), a fork-specific skill highlighting the MCP improvements, CI smoke test hitting the built server.
- `.claude/lsp-mcp.local.md` settings file (CC path) + `LSP_MCP_SETTINGS` env fallback (non-CC path) + `~/.config/lsp-mcp/settings.md` XDG fallback. YAML frontmatter: `disabled:` list, `overrides:` map keyed by manifest name with per-manifest field overrides (cmd, initOptions, capabilities), `primary:` map for per-lang primary pinning.
- `authoring-lsp-plugin` skill: schema reference, buildHook patterns, capability flag semantics, PATH-probe contract, how fork wrappers integrate.
- `lsp-mcp-settings` skill: user-facing config walkthrough; common scenarios (disable a default, override initOptions, pin a fork as primary, point at a non-CC settings file).
- `validate-manifest` utility: validates any JSON manifest against the schema; surfaces common errors (missing langIds, unreachable binary, conflicting capability flags).
- Default manifest library expansion beyond Phase 1 R2 contract (csharp candidates, additional langs as user demand surfaces).

## Success Criteria

- [ ] `plugins/pyright-fork/`, `plugins/zls-fork/`, `plugins/markymark/` exist with `.claude-plugin/plugin.json`, `lsp-manifest.json`, fork-specific `skills/*/SKILL.md`, and standalone install script. Phase 1 auto-discovery picks up their manifests without Phase 1 code changes.
- [ ] Each fork wrapper's `buildHook` is idempotent (re-run does not re-download if build artifacts present) and produces a runnable binary referenced by the manifest's `cmd`.
- [ ] Each fork wrapper's standalone install script (e.g., `plugins/pyright-fork/install.sh`) produces the same build result as `buildHook` and is runnable outside CC (no `${CLAUDE_PLUGIN_ROOT}` dependency).
- [ ] CI job runs each fork's buildHook, starts the built binary, and hits a trivial LSP request (`initialize`); smoke test passes.
- [ ] Settings parsing: `.local.md` / `LSP_MCP_SETTINGS` / XDG fallback discovered in that priority order (first wins). YAML frontmatter parsed; malformed YAML logged to stderr and defaults applied (no silent partial overrides).
- [ ] Settings applied after PATH probe, before routing-map construction. `disabled:` removes manifests; `overrides:` mutates fields on matched manifests; `primary:` sets per-lang primary overriding default (first-registered) choice.
- [ ] Settings changes require router restart; `lsp-mcp-settings` skill and README document this.
- [ ] `authoring-lsp-plugin` SKILL.md ships with schema reference, concrete manifest examples, buildHook patterns (clone-and-build, npm-install, prebuilt-binary-fetch), capability flag semantics, and passes `skill-reviewer` agent review.
- [ ] `lsp-mcp-settings` SKILL.md ships with the settings schema, common scenarios as code blocks, and passes `skill-reviewer` review.
- [ ] `validate-manifest` utility: CLI invocation `node dist/validate-manifest.js <path>` or `npm run validate -- <path>` produces human-readable pass/fail output; used in CI to validate every shipped manifest.
- [ ] All pre-existing Phase 1 tests pass plus new Phase 2 tests: settings parsing, settings application (disable / override / primary), fork buildHook idempotency, validate-manifest against valid + invalid fixtures.

## Anti-Patterns

Inherited from parent epic. Phase-2-specific reinforcements:

- **NO fork wrappers that uninstall or shadow stock manifests by name.** Must coexist as candidates per R4.
- **NO settings parsing that silently ignores malformed YAML.** Error + fallback to defaults; don't partial-apply.
- **NO skill files that teach position-counting.** All examples use `symbol_search` → anchor → positional op chain.
- **NO CI smoke test that mocks the fork binary.** The test must exercise the actual buildHook output against a real LSP startup. Otherwise the test fails to catch fork-upstream regressions.
- **NO standalone install script that `curl | bash`s from the network without a pinned commit/tag.** Forks are pinned; upgrades are explicit.

## Key Considerations

- **Fork upstream drift**: Each fork tracks a moving target (`sethyanow/pyright` dev branch, `sethyanow/zls` dev branch, `sethyanow/markymark` main). buildHook must pin to a specific commit or tag, not track a branch head, to prevent silent breakage. Bumping the pin is a deliberate act.
- **buildHook timeout budget**: Phase 1 task `476a855` already addressed buildHook stdio + warm-up timeout budget (per recent commit history). Phase 2 fork buildHooks must respect that budget — clones + npm installs + builds may bump against it. First-run-takes-N-minutes is user-observable; subsequent runs must be fast due to idempotency.
- **Standalone install script parity**: The install script and buildHook must produce bit-identical build output for the same pin. Divergence is a regression.
- **Settings schema versioning**: If settings file schema evolves, how do users know? Recommend a top-level `version:` field; parser warns (not errors) on unknown version but still attempts best-effort parse. Worth discussing at Phase 2 brainstorming.
- **Per-lang primary conflict**: Settings `primary:` map overrides first-registered default. What if a user pins a manifest that's `binary_not_found`? Logged error; fall back to first-registered among `ok`-status candidates; user sees the fallback in `list_languages`.
- **CI smoke test sandboxing**: Each fork's buildHook touches network (clone) and disk (build). CI must sandbox these (temp dir per test; network allowed for clone); must not affect committed repo state.
- **`.local.md` vs `LSP_MCP_SETTINGS` priority**: First source wins (per earlier discovery). If a user sets both, explicit env wins over convention — this is the ergonomic choice for CI overrides.

## Acceptance Requirements

**Agent Documentation:** Update stale docs only.
- [ ] `README.md`: add marketplace section describing the fork plugins; add `Configuration` section for settings file with full schema; add `Non-CC usage` section covering env-based settings + manifest discovery.
- [ ] Any Phase 1 docs that referenced "fork support coming in Phase 2" get updated to point at the shipped fork plugins.

**User Demo (PROPOSED — confirm during Phase 2 brainstorming):**
Single CC session, polyglot repo, cold cache.
- Install `pyright-fork` via the marketplace. Both `pyright` (stock from PATH) and `pyright-fork` now appear as candidates in `list_languages` for Python.
- Reproduce a cold-cache scenario that stock pyright botches (long timeout, partial result, or whatever the current pyright-mcp Phase 5 repro demonstrates). Run the same query via `manifests: ["pyright-fork"]` — observable diff in one session, no uninstall required.
- Write `.claude/lsp-mcp.local.md` pinning `pyright-fork` as primary for Python via `primary: {python: pyright-fork}`. Restart CC. Verify `list_languages` now shows fork as primary for Python without any `via` parameter on queries.
- Edit settings to `disabled: [bazel-lsp]`. Restart. `list_languages` no longer reports bazel-lsp as active; `starpls` remains as the only bazel-lang candidate.
- Error path: break the settings YAML deliberately. Restart. Router logs a parse error to stderr and falls back to defaults. `list_languages` reflects defaults, not partial overrides.
