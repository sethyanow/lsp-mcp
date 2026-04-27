---
name: skill-reviewer as content-task acceptance gate
description: For skill/docs tasks where no code tests exist, plugin-dev:skill-reviewer subagent functions as the RED/GREEN equivalent — invoke it with explicit acceptance criteria and iterate until clean.
type: reference
originSessionId: aefedb97-bbc9-4eba-8d05-f1e7122344cb
---
**Pattern.** When shipping skill content, prose, or other documentation where there are no unit tests to fail, the `plugin-dev:skill-reviewer` subagent serves as the acceptance gate. The loop:

1. Draft the content to spec.
2. Invoke `Agent(subagent_type="plugin-dev:skill-reviewer", prompt=<file path + explicit acceptance criteria + any rejected-finding reasoning from prior iteration>)`.
3. Apply fixes for accepted findings; explicitly document rejected findings with reasoning (so iteration N+1's reviewer context shows they were considered).
4. Re-invoke with the rejected-finding-reasoning included in the prompt.
5. Cap at 3 iterations; surface as blocker if not clean.

**Why it works.**
- Reviewer enforces third-person description, imperative voice, progressive-disclosure thresholds, trigger-phrase specificity.
- On iteration 1 of lspm-8cu, it caught two critical tool-signature bugs (`hover` vs `outline`/`diagnostics` grouping; `incoming_calls`/`outgoing_calls` taking `item` not `file, pos`) by reading `src/mcp-server.ts` — higher-signal than a typo check.
- Rejected-finding documentation prevents phantom re-flagging on next iteration.

**Gotchas.**
- Reviewer is still fallible — verify specific claims (e.g., tool count) against source before acting.
- Reviewer may miscount or conflate closely-named fields; source is authoritative.
- Works because the MCP tool surface is stable and documented in `src/mcp-server.ts`; if a skill teaches a less-grounded surface, reviewer has less to verify against.

**When to apply.**
- Shipping any `skills/*/SKILL.md`.
- Any content task where the acceptance criterion is "doc quality" rather than "code behavior."
- Phase 2 of lsp-mcp will ship `authoring-lsp-plugin` and `lsp-mcp-settings` skills — same pattern applies.
