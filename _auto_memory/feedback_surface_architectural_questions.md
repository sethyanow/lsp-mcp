---
name: surface architectural questions in chat, don't defer them to SRE
description: When scoping a task surfaces a load-bearing design question (multiple valid interpretations with different architectural implications), present it to the user in chat immediately. Do NOT defer to SRE with "SRE will decide."
type: feedback
originSessionId: eb135b9a-a838-4af9-93c3-122d1ba14bd9
---
When scoping a task surfaces a question with multiple valid interpretations that shape architecture or cross-cutting intent, **present it to the user in chat right then**. Do not defer to SRE-refinement with phrasing like "SRE must lock one interpretation before execution."

**Why:** Session 2026-04-19 — while scoping lspm-mcp (R8c), I identified scope of `$CLAUDE_PLUGIN_ROOT` scan as (A) root-itself vs (B) sibling-plugins, each with meaningfully different architectural implications. I wrote it into the skeleton as "DESIGN DECISION — SRE must confirm or redirect before execution." User immediately redirected: the question wasn't an SRE-refinement concern, it was about *what we're actually building* — which informs the whole toolkit-family architecture. Deferring to SRE would have either (a) SRE guessing at user intent, or (b) SRE kicking it back to user anyway with extra latency.

**How to apply:**

- SRE's role is catching implementation gaps, edge cases, ambiguous criteria, and fresh-session review of scoped details. SRE is not a user-intent oracle.
- If a question has multiple valid answers with different *product* or *architectural* consequences, that's a user decision. Present options + trade-offs in chat; let the user redirect before implementation.
- The test: "Could two competent engineers reasonably pick differently, and would the choice propagate to other decisions?" If yes, surface to user.
- If the answer only affects *how* the scoped work is executed (choice of data structure, naming, test style), SRE can handle it.
- Skeleton markers like "DESIGN DECISION — SRE must confirm" are a code smell. Either answer it yourself (implementation detail), answer it with the user (architectural), or explicitly note it as an open-question flag the user should resolve before SRE.
