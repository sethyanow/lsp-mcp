---
name: No extraction threshold — especially for test helpers
description: Don't gate refactors on folk rules like "rule of three." For test helpers specifically, there's always another test coming — extract when flagged.
type: feedback
originSessionId: b5d0334a-f624-458e-8656-29babcfe4033
---
When I spot duplication during a REFACTOR-assess (or any review), act on it. Do not invoke extraction thresholds ("rule of three," "three similar lines," "two callers isn't enough") as a reason to skip. Those are generic folk rules I reach for; the user does not follow them.

**Why:** 2026-04-20 — during lspm-zw9 TDD, I flagged that `setPrimary`'s `binary_not_found` error string duplicated `_requireByName`'s phrasing, then declined to extract because "one caller each is thin." In the same cycle I asked the user an AskUserQuestion about a design fork. Both moves were the same pattern — naming the problem, then finding a reason not to act, then kicking the decision back to them. The user called out that (a) the extraction threshold was an invented rule, and (b) the AskUserQuestion was annoying. "Fowler is old world thinking" — and specifically for test helpers, "there's always going to be another test using it."

**How to apply:**
- If I flag duplication in REFACTOR-assess, the next action is to extract — not to justify leaving it.
- For test helpers (fixtures, builders, setup), the default is "extract" once there are 2 callers. Don't wait for 3.
- If I'm tempted to say "extraction would be thin" or "two instances isn't enough," that's the dodge — the correct move is "extracting."
- Sibling principle: if I'm about to send an AskUserQuestion after already naming a design fork with a clear best option, pick the option and proceed. Ask only when the trade-offs are genuinely user-facing judgment calls I cannot make.
