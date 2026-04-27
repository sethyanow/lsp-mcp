---
name: Prefer reusable tooling over one-off scripts
description: When writing verification/smoke scripts, consider generalizing into a reusable harness before deleting or hardcoding paths.
type: feedback
originSessionId: 0606cf53-d523-4c2a-8a7f-fdc3e5e90b54
---
When writing a one-off verification script (smoke test, MCP tool probe, debug utility), default to making it a reusable harness instead of throwing it away after use.

**Why:** During `lspm-rot` (R6 list_languages), I wrote a stdio MCP smoke script with hardcoded absolute paths, used it once, then went to delete it. User pushed back: *"can we make it a reusable generic? seems like something that'll be handy in the future and in other envs/CI it'll break with those absolute paths."* Made it `scripts/smoke-mcp-tool.mjs` — accepts any MCP tool name + args, resolves dist/index.js relative to script location, passes env through. Now works in any clone / CI. User saw reusable value I missed.

**How to apply:**
- If a script is specific enough to be deleted after one use, that's a signal it could probably be generalized with 10 more lines: accept args, resolve paths portably (`fileURLToPath(import.meta.url)` → relative resolution), default to the common case.
- Place under `scripts/` (create the dir if needed) so it's findable by future work.
- Don't hardcode absolute paths in anything that might run on another machine / CI.
- The "is this throwaway or tooling?" decision belongs up-front when you're writing it, not after. If you'd be tempted to rewrite it next time, generalize it now.
