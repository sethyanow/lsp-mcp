---
id: lspm-8cu
title: R9 — using-lsp-mcp skill (polyglot symbol_search-first agent guidance)
status: closed
type: task
priority: 1
parent: lspm-cnq
---






## Context

Closes parent epic `lspm-y5n` R9 and parent sub-epic `lspm-cnq` SC: *"`skills/using-lsp-mcp/SKILL.md` (at repo root) ships with third-person description, specific trigger phrases for polyglot / symbol lookup / cross-language refactor queries, imperative body, concrete examples for Python↔Rust (pyo3), TS↔Go (gRPC), and C embedded in anything. No position-counting from text in examples."*

R9 is the **agent-facing teaching surface** for the lsp-mcp tools. Without it, a Claude Code session that loads the lsp-mcp plugin sees a list of MCP tools (`symbol_search`, `defs`, `refs`, `set_primary`, `list_languages`, etc.) but no guidance on WHEN to reach for them vs falling back to grep/Read. The skill changes the agent's first instinct from "grep + Read + count positions" to "`symbol_search` first; use the returned `(uri, range)` as the anchor for downstream calls."

**Why it matters now (post-R7b):**
The R7b dynamic schemas (commit f216be0) made the MCP tool surface self-documenting — `symbol_search.langs.items.enum`, `set_primary.lang.enum`, `lsp.lang.enum`, etc. all expose the active LSPs at tool-discovery time. The skill can teach: *"inspect the schema's enum to learn which LSPs are routable on this box; no `list_languages` probe round-trip needed."* That's the polyglot UX promise from parent epic R11.

This task does NOT ship:
- README.md updates (acceptance task — `lspm-cnq.md` Acceptance Requirements section).
- Cold CC session demo (acceptance task).
- The R10/R11 path-resolution gates (already closed via lspm-501).

## Starting state (verified on branch `dev`, post-`lspm-4vb` commit 13a0b31)

- `skills/using-lsp-mcp/SKILL.md` exists as a 4-line placeholder:
  ```
  ---
  name: using-lsp-mcp
  description: Placeholder — skill content lands in a subsequent Phase 1 task.
  ---

  Placeholder.
  ```
- `.claude-plugin/plugin.json` ships `mcpServers.lsp` pointing at `${CLAUDE_PLUGIN_ROOT}/dist/index.js`. Skill auto-discovery picks up `skills/*/SKILL.md` from plugin root — no manifest entry needed for the skill itself.
- MCP tool surface (per R7b smoke output recorded in `bn log lspm-4vb`):
  - `symbol_search` — `name`, `kind?`, `langs?: enum[]`, `manifests?: enum[]`
  - `list_languages` — no inputs; returns `{lang, manifest, primary, status, capabilities}[]`
  - `set_primary` — `lang: enum (required)`, `manifest: enum (required)`
  - `defs` / `refs` / `impls` / `hover` / `outline` / `diagnostics` — `file`, `pos`, `via?: enum`
  - `lsp` — `lang: enum (required)`, `method`, `params`, `via?: enum`
  - `call_hierarchy_prepare` / `incoming_calls` / `outgoing_calls` — gated on at least one manifest declaring `capabilities.callHierarchy`
- `skill-reviewer` agent available in plugin-dev plugin (cached at `~/.claude/plugins/cache/claude-plugins-official/plugin-dev/<hash>/agents/skill-reviewer.md`). Acceptance: third-person description, specific trigger phrases, imperative body, 1000–3000 word body, progressive disclosure if body grows.
- `scripts/smoke-mcp-tool.mjs --inspect-schema <tool>` (added in lspm-4vb) is the empirical reference for enum UX claims in the skill.
- Existing `feedback_*` memories for general agent guidance: see `~/.claude/projects/-Volumes-code-lsp-mcp/memory/MEMORY.md`. Most relevant for skill voice: imperative + specific + no fluff.

## Design

### Frontmatter

