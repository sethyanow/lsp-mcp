---
name: MVP glue accepts coupling — don't over-engineer against undocumented platforms
description: When shipping integration glue against undocumented platform internals (CC plugin cache, vendor APIs, etc.), accept the coupling rather than building escape hatches or option-trees. Verify assumptions with authoritative-source agents (claude-code-guide, docs fetch) — never infer from your own machine's config.
type: feedback
originSessionId: 0918b3c8-e52a-4015-b1c5-364b6657d0a3
---
Rule: When writing integration glue against an undocumented platform dependency, accept the coupling rather than building abstraction layers, user-configurable escape hatches, or multi-option design menus to hedge hypothetical platform changes. Verify platform assumptions with authoritative-source agents — don't infer from your own install.

**Why:** Session 2026-04-19, R8c plugin-tree walker. The walker scans CC's plugin cache for sibling `lsp-manifest.json` files. CC's cache layout, active-version selection, and sibling-discovery APIs are all officially undocumented (`claude-code-guide` confirmed). I caught myself doing all three failure modes:

1. Reaching for `ls ~/.claude/plugins/cache/` to decide scan depth from my own install — probing personal state to settle design.
2. Presenting a 3-option menu (ship-and-accept-coupling, user-pointed-root, pointer-file-opt-in) with catastrophizing language about "unstable substrate" — framing a coupling as existential.
3. Generating preemptive abstraction layers (env-var escape hatches, manifest-field opt-in) to hedge against hypothetical future CC changes.

User corrections (both apt):
- *"calm down, this isn't a beautiful and unique snowflake it's one bit of tooling for claude here. step back and consider the intention of this effort here."*
- *"ask the claude code guide don't just guess based on my personal config. chat with me after about this don't just go 'okay check the box hurrrr' and ignore the user here"*

**How to apply:**

- Classify code as *glue* vs *platform infra* before scoping uncertainty. Glue accepts coupling; infra justifies abstraction. R8c is glue — one walker, one fix on breakage, not a sovereign registry.
- For any question about a shared platform (CC, Anthropic SDK, git conventions, etc.), invoke the authoritative-source agent (`claude-code-guide` for CC, `WebFetch` on docs) *before* inferring from your local install. Personal probes feed implementation tactics; authoritative sources settle design.
- When hearing yourself catastrophize a coupling ("unstable substrate," "could change without notice"), re-examine scope. Undocumented doesn't mean volatile — it means "we're first." If a future break is one-walker to fix, the coupling isn't load-bearing.
- If you're about to present a 3+ option menu where one is "the obvious answer" and the others are escape hatches, that's decision-laundering disguised as thoroughness. Pick one and commit; surface escape hatches only when the user asks.
