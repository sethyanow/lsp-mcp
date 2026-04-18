---
id: lspm-177
title: R2 — built-in manifest library for 12 default LSPs
status: open
type: task
priority: 1
parent: lspm-cnq
---


## Context

Third task in Phase 1 sub-epic `lspm-cnq`, parent epic `lspm-y5n`. Predecessor `lspm-z4z` closed R4 (multi-candidate routing + `via?`/`manifests?` params). Router now accepts `ManifestEntry[]`; first-registered candidate wins primary per langId; `_dedupeByName` drops duplicates with stderr log.

This task delivers **R2 only** — the built-in default manifest library at repo-root `manifests/`. Twelve JSON files, schema-conformant under `src/types.ts:PluginManifestSchema`. No router/config/index/mcp-server code changes.

**Explicitly out of scope (tracked as later Phase 1 tasks):** PATH probe (R3), `list_languages` MCP tool (R5), `set_primary` MCP tool (R6), dynamic tool-schema enums (R7), **layered manifest discovery (R8) — which is what actually loads `manifests/` at runtime**, `using-lsp-mcp` skill content (R9), `sourceKind` field on `ManifestEntry`.

**Key implication:** R2 delivers the *data*. Until R8 lands, the data is dormant — `resolveManifests()` in `src/config.ts` only reads `LSP_MCP_CONFIG` (a single file), not `manifests/`. This task is deliberately data-only so R8 can layer on top without needing to add content at the same time.

**Starting state (verified in `src/` on branch `dev`):**
- `manifests/` **does not exist** — this task creates it.
- `src/types.ts:13–32` defines `PluginManifestSchema` via Zod. Shape:
  ```ts
  {
    name: string (min 1),
    version: string,
    langIds: string[] (min 1),
    fileGlobs: string[] (min 1),
    workspaceMarkers: string[] (default []),
    server: {
      cmd: string[] (min 1),
      buildHook?: string,
      initOptions?: Record<string, unknown>,
    },
    capabilities: {
      workspaceSymbol?: { stringPrefilter?: boolean, timeoutMs?: number },
      implementations?: { stringPrefilter?: boolean, timeoutMs?: number },
      callHierarchy?: boolean,
      didOpenDelayMs?: number,
    },
    skills?: string[],
    scripts?: string[],
  }
  ```
- `src/tests/config.test.ts` tests `resolveManifests`. New schema-validation test lands in a separate file to keep concerns isolated.
- Tests at 106/106 green (post-`lspm-z4z`).

## Requirements

Satisfies parent epic R2 (via sub-epic `lspm-cnq` clause):

> `manifests/` (at repo root) contains a JSON manifest for each of: pyright, typescript-language-server, gopls, rust-analyzer, zls, clangd, lua-language-server, elixir-ls, svelte-language-server, bash-language-server, starpls, bazel-lsp.

Does NOT satisfy R3, R5, R6, R7, R8, R9 — downstream tasks.

## Design

### Directory layout

```
manifests/
├── pyright.json
├── typescript-language-server.json
├── gopls.json
├── rust-analyzer.json
├── zls.json
├── clangd.json
├── lua-language-server.json
├── elixir-ls.json
├── svelte-language-server.json
├── bash-language-server.json
├── starpls.json
└── bazel-lsp.json
```

Filename = manifest `name` field + `.json`. R8 discovery will walk this directory.

### Canonical langIds (decision table)

VSCode-standard langIds where they exist; one canonical ID for Bazel-family to enable multi-candidate routing across starpls + bazel-lsp.