- `name: using-lsp-mcp` (matches dir; auto-discovered)
- `description:` — third-person, specific. Targets ~250–400 chars (skill-reviewer's "appropriate length" range). Must include trigger phrases an agent would recognize:
  - polyglot / cross-language (the central trigger context)
  - symbol lookup / find symbol across languages
  - cross-language refactor
  - FFI bindings (pyo3, P/Invoke, gRPC, C extensions)
  - "find all callers across X and Y"
  - "where is X defined" / "where is X used" — the most common verbs that would otherwise grep
  - Explicit anti-trigger framing: tasks where Read + grep would miss cross-language semantic links

### Body sections (target ~1500–2200 words; well under the 3000 ceiling)

1. **When this skill activates** (~150 words) — concrete user-prompt examples, contrast with single-language tasks where Read/grep suffice.
2. **The discovery pattern: schema enum → symbol_search → (uri, range) anchor → defs/refs/hover** (~300 words) — the central teaching. Frame each MCP call's role; emphasize that `symbol_search` takes no position so it's the entry verb.
3. **Cross-language examples** (~600 words total, ~200 each) — three full walkthroughs:
   - **Python ↔ Rust via pyo3**: agent investigates a Rust-implemented Python class. `symbol_search("ClassName")` returns hits in `*.rs` (rust-analyzer) + `*.py` (pyright). Follow up `defs` on the `.py` hit lands at the pyo3 binding stub; `defs` on the `.rs` hit lands at the actual implementation. Demonstrates the cross-language anchor handoff.
   - **TypeScript ↔ Go via gRPC**: agent investigates a service called from a TS frontend whose backend is Go. `symbol_search("ServiceMethod")` returns the .proto definition (if a Starlark/proto LSP is configured) plus the Go handler and the TS client stub. Cross-language `refs` shows all call sites.
   - **C embedded in anything (Lua, Python C-extension, FFI)**: agent investigates a function name shared between a `.c` extension module and the binding language. `symbol_search` fans across both. `via: "clangd"` pins downstream queries to the C side when needed.
4. **Tool surface — quick reference** (~250 words) — table of tools with the new schema-enum context. Reference `--inspect-schema` smoke for self-discovery.
5. **Pinning, fan-out scoping, and primary swap** (~200 words) — when to use `via` (single-tool routing), `manifests` (symbol_search fan-out scoping), `set_primary` (session-level primary swap, A/B against forks).
6. **Anti-patterns** (~250 words) — explicit "do not" list:
   - Do NOT count character positions from `Read` output to feed `defs`/`refs`/`hover`. Use `symbol_search` first; the returned `range.start` is the position.
   - Do NOT call `list_languages` before every `symbol_search` — the published schema enum already lists active langs.
   - Do NOT iterate one file at a time with `Read` looking for a symbol when `symbol_search` would fan across the whole workspace.
   - Do NOT pass a `langs:` filter when the symbol's language is unknown — let fan-out find it.
   - Do NOT swap primary mid-session for unrelated reasons; `via` is the per-call escape hatch.
7. **Failure modes the agent should recognize** (~150 words) — `binary_not_found` langs return empty results (informative, not error); `symbol_search` may return 0 hits if the symbol is local-scope (LSP convention). Both are observable in `list_languages` and the schema enum.

### Voice + style invariants

- Third-person description, imperative body. ("To find a symbol across languages, call `symbol_search` first." NOT "You should call symbol_search first.")
- No position-counting examples. Every example chains `symbol_search → defs/refs/hover` using the returned `range.start`.
- Concrete tool calls, not pseudocode. Use the actual MCP tool name (`symbol_search`) and the actual JSON arg shape.
- One-sentence rule per anti-pattern; the WHY in a follow-up clause.

### Progressive disclosure decision

If the body crosses ~2200 words during drafting, split the three cross-language examples into `references/examples-python-rust.md`, `references/examples-ts-go.md`, `references/examples-c-embedded.md`, leaving short summaries inline. Otherwise keep flat — skill-reviewer prefers flat for skills under ~3000 words.

## Implementation

### Step 1 — Replace the placeholder SKILL.md with the full draft

File: `skills/using-lsp-mcp/SKILL.md` (currently 4 lines, placeholder).

Write content per the Design section above. Frontmatter: `name: using-lsp-mcp` + a 250–400 char third-person description naming the trigger phrases. Body: 7 numbered sections per Design, ~1500–2200 words target.

Verify word count: `wc -w skills/using-lsp-mcp/SKILL.md` → target 1500–2500 words (frontmatter excluded; close enough).

### Step 2 — Empirical anchor: capture current schema enums for quoting in the skill

```bash
bun run build
node scripts/smoke-mcp-tool.mjs --inspect-schema symbol_search > /tmp/r9-symbol-search.json
node scripts/smoke-mcp-tool.mjs --inspect-schema defs > /tmp/r9-defs.json
node scripts/smoke-mcp-tool.mjs --inspect-schema set_primary > /tmp/r9-set-primary.json
node scripts/smoke-mcp-tool.mjs --inspect-schema lsp > /tmp/r9-lsp.json
```

If `bun run build` fails or `--inspect-schema` returns no output, HALT and investigate — don't proceed to drafting with invented enum values. The empirical anchor is the guard against the Stale Enum Values failure mode.

Quote the actual enum **shape** (not invented names) in the "Tool surface" section. The skill's claim that "the schema enum lists active LSPs" must reference the real shape: `properties.langs.items.enum: [...]`. If quoting concrete values inline, mark them explicitly as "example from a dev box" — the values rot as the manifest set changes; the shape does not.

### Step 3 — Run the skill-reviewer agent

Invoke via Agent tool: `subagent_type: "plugin-dev:skill-reviewer"`. Prompt: "Review `/Volumes/code/lsp-mcp/skills/using-lsp-mcp/SKILL.md`. Acceptance criteria: third-person description, specific trigger phrases for polyglot / symbol lookup / cross-language refactor queries, imperative body, no position-counting in examples (the skill explicitly teaches against it), 1000–3000 word body. Report findings; do NOT modify the file."

The Agent tool returns the review findings directly as its response — that IS the capture. Optionally tee to `/tmp/r9-skill-review-1.txt` for audit, but the canonical source of findings is the tool's return message, not the file.

### Step 4 — Address findings (REFACTOR-equivalent)

For each finding, decide:
- **Fix in skill content** (most likely category): tighten description trigger phrases, adjust voice from "you" → imperative, condense or expand sections.
- **Reject with reasoning** (rare; only if the reviewer's recommendation conflicts with parent epic R9 or anti-patterns — e.g., reviewer suggests "add a position-counting example" → reject, anti-pattern explicit).

Edit `SKILL.md` to address accepted findings.

### Step 5 — Re-run skill-reviewer; iterate until clean

Same Agent invocation (optionally tee to `/tmp/r9-skill-review-2.txt`, etc., for audit). If still findings, return to Step 4. Cap at 3 iterations — if not clean by then, surface as a blocker, do not silently absorb. Track which findings from iteration N were addressed in iteration N+1 (reviewer can re-flag unchanged issues — that counts against the iteration cap).

### Step 6 — Verify the skill loads cleanly via marketplace cache

The skill is auto-discovered from `skills/*/SKILL.md`. No build step needed for the skill content itself. Confirm by:
1. `cat skills/using-lsp-mcp/SKILL.md | head -10` shows the new frontmatter + body intro.
2. The plugin's MCP server build (`bun run build`) is unaffected by skill content (skill is content-only, not linked into dist).

### Step 7 — Run full suite as regression check

```bash
bun run test > /tmp/r9-test.log 2>&1 && tail -8 /tmp/r9-test.log
bun run typecheck
```

Expect 243 green (no test changes from R9). Typecheck clean.

### Step 8 — Flip sub-epic SC

Edit `.bones/tasks/lspm-cnq.md`:
- Flip SC `skills/using-lsp-mcp/SKILL.md` (at repo root) ships with third-person description... from `[ ]` to `[x]` with satisfaction note pointing at `lspm-8cu`.

### Step 9 — Commit + push

Stage `skills/using-lsp-mcp/SKILL.md`, `.bones/tasks/lspm-8cu.md`, `.bones/tasks/lspm-cnq.md`, `.bones/audit.jsonl`. Commit message notes: R9 SKILL.md ships, skill-reviewer passed (cite iteration count), word count, three cross-language examples included, no position-counting examples, references the R7b dynamic schemas. Acceptance task (README + cold CC session) still open. Push via bare `git push`.

## Success Criteria

- [x] `skills/using-lsp-mcp/SKILL.md` body is no longer a placeholder; replaced with full content per the Design section
- [x] Frontmatter has `name: using-lsp-mcp` and a third-person `description:` between ~250 and ~400 chars naming trigger phrases (polyglot, cross-language, FFI bindings, find symbol across languages) — shipped at 368 chars
- [x] Body is 1500–2500 words (`wc -w` on SKILL.md), 7 sections per Design — shipped at 1822 words
- [x] Body voice is imperative ("To find a symbol, call `symbol_search`") not second-person ("You should call symbol_search") — zero second-person hits
- [x] Three concrete cross-language examples included: Python↔Rust via pyo3, TS↔Go via gRPC, C embedded in another language (Python C-extension)
- [x] All examples chain `symbol_search → defs/refs/hover` using returned `range.start` — NO position-counting from Read output — every numeric `pos` carries `// ← from <lsp>-hit.range.start` provenance comment
- [x] Anti-patterns section explicitly forbids position-counting and "list_languages before every symbol_search" (schema enum is the discovery mechanism)
- [x] Tool surface section references the actual MCP tool input shape captured in Step 2 (not invented enum values) — and correctly splits `hover` (pos required) from `outline`/`diagnostics` (no pos); and `call_hierarchy_prepare {file, pos, via?}` from `incoming_calls`/`outgoing_calls {item, via?}`
- [x] If concrete enum values are quoted inline (e.g., specific lang IDs), each quoted block is marked as "example from a dev box" or equivalent disclaimer — shipped as "Example enum shape from a dev box (exact values depend on the installed LSP set)"
- [x] References `set_primary` for session-level primary swap and `via` for per-call escape hatch — covered in §5 "Pinning, fan-out scoping, and primary swap"
- [x] Calls out `binary_not_found` failure mode (informative empty result, not error) — covered in §7 "Failure modes to recognize"
- [x] `skill-reviewer` agent (via plugin-dev:skill-reviewer subagent) reviews the skill and reports no blocking issues — capped at 3 iterations — passed on iteration 3 of 3; iteration 1 had 2 critical + 2 major + 7 minor (all addressed); iteration 2 had 1 major + 3 minor (1 addressed, 2 rejected with documented reasoning); iteration 3 clean
- [x] If body grows past ~2200 words, the three examples are split into `skills/using-lsp-mcp/references/examples-{python-rust,ts-go,c-embedded}.md` with inline summaries (progressive disclosure). Otherwise keep flat. — body stayed flat at 1822 words; no split needed
- [x] `bun run test` 243 green; `bun run typecheck` clean (no regressions — skill content has no test impact)
- [x] Sub-epic `lspm-cnq` SC for `using-lsp-mcp/SKILL.md` flipped `[ ]` → `[x]` with satisfaction note pointing at `lspm-8cu` — line 61 + line 89 of lspm-cnq.md flipped with full satisfaction note
- [x] Single commit on `dev`, pushed via bare `git push`. Commit notes R9 closed; acceptance task (README + cold CC session demo) still open — commit 9b5fe27

## Anti-Patterns

- **NO position-counting examples in the skill body.** Parent epic anti-pattern R9 explicit: the skill must frame `symbol_search` as the entry verb precisely because it takes no position. An example like "agent reads file with `Read`, counts to character 47 of line 12, calls `defs(file, {line:12, character:47})`" perpetuates the failure mode this product exists to solve. EVERY example chains through `symbol_search` first; downstream calls use `returned.range.start`.
- **NO instructing agents to call `list_languages` before every `symbol_search`.** The published schema enum (R7b) already lists active langs — that's the polyglot UX promise. `list_languages` is for status inspection (which langs are `binary_not_found`?), not for routing prep.
- **NO inventing enum values in examples.** The skill's claims about schema enums must be empirically grounded — quote the shape captured by `--inspect-schema` in Step 2. Made-up enum values rot when the manifest set changes.
- **NO second-person voice ("you should...", "you can..."). Imperative form throughout.** ("To call X, do Y" — not "You should call X by doing Y.") Skill-reviewer flags second-person as a quality issue.
- **NO general MCP tutorial content.** The skill is about lsp-mcp specifically — it assumes the agent already knows what an MCP tool is. Don't explain `client.callTool`. Don't explain JSON Schema. Get straight to the `symbol_search`-first discipline.
- **NO marketing voice ("powerful", "seamless", "robust"). Imperative + specific + no fluff.**
- **NO bypassing skill-reviewer findings as "preference." The reviewer is the acceptance gate.** Only reject a finding if it conflicts with the parent epic R9 or anti-patterns (and document why). Otherwise act on it.
- **NO premature progressive-disclosure split.** Skill-reviewer prefers flat under ~3000 words. Only split into `references/` if the body actually crosses ~2200 words during drafting — don't pre-decompose.
- **NO acceptance overlap. R9 ships SKILL.md only.** README updates and the fresh CC session demo belong to the next task (`lspm-cnq` Acceptance Requirements). Don't bundle.

## Key Considerations

- **Skill auto-discovery scope.** Claude Code picks up `skills/*/SKILL.md` from the plugin root. The skill loads when the user's prompt matches the description's trigger phrases — so description quality directly drives whether the skill ever activates. Trigger phrases must be the words a user would actually type ("find this function across the codebase", "polyglot search", "where's `foo` used in both Python and Rust") — not abstract terms ("cross-language symbol resolution discipline").
- **The skill's voice contrasts with prose docs.** README.md (acceptance task) is descriptive — "lsp-mcp routes ...". The skill is prescriptive — "To find a symbol, call ...". Don't blur the two — keep README factual, keep skill imperative.
- **Schema enum as a teaching anchor.** R7b's dynamic enums are the most teachable feature of the post-R7b state. The skill should walk through `--inspect-schema` once as a self-discovery mechanism: "If you're not sure which LSPs are active, run `node scripts/smoke-mcp-tool.mjs --inspect-schema symbol_search` and read `properties.langs.items.enum`." This grounds the abstract "schema lists active langs" claim in a concrete command.
- **`call_hierarchy_*` tools are gated.** They appear in the tool list only if at least one manifest declares `capabilities.callHierarchy: true`. Skill should mention these as conditional — example: "if call_hierarchy_prepare is in the tool list, you can build a caller tree across languages by chaining its output through incoming_calls."
- **Cross-language examples ground reality.** Each example references a real cross-language pattern (pyo3, gRPC, C extensions). The skill is not pretending to teach LSP — it's teaching when reaching for `symbol_search` is the right move in a polyglot session.
- **Skill-reviewer feedback is the test.** No automated test for skill content. The review is the acceptance gate. Treat its findings like a CI failure — address them all, document any rejections.
- **Word count ceiling matters.** Skill-reviewer flags > 3000 words as bloat. Aim for 1500–2200 to leave headroom; if examples expand, split via progressive disclosure (references/).
- **Trigger description craft tip.** Lead with "This skill should be used when..." (skill-reviewer's preferred opener). Follow with concrete user phrasings in the same sentence. End with the skill's central rule ("Use `symbol_search` as the entry verb; downstream tools use returned ranges as anchors — no position counting.").

### Failure catalog (adversarial planning — completed)

Most standard failure categories (State Corruption, Resource Exhaustion, Encoding Boundaries) don't apply to static markdown content — noted and skipped with reasoning below. The live surface area is: (a) whether the skill activates on the right user queries (Input Hostility), (b) whether examples drift into position-counting or quote stale schema shape (Temporal/Dependency), and (c) whether the reviewer iteration loop converges (Dependency + Temporal).

Grouped by component; each entry follows Assumption → Betrayal → Consequence → Mitigation.

**Skill frontmatter (description)**

- **Activation Failure (Input Hostility).**
  - Assumption: users searching for cross-language references will use "polyglot" / "cross-language" / "FFI" in their prompts.
  - Betrayal: real prompts are everyday ("find every caller of `parse_config`", "where is `ServiceHandler` defined in both the frontend and backend?") and never contain the jargon trigger phrases.
  - Consequence: skill never activates; agent falls back to grep + Read.
  - Mitigation: description includes BOTH jargon triggers AND concrete everyday user phrasings (e.g., "find X across the codebase", "where is Y defined", "refactor Z and its callers"). Skill-reviewer Step 3 re-checks activation coverage.

- **Trigger-phrase truncation (Resource Exhaustion).**
  - Assumption: the full 250–400-char description participates in matching.
  - Betrayal: CC's skill matcher has an undocumented length cutoff; trailing triggers never contribute.
  - Consequence: triggers buried at the end of the description silently don't count.
  - Mitigation: front-load the most common user phrasings in the first sentence; keep the rule-of-thumb ("symbol_search first; no position counting") as the tail, since it's a teaching hook, not a matcher.

**Skill body content**

- **Buried-rules Failure (Input Hostility).**
  - Assumption: the reader (agent or user) reads the whole body.
  - Betrayal: body is skimmed; rules at the end are skipped.
  - Consequence: the most important teaching ("symbol_search is the entry verb") doesn't land if it's only stated in section 6 (anti-patterns).
  - Mitigation: central rule lands in section 2 ("The discovery pattern"), restated in anti-patterns. Redundancy is cheap; burial is fatal.

- **Markdown-rendering quirks (Encoding Boundaries).**
  - Assumption: CC renders inline code with backticks and simple tables cleanly.
  - Betrayal: some markdown hosts mangle pipes inside `|`-delimited tables; backticks in tool names may be stripped by certain loaders.
  - Consequence: `symbol_search` reads as plain prose and loses tool-name semantic.
  - Mitigation: use standard markdown only; avoid nested backticks; if tables get complex, drop to a bulleted list. Not a blocker — just avoid exotic syntax.

**Cross-language examples**

- **Position-Counting Drift (Temporal Betrayal).**
  - Assumption: every downstream `defs`/`refs`/`hover` in an example uses `returned.range.start` from the preceding `symbol_search`.
  - Betrayal: while drafting an example, author writes a concrete `{line: 12, character: 4}` to "make it readable", losing the anchor chain.
  - Consequence: skill teaches the exact anti-pattern it exists to prevent.
  - Mitigation: anti-pattern lock (SC 6); after drafting, spot-grep the file for `character:\s*\d+` — zero matches required. Skill-reviewer also checks.

- **Unrecognized-domain Failure (Input Hostility).**
  - Assumption: reader knows pyo3 / gRPC / C FFI patterns.
  - Betrayal: reader's never seen pyo3; example reads as jargon stack.
  - Consequence: example teaches nothing; skill loses its grounded feel.
  - Mitigation: each example opens with a one-sentence pattern framing ("A Rust crate exposes `ClassName` as a Python class via pyo3 bindings") before the tool-call walkthrough.

**Tool surface section (schema enum references)**

- **Stale Enum Values (Dependency Treachery).**
  - Assumption: enum values captured on the dev box match what readers see.
  - Betrayal: dev box has extra manifests (pyright-fork installed); fresh install only has builtins; enum values diverge.
  - Consequence: reader sees "['python', 'rust', ...]" in the skill but only 1-2 entries in their own schema — believes the skill is broken or misconfigured.
  - Mitigation: quote the enum **shape** (`properties.langs.items.enum: [...]`), not the values. If concrete values are quoted inline for illustration, prefix with "example from a dev box (yours may differ)". New SC added.

- **Smoke-harness drift (Dependency Treachery).**
  - Assumption: `scripts/smoke-mcp-tool.mjs --inspect-schema` stays available.
  - Betrayal: Phase 2 renames or removes the flag; skill's self-discovery guidance rots.
  - Consequence: agent follows the skill's "run --inspect-schema" suggestion and fails.
  - Mitigation: low-probability (harness is a committed Phase 1 contract); if removed in Phase 2, skill update is part of that change's scope. Accept risk.

**Empirical anchor (Step 2 capture)**

- **Stale-bundle capture (Dependency Treachery).**
  - Assumption: `dist/index.js` reflects current `src/`.
  - Betrayal: committed bundle was built from a prior `src/` state; `--inspect-schema` reports old schema.
  - Consequence: skill quotes enum values from stale code.
  - Mitigation: Step 2 runs `bun run build` before `--inspect-schema`; halts on build failure (SRE edit).

**Skill-reviewer iteration loop (Steps 3-5)**

- **Reviewer Vagueness (Dependency Treachery).**
  - Assumption: reviewer returns specific, actionable findings.
  - Betrayal: reviewer returns "consider tightening the description" with no concrete call-out.
  - Consequence: iteration can't converge; agent iterates on vibes.
  - Mitigation: Step 3's prompt already names specific acceptance criteria (third-person desc, imperative body, no position-counting). If reviewer output is still vague after iteration 1, treat vagueness itself as a blocker — surface to user, don't keep iterating.

- **Reviewer re-flagging (Temporal Betrayal).**
  - Assumption: between iterations, reviewer reads the new file fresh.
  - Betrayal: reviewer's context carries prior-iteration memory; re-flags issues already addressed.
  - Consequence: iteration count inflates on phantom findings; hits cap without real progress.
  - Mitigation: Step 5 explicitly tracks which findings were addressed between iterations (SRE edit); unchanged re-flags count against cap.

- **Subagent unavailability (Dependency Treachery).**
  - Assumption: `plugin-dev:skill-reviewer` is registered this session (verified — cache exists at `plugin-dev/98e39a661d82/agents/skill-reviewer.md`).
  - Betrayal: plugin-dev plugin unloaded or agent type removed before this task runs.
  - Consequence: Step 3 fails with "unknown subagent_type".
  - Mitigation: verified available at SRE time. If this fails at execution, escalate — don't silently substitute a direct-Claude review, since the skill-reviewer is the acceptance gate in SC 11.

**Anti-patterns section**

Skipped categories: Input Hostility (rules, not inputs); Temporal (static); State Corruption (static); Resource Exhaustion (section is ~250 words). Dependency Treachery partially: anti-patterns reference tool names (`list_languages`, `via`) which are Phase 1 contract and stable.

## Dependencies

- **Blocks:** `lspm-cnq` (parent sub-epic; R9 is the last implementation SC before acceptance)
- **Blocked by:** none — all R1-R8 + R7b implementation tasks are closed; the MCP tool surface is fully delivered; the skill teaches that surface
- **Unlocks:** Phase 1 acceptance task (README updates + cold CC session demo). After both close, sub-epic `lspm-cnq` closes and Phase 2 sub-epic `lspm-erd` becomes ready.

## Log

- [2026-04-20T15:16:45Z] [Seth] SRE (fresh session): all 10 categories pass. Claims spot-checked: SKILL.md placeholder ✓, plugin.json path ✓, smoke-mcp-tool.mjs --inspect-schema ✓ (live output shows 13 tools, symbol_search.langs.items.enum populated), skill-reviewer cached at plugin-dev/98e39a661d82/ ✓, 243 test baseline ✓, call_hierarchy_* published (≥1 manifest declares capabilities.callHierarchy on dev box). Two gap-fills made (no redesign): (1) Step 2 — halt-if-build-fails guard added; quoted enum values must be marked 'example from a dev box' to prevent stale-value drift. (2) Steps 3+5 — clarified that the Agent tool return message IS the capture; /tmp files are optional audit logs, not required. Strengths: Design spec is detailed (7 sections, word targets), empirical anchor in Step 2, 9 lockworthy anti-patterns, 4-entry failure catalog seeded for adversarial-planning. No redesign — skeleton's design choices (third-person desc, imperative body, three examples, flat-unless-2200w) kept as-is.
- [2026-04-20T15:19:25Z] [Seth] Adversarial planning complete. Failure catalog: 7 components walked (frontmatter, body, examples, tool surface, empirical anchor, reviewer loop, anti-patterns). 12 catalog entries across 5 categories. One new SC emerged: quoted enum values must carry 'example from a dev box' disclaimer (Stale Enum Values mitigation). Key risk clusters: (1) Input Hostility in description — users don't use jargon, so description must front-load everyday phrasings. (2) Temporal in examples — position-counting drift would self-defeat the skill; anti-pattern + spot-grep + reviewer is triple-lock. (3) Dependency in reviewer loop — vague reviewer output → escalate; phantom re-flagging → counts against cap (SRE edit). All mitigations are structural (anti-patterns, Step 2 halt-on-fail, Step 5 re-flag tracking, description front-loading). No design changes; 1 new SC.
- [2026-04-20T15:37:29Z] [Seth] Debrief: shipped 1822-word SKILL.md with three cross-language examples (pyo3, gRPC, C-ext), 6 anti-patterns, failure-modes section, provenance comments on every numeric pos. No workarounds. Design emerged: 'example from a dev box' disclaimer on inline enum values (Stale Enum Values mitigation from adversarial-planning) became a new SC; iteration 2's manifest/manifests plural/singular finding surfaced that schema has BOTH forms (symbol_search plural, set_primary singular); example 3's via: clangd pedagogical framing added during iteration 2. Toolchain surprise: skill-reviewer iteration 1 caught 2 critical tool-signature bugs (hover vs outline/diagnostics grouping; incoming/outgoing_calls input shape) by reading src/mcp-server.ts directly — high-signal review. Iteration 2 miscounted tools (13 actual vs 12 claimed) — reviewer fallible, source authoritative. 3 iterations to converge, well within cap. Next task inherits: phase 1 acceptance task (README updates + zero-env-vars smoke + cold CC session polyglot demo) — MCP tool surface is self-documenting via R7b schemas, so demo can lead with --inspect-schema. Reflections: skeleton accurate (2 minor SRE gap-fills, 1 new SC from adversarial); 3-iteration reviewer loop converged cleanly; rejected-finding documentation pattern worked (M1/M3 on iteration 2 rejected with documented reasoning, reviewer iteration 3 did not re-flag). No user corrections. One new reference memory written: skill-reviewer as content-task acceptance gate.