| Manifest                       | langIds                                                              | Rationale                                                            |
|--------------------------------|----------------------------------------------------------------------|----------------------------------------------------------------------|
| pyright                        | `["python"]`                                                         | VSCode standard                                                      |
| typescript-language-server     | `["typescript", "typescriptreact", "javascript", "javascriptreact"]` | VSCode standard; single server handles all four                      |
| gopls                          | `["go"]`                                                             | VSCode standard                                                      |
| rust-analyzer                  | `["rust"]`                                                           | VSCode standard                                                      |
| zls                            | `["zig"]`                                                            | Zig community                                                        |
| clangd                         | `["c", "cpp", "objective-c", "objective-cpp"]`                       | VSCode standard; clangd handles all four                             |
| lua-language-server            | `["lua"]`                                                            | VSCode standard                                                      |
| elixir-ls                      | `["elixir"]`                                                         | VSCode standard                                                      |
| svelte-language-server         | `["svelte"]`                                                         | Svelte ecosystem standard                                            |
| bash-language-server           | `["shellscript"]`                                                    | VSCode standard (not "bash") — match VSCode clients                  |
| starpls                        | `["starlark"]`                                                       | Canonical across the Bazel ecosystem                                 |
| bazel-lsp                      | `["starlark"]`                                                       | **Same as starpls — intentional.** Multi-candidate under R4 routing. |

### fileGlobs (primary extensions)

| Manifest                       | fileGlobs                                                                                                   |
|--------------------------------|-------------------------------------------------------------------------------------------------------------|
| pyright                        | `["**/*.py", "**/*.pyi"]`                                                                                   |
| typescript-language-server     | `["**/*.ts", "**/*.tsx", "**/*.mts", "**/*.cts", "**/*.js", "**/*.jsx", "**/*.mjs", "**/*.cjs"]`            |
| gopls                          | `["**/*.go"]`                                                                                               |
| rust-analyzer                  | `["**/*.rs"]`                                                                                               |
| zls                            | `["**/*.zig", "**/*.zon"]`                                                                                  |
| clangd                         | `["**/*.c", "**/*.cc", "**/*.cpp", "**/*.cxx", "**/*.h", "**/*.hh", "**/*.hpp", "**/*.m", "**/*.mm"]`       |
| lua-language-server            | `["**/*.lua"]`                                                                                              |
| elixir-ls                      | `["**/*.ex", "**/*.exs"]`                                                                                   |
| svelte-language-server         | `["**/*.svelte"]`                                                                                           |
| bash-language-server           | `["**/*.sh", "**/*.bash"]`                                                                                  |
| starpls                        | `["**/*.star", "**/*.bzl", "**/BUILD", "**/BUILD.bazel", "**/WORKSPACE", "**/WORKSPACE.bazel", "**/MODULE.bazel"]` |
| bazel-lsp                      | Same as starpls — overlapping ownership is correct; R4 resolves via candidate list                           |

### workspaceMarkers (primary)

| Manifest                       | workspaceMarkers                                         |
|--------------------------------|----------------------------------------------------------|
| pyright                        | `["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json"]` |
| typescript-language-server     | `["tsconfig.json", "jsconfig.json", "package.json"]`     |
| gopls                          | `["go.mod", "go.work"]`                                  |
| rust-analyzer                  | `["Cargo.toml", "Cargo.lock", "rust-project.json"]`      |
| zls                            | `["build.zig", "build.zig.zon"]`                         |
| clangd                         | `["compile_commands.json", "compile_flags.txt", ".clangd"]` |
| lua-language-server            | `[".luarc.json", ".luarc.jsonc", "stylua.toml", ".stylua.toml"]` |
| elixir-ls                      | `["mix.exs"]`                                            |
| svelte-language-server         | `["svelte.config.js", "svelte.config.ts", "package.json"]` |
| bash-language-server           | `[]`                                                     |
| starpls                        | `["WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"]`       |
| bazel-lsp                      | `["WORKSPACE", "WORKSPACE.bazel", "MODULE.bazel"]`       |

### server.cmd (bare binary names)

Every manifest uses bare names. Users override with absolute paths in their own config when needed.

| Manifest                       | cmd                                 |
|--------------------------------|-------------------------------------|
| pyright                        | `["pyright-langserver", "--stdio"]` |
| typescript-language-server     | `["typescript-language-server", "--stdio"]` |
| gopls                          | `["gopls"]`                         |
| rust-analyzer                  | `["rust-analyzer"]`                 |
| zls                            | `["zls"]`                           |
| clangd                         | `["clangd"]`                        |
| lua-language-server            | `["lua-language-server"]`           |
| elixir-ls                      | `["elixir-ls"]`                     |
| svelte-language-server         | `["svelteserver", "--stdio"]`       |
| bash-language-server           | `["bash-language-server", "start"]` |
| starpls                        | `["starpls", "server"]`             |
| bazel-lsp                      | `["bazel-lsp"]`                     |

### capabilities (conservative: known-good only)

Omit fields unless documented. Under-claim rather than over-claim.

| Manifest                       | workspaceSymbol                              | callHierarchy | Notes                                       |
|--------------------------------|----------------------------------------------|---------------|---------------------------------------------|
| pyright                        | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Documented strong support                   |
| typescript-language-server     | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Full LSP impl                               |
| gopls                          | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Full LSP impl                               |
| rust-analyzer                  | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Full LSP impl                               |
| zls                            | `{stringPrefilter: true, timeoutMs: 5000}`   | (omit)        | workspace/symbol supported; callHierarchy unclear as of 2026 |
| clangd                         | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Full LSP impl                               |
| lua-language-server            | `{stringPrefilter: true, timeoutMs: 5000}`   | `true`        | Full LSP impl                               |
| elixir-ls                      | `{stringPrefilter: true, timeoutMs: 10000}`  | (omit)        | Slower cold start; callHierarchy uncertain  |
| svelte-language-server         | `{timeoutMs: 5000}`                          | (omit)        | stringPrefilter uncertain; conservative off |
| bash-language-server           | `{timeoutMs: 5000}`                          | (omit)        | Limited workspace/symbol; callHierarchy not supported |
| starpls                        | `{stringPrefilter: true, timeoutMs: 5000}`   | (omit)        | workspace/symbol supported; callHierarchy unclear |
| bazel-lsp                      | `{timeoutMs: 5000}`                          | (omit)        | Limited functionality; over-claim risk      |

**Step 1 research notes** (below in Implementation) may adjust these per LSP — the table is a starting point.

## Implementation

### Step 1 — Research table + bones log

Consult each LSP's README / docs / `--help` output. Confirm or adjust the capability table above. For each LSP, record in `bn log lspm-177`:
- Binary name + invocation flags
- Confirmed langIds (check GitHub client config or VSCode extension)
- `workspace/symbol` support (yes/no; stringPrefilter?)
- `callHierarchy/prepareCallHierarchy` support (yes/no)
- Anything surprising (e.g. buildHook required)

Primary sources per LSP:
- **pyright**: https://github.com/microsoft/pyright
- **typescript-language-server**: https://github.com/typescript-language-server/typescript-language-server
- **gopls**: https://github.com/golang/tools/tree/master/gopls
- **rust-analyzer**: https://rust-analyzer.github.io/
- **zls**: https://github.com/zigtools/zls
- **clangd**: https://clangd.llvm.org/
- **lua-language-server**: https://github.com/LuaLS/lua-language-server
- **elixir-ls**: https://github.com/elixir-lsp/elixir-ls
- **svelte-language-server**: https://github.com/sveltejs/language-tools
- **bash-language-server**: https://github.com/bash-lsp/bash-language-server
- **starpls**: https://github.com/withered-magic/starpls
- **bazel-lsp**: https://github.com/cameron-martin/bazel-lsp or https://github.com/facebookexperimental/starlark-rust bazel-lsp variant

No code written this step. The table in the Design section is a starting point — adjust if research contradicts.

### Step 2 — RED: schema validation test

File: `src/tests/manifests-library.test.ts`. Add `describe('manifests/ library')` with tests:

1. **"manifests/ directory exists at repo root"** — assert `fs.existsSync(path.resolve(__dirname, '../../manifests'))` is `true`.
2. **"every JSON file parses against PluginManifestSchema"** — iterate `fs.readdirSync('manifests/').filter(f => f.endsWith('.json'))`; for each, `PluginManifestSchema.parse(JSON.parse(fs.readFileSync(...)))`. Any Zod error fails the test with the filename + field path.
3. **"all 12 canonical manifests are present"** — hardcoded list:
    ```ts
    const CANONICAL = [
      'pyright', 'typescript-language-server', 'gopls', 'rust-analyzer',
      'zls', 'clangd', 'lua-language-server', 'elixir-ls',
      'svelte-language-server', 'bash-language-server', 'starpls', 'bazel-lsp',
    ];
    ```
    Assert each `${name}.json` exists in `manifests/`.
4. **"manifest filename matches its `name` field"** — for each JSON file, parse; assert `parsed.name + '.json' === path.basename(file)`.
5. **"starpls and bazel-lsp share canonical langId \"starlark\""** — load both, assert each includes `"starlark"` in `langIds` (enforces the Bazel coherence decision).

- Import path: `import { PluginManifestSchema } from '../types';`
- Command: `bun run test -- --testPathPattern=manifests-library` — expect failure (ENOENT on readdirSync).

### Step 3 — Verify RED

- Command: `bun run test -- --testPathPattern=manifests-library 2>&1 | head -30`.
- Expected: test 1 fails (`manifests/` doesn't exist). If tests 2+ throw uncaught ENOENT, guard them behind test 1 via early return or use a `beforeAll` that short-circuits. All that matters is: the battery reports clear RED, not a framework crash.

### Step 4 — GREEN Group A: pyright, typescript-language-server, gopls, rust-analyzer, clangd

Create 5 JSON files under `manifests/`. Content follows the Design tables (langIds, fileGlobs, workspaceMarkers, cmd, capabilities).

Example shape (`manifests/pyright.json`):
```json
{
  "name": "pyright",
  "version": "0.1.0",
  "langIds": ["python"],
  "fileGlobs": ["**/*.py", "**/*.pyi"],
  "workspaceMarkers": ["pyproject.toml", "setup.py", "setup.cfg", "pyrightconfig.json"],
  "server": { "cmd": ["pyright-langserver", "--stdio"] },
  "capabilities": {
    "workspaceSymbol": { "stringPrefilter": true, "timeoutMs": 5000 },
    "callHierarchy": true
  }
}
```

Repeat the shape for the other four. Run test — schema + filename tests pass; presence-of-12 still fails (5/12).

- Command: `bun run test -- --testPathPattern=manifests-library 2>&1 | tail -20`.

### Step 5 — GREEN Group B: zls, lua-language-server, elixir-ls, bash-language-server

Create 4 more. `capabilities` conservative per table (omit `callHierarchy` for zls, elixir-ls, bash-language-server unless Step 1 research confirms).

- Command: `bun run test -- --testPathPattern=manifests-library 2>&1 | tail -20` — 9/12.

### Step 6 — GREEN Group C: svelte-language-server, starpls, bazel-lsp

Create 3 more. **starpls and bazel-lsp both declare `langIds: ["starlark"]`** — the Bazel coherence decision is structural in this step.

- Command: `bun run test 2>&1 | tail -10` — all tests green across the suite (old 106 + new 5 = 111).

### Step 7 — Verify typecheck + build + smoke

- Command: `bun run typecheck` — clean.
- Command: `bun run build 2>&1 | tail -5` — bundled `dist/index.js` (manifests/ is NOT bundled by `bun build ./src/index.ts` — it's static data read at runtime by R8; confirm bundler ignores it).
- Command: `echo '' | node dist/index.js 2>&1 | head -5` — unchanged: zero-manifest notice (R8 not implemented, so built-in defaults still dormant).

### Step 8 — Commit (single scoped commit on `dev`, not pushed)

```bash
git add manifests/ src/tests/manifests-library.test.ts .bones/
git commit -m "$(cat <<'EOF'
lspm-177: R2 built-in manifest library (12 default LSPs)

- 12 JSON manifests under manifests/ (pyright, typescript-language-server,
  gopls, rust-analyzer, zls, clangd, lua-language-server, elixir-ls,
  svelte-language-server, bash-language-server, starpls, bazel-lsp)
- Bazel coherence: starpls + bazel-lsp share langIds: ["starlark"]
  so they are multi-candidates under R4 routing
- src/tests/manifests-library.test.ts: 5 tests (dir presence,
  schema-conformance, 12-canonical-present, filename-matches-name,
  starlark coherence)
- Conservative capabilities: omit fields where LSP support unclear
- Bare binary cmd[0]; absolute-path overrides are user responsibility

Does not implement R3 (PATH probe), R8 (layered discovery that
actually loads manifests/), R5/R6 (list_languages / set_primary),
R7 (dynamic enums), R9 (skill content). Manifests are dormant data
until R8 lands.
EOF
)"
```

Do NOT push. User reviews before push.

## Success Criteria

- [ ] `manifests/` directory exists at repo root.
- [ ] Exactly 12 JSON files present: `pyright.json`, `typescript-language-server.json`, `gopls.json`, `rust-analyzer.json`, `zls.json`, `clangd.json`, `lua-language-server.json`, `elixir-ls.json`, `svelte-language-server.json`, `bash-language-server.json`, `starpls.json`, `bazel-lsp.json`.
- [ ] Each file parses cleanly against `PluginManifestSchema` (Zod) — no validation errors.
- [ ] For each file, `parsed.name + ".json"` equals the filename (consistency invariant R8 can rely on).
- [ ] `starpls.json` and `bazel-lsp.json` both include `"starlark"` in `langIds` (Bazel coherence).
- [ ] Every `server.cmd[0]` is a bare binary name, not an absolute path.
- [ ] `capabilities.workspaceSymbol` and `capabilities.callHierarchy` reflect each LSP's documented/researched behavior; uncertain cases omit the field rather than guess. Research notes logged via `bn log lspm-177`.
- [ ] `src/tests/manifests-library.test.ts` exists with 5 tests covering: directory presence, schema conformance, 12 canonical manifests present, filename-matches-name, starlark coherence. All green.
- [ ] No changes to `src/router.ts`, `src/config.ts`, `src/mcp-server.ts`, `src/index.ts`, `src/types.ts`, or any other existing file outside the new test file.
- [ ] `bun run test` green (all 106 pre-existing + 5 new = 111 total).
- [ ] `bun run typecheck` clean; `bun run build` produces bundled `dist/index.js`.
- [ ] `echo '' | node dist/index.js` still logs zero-manifest notice (R8 not implemented; manifests dormant).
- [ ] Single commit on `dev`, not pushed. Commit message references `lspm-177` and enumerates out-of-scope R3/R5/R6/R7/R8/R9.

## Anti-Patterns

- **NO router / config.ts / index.ts / mcp-server.ts / types.ts edits.** This task is static data + one new test file. Touching any src/ file other than the new test is scope creep into R8 territory.
- **NO layered-discovery loader changes.** R8 is a separate task. `manifests/` sits dormant on disk until R8 picks it up.
- **NO PATH probe logic.** R3's `status: "ok"`/`"binary_not_found"` lives elsewhere; `capabilities` reflects LSP behavior, not binary availability.
- **NO capability over-claiming.** When in doubt, OMIT the field. Over-claimed `callHierarchy: true` on an LSP that doesn't support it produces `Method not found` errors at runtime; conservative omit degrades gracefully.
- **NO absolute paths in `cmd[0]`.** Defaults must work against PATH. Absolute paths are a user-override concern.
- **NO 13th manifest, no experimental additions.** Exactly the 12 listed. Phase 2 (`lspm-erd`) may extend.
- **NO runtime behavior tests spawning actual LSPs.** Manifest files are data; testing LSP behavior requires spawning each binary and is out of scope (and infeasible in CI without every LSP installed).
- **NO shortcut "load all manifests and construct Router" integration test here.** That's R8's acceptance test.
- **NO changing `PluginManifestSchema` to fit a manifest.** If a real LSP needs a field the schema doesn't have, that's an R8 issue (or a separate schema-extension task) — not adjusted in R2.

## Key Considerations

- **R2 is dormant until R8.** The runtime doesn't read `manifests/` yet. This is deliberate — R2 lands the data so R8's loader has something to load. A smoke test that expects manifests to appear in `list_languages` is WRONG for this task.
- **Bazel coherence is structural.** starpls and bazel-lsp sharing `langIds: ["starlark"]` means under R4 routing, both will be candidates for the same lang, with the first-registered (alphabetical by filename: bazel-lsp < starpls) as primary. R8 discovery order will determine which is primary in practice.
- **Case-sensitive langIds.** `"typescript"` ≠ `"TypeScript"`. VSCode uses lowercase; match exactly. LSP clients route by exact string match.
- **stringPrefilter semantics.** Declaring `stringPrefilter: true` tells the Router the LSP filters server-side on the query string — the MCP layer can trust the server's filtering and skip client-side substring checks. Declaring `false` (or omit) means the Router should apply its own post-filter on results. Conservative omit is safe; false-positive true is a correctness bug.
- **didOpenDelayMs not used here.** Default (~100ms in router) is fine. Per-LSP tuning is a later optimization if agents report flakiness.
- **workspaceMarkers are forward-looking.** R4 router doesn't consume them. A future workspace-root detection layer (not part of Phase 1) will pick one manifest per repo section based on which marker file is nearest. Populate accurately; R8+ will benefit.
- **initOptions not used.** Several LSPs (rust-analyzer, gopls) accept rich initialization options. Defaults work for Phase 1 smoke tests; users can add `server.initOptions` via their own config. Don't ship pre-baked options that reflect one team's preferences.
- **Manifest filename = name invariant.** R8 discovery can use either the filename or the `name` field to key the loader. Enforcing equality prevents confusion (load by filename, dedup by name — the two identifiers must agree). The test enforces this.
- **Version field: "0.1.0" for all.** Version is tracked against the manifest schema, not the upstream LSP version. `version: "0.1.0"` means "lsp-mcp manifest shape v0.1.0" and will bump together with the schema. Individual LSP versions are user concerns handled via their own binaries.
- **No skill/scripts fields populated.** Phase 1's `using-lsp-mcp` skill ships as a single workspace-level skill (R9), not per-manifest. Per-manifest skills are Phase 2 (`lspm-erd`) fork-wrapper territory.
- **`bun build` and static assets.** `bun build ./src/index.ts --outdir ./dist` does NOT copy non-imported files into `dist/`. R8's loader will read `manifests/` relative to `dist/index.js`'s sibling path (per `lspm-cnq` "Built-in defaults dir path" key consideration). The manifests/ stays at repo root, unbundled. Confirm after this task: `ls dist/` shows only `index.js` + sourcemap (no manifests copied).

## Dependencies

- **Blocks:** `lspm-cnq` (Phase 1 sub-epic).
- **Blocked by:** none. Unlocked — `lspm-z4z` closed.
- **Unlocks:** R3 (PATH probe — can now probe against real manifest names), R8 (layered discovery — loader has default-dir content to load). Both can be scoped in parallel once R2 lands.

## Log

- [2026-04-18] Task scoped via writing-plans after `lspm-z4z` closed. User picked R2 over R3/R8/R5+R6 via checkpoint question. Narrow scope: 12 JSON files + 1 test file. 0 src/ file changes. Research burden: verify each LSP's capabilities against the Design table via docs/README. Bazel coherence (shared `langIds: ["starlark"]`) is the main structural decision.
- [2026-04-18T07:54:47Z] [Seth] Scoped via writing-plans post-lspm-z4z close (2026-04-18). User picked R2 over R3/R8/R5+R6. Narrow scope: 12 JSON files at repo-root manifests/ + 1 new test file (src/tests/manifests-library.test.ts). Zero src/ file changes beyond the new test. Bazel coherence decision baked in: starpls + bazel-lsp both declare langIds: ["starlark"] so they become multi-candidates under R4 routing. Data is dormant until R8 lands a loader. Capabilities conservative (omit when uncertain; over-claim causes runtime errors).
