---
name: using-lsp-mcp
description: This skill should be used when the user asks to find, navigate, or refactor symbols across multiple programming languages in a single repo — queries like "where is X defined across languages", "find callers of Y in the frontend and backend", polyglot refactors, FFI bindings (pyo3, gRPC, C extensions). Teaches `symbol_search`-first discipline: no position-counting.
---

## 1. When this skill activates

Reach for this skill in polyglot sessions — repos that mix languages through FFI, RPC, or embedded runtimes. Example queries that should trigger it:

- "Where is `SessionCookie` defined? I see it referenced in both `frontend/src/auth.ts` and `cmd/api/auth.go`."
- "Find all callers of `parse_config` across the Rust core and the Python bindings."
- "Refactor `ServiceHandler` — it's a pyo3 class called from Python tests."
- "This `.proto` service has implementations in Go and a client stub in TypeScript. What does `StreamEvents` return in each?"

Skip this skill for single-language tasks — if every file in scope is `.py`, stock Read + grep is fine. Reach for the lsp-mcp tools the moment the symbol of interest crosses a language boundary. The signal: reaching for grep across two directories with different file extensions to reconstruct a type or call chain the LSPs already understand.

## 2. The discovery pattern

The central teaching: `symbol_search` is the entry verb. Every downstream LSP call — `defs`, `refs`, `hover`, `impls` — needs an anchor `(uri, range)`. `symbol_search` returns those anchors without requiring any position counting.

The flow:

1. **Inspect the schema enum** to know which language IDs are routable on this box. The MCP tool schema for `symbol_search` exposes the active language IDs in `properties.langs.items.enum` — the router populates this at tool-discovery time from manifests whose binaries were found on PATH. No `list_languages` round-trip needed for routing prep.

2. **Call `symbol_search`** with a name (omit `langs` to fan across all active LSPs):

   ```json
   symbol_search({"name": "MyType"})
   ```

   The return is an array of hits, each with `uri`, `range`, `kind`, `containerName`, and `manifest`.

3. **Pick one hit's `range`** and pass it verbatim as the `pos` argument to the positional verbs — `defs` (definition site), `impls` (interface implementations), `refs` (reference sites), `hover` (type + docs), or `call_hierarchy_prepare`. The `pos` shape is `{"line": int, "character": int}` and is 0-based. Do not compute these values from `Read` output — use what the LSP returned.

4. **Chain as needed.** Each downstream call returns more `(uri, range)` anchors to feed into the next call. A cross-language caller trace is a sequence of `symbol_search → refs → defs` hops — no `Read` in the loop.

The reason this matters: `Read` returns visible characters with line numbers, but LSP positions are over the file's byte stream as the LSP parsed it. The visible character at column 4 is not necessarily offset 4 — multi-byte UTF-8, tab expansion, and CRLF line endings all diverge. The LSP's own output is the only reliable anchor.

## 3. Cross-language examples

### Python ↔ Rust via pyo3

A Rust crate exposes a `DocumentIndex` struct as a Python class through pyo3 bindings. A Python test calls `DocumentIndex(...)` and fails; the question is where the constructor logic lives.

```json
symbol_search({"name": "DocumentIndex"})
```

Returns hits in both languages — a `class DocumentIndex` in `python/my_pkg/__init__.pyi` (pyright, a stub file) and a `struct DocumentIndex` in `src/index.rs` (rust-analyzer). Say the Python hit's `range.start` is `{line: 12, character: 6}`. Feed that through to `defs` verbatim:

```json
defs({"file": "file:///.../python/my_pkg/__init__.pyi",
      "pos": {"line": 12, "character": 6}})   // ← from pyright-hit.range.start
```

pyright resolves to the pyi stub itself — no further. Take the Rust hit's `range.start` (say `{line: 43, character: 11}`) and feed it instead:

```json
defs({"file": "file:///.../src/index.rs",
      "pos": {"line": 43, "character": 11}})  // ← from rust-analyzer-hit.range.start
```

rust-analyzer returns the real implementation location in `src/index.rs`. The cross-language handoff: `symbol_search` finds the type in both worlds, and each LSP's `defs` gives the depth-appropriate answer. Neither server saw the other — the router merged the results.

### TypeScript ↔ Go via gRPC

A TypeScript frontend calls `StreamEvents(...)` against a Go gRPC service. The `.proto` file is the contract; stubs are generated on both sides. The task is to understand what the server actually returns.

```json
symbol_search({"name": "StreamEvents"})
```

Returns three hits: a method declaration in `api/events_service.pb.go` (gopls — generated Go binding), the method on the implementing struct in `internal/events/server.go` (gopls — real logic), and a method on the client stub in `frontend/gen/events_pb.ts` (typescript-language-server — generated TS binding).

Pin downstream queries to Go to see the implementation, using `via` to scope a single call to one manifest. Take the Go hit's `range.start` (the LSP returned it; no counting):

```json
refs({"file": "file:///.../internal/events/server.go",
      "pos": {"line": 87, "character": 18},   // ← from gopls-hit.range.start
      "via": "gopls"})
```

Without `via`, the router dispatches to the primary manifest for the file's langId. Use `via` when multiple manifests might claim the hit, or when probing one server's behavior in isolation.

### C embedded in Python via C-extension

A Python package ships a C extension: `src/_parser.c` defines the extension module and exposes `parse_chunk` to Python as `_parser.parse_chunk`. A Python caller invokes `_parser.parse_chunk(...)`; the question is what allocation strategy the C side uses.

```json
symbol_search({"name": "parse_chunk"})
```

Fans across clangd (for the `.c` file) and pyright (which sees the import `from ._parser import parse_chunk`). The C side gives the real function definition; the Python side gives the import anchor.

Feed the C hit's `range.start` to `hover` to get clangd's type signature and docstring without re-reading the file. The `via: "clangd"` is explicit for readability — clangd is already the primary for `.c` files, so it would route there by default; naming `via` makes the intent obvious and is useful when multiple C-family manifests are active (e.g., a `clangd-fork` alongside the stock manifest):

```json
hover({"file": "file:///.../src/_parser.c",
       "pos": {"line": 54, "character": 8},   // ← from clangd-hit.range.start
       "via": "clangd"})
```

For a cross-module caller trace — who else in the Python codebase calls `_parser.parse_chunk` — use `refs` on the pyright-side hit. pyright tracks import usages across `.py` files.

## 4. Tool surface — quick reference

The lsp-mcp server publishes up to 13 MCP tools — 10 always-on, plus 3 call-hierarchy tools that appear only if at least one active manifest declares `capabilities.callHierarchy`:

- `symbol_search` — entry verb. `{name, kind?, langs?, manifests?}`. Returns hits with `(uri, range)` anchors.
- `list_languages` — no args. Returns rows covering lang, manifest, primary flag, status, and manifest-declared capabilities — including `binary_not_found` entries.
- `set_primary` — `{lang, manifest}` both required. Swaps the primary manifest for a langId, in-memory.
- `defs` / `impls` / `refs` — `{file, pos, via?}`. Definition, implementations, and reference sites at a position.
- `hover` — `{file, pos, via?}`. Type info and documentation at a position (`pos` is required).
- `outline` / `diagnostics` — `{file, via?}`. Whole-file outputs — no position. `outline` returns the document symbol tree; `diagnostics` returns errors and warnings.
- `lsp` — escape hatch. `{lang, method, params, via?}`. Passes a raw JSON-RPC method to a specific manifest.
- `call_hierarchy_prepare` — `{file, pos, via?}`. Gated. Returns `CallHierarchyItem[]`.
- `incoming_calls` / `outgoing_calls` — `{item, via?}`. Gated. `item` is a `CallHierarchyItem` from `call_hierarchy_prepare`, not a `(file, pos)` tuple.

The `langs`, `manifests`, `manifest`, and `via` parameter enums (array-typed on `symbol_search`, single-value on `set_primary` and `lsp`) are built at startup from active manifests and embedded directly in the tool inputSchema. Inspect them:

```bash
node scripts/smoke-mcp-tool.mjs --inspect-schema symbol_search
```

Example enum shape from a dev box (exact values depend on the installed LSP set): `properties.langs.items.enum` contains the active langIds; `properties.manifests.items.enum` contains the active manifest names. Manifests with `status: "binary_not_found"` are excluded from both enums but still visible in `list_languages`.

## 5. Pinning, fan-out scoping, and primary swap

Three dials control routing:

**`via: "<manifest>"`** — per-call routing. Every file- or item-scoped tool accepts `via`: `defs`, `impls`, `refs`, `hover`, `outline`, `diagnostics`, `lsp`, `call_hierarchy_prepare`, `incoming_calls`, `outgoing_calls`. Use it when the file is claimed by multiple manifests (e.g., `pyright` vs a hypothetical `pyright-fork`), or when probing a specific LSP's behavior without changing session state.

**`manifests: ["a", "b"]`** — fan-out scoping on `symbol_search`. Default fans across every primary. Passing `manifests` scopes the fan to the named set; useful when the symbol's language is known and noise from other LSPs should be suppressed.

**`set_primary({"lang": "...", "manifest": "..."})`** — session-level default swap. Changes which manifest the router picks when `via` is omitted. Use this to A/B a fork against a stock LSP for an extended session, or to pin a preferred manifest when multiple candidates are registered. The swap is in-memory — restart drops it. Idempotent: `set_primary` with the current primary is a no-op.

Rule of thumb: `via` for one call, `manifests` for one fan-out, `set_primary` for the rest of the session.

## 6. Anti-patterns

- **Never count character positions from `Read` output.** `Read` returns visible characters with line numbers; LSP positions are in the LSP's parsed model. They diverge on multi-byte characters, tab expansion, and CRLF endings. Always use `range.start` returned by `symbol_search` (or any prior LSP call) as the `pos` argument.

- **Do not call `list_languages` before every `symbol_search`.** The schema enum already exposes the active langIds and manifests at tool-discovery. `list_languages` is for status inspection (which manifests are `binary_not_found`? what capabilities does each declare?) — not a routing prep step.

- **Do not iterate files with `Read` looking for a symbol.** `symbol_search` fans across the entire workspace in one call. Reading one file at a time is how stock Claude Code works when no LSP is available — replace that loop, don't reproduce it.

- **Do not pass `langs` when the symbol's language is unknown.** Omit the filter; let fan-out find it. Narrow with `langs` only when the language is confirmed (e.g., after a first `symbol_search` returned hits across multiple langs and re-running scoped makes sense).

- **Do not call `set_primary` mid-session for unrelated queries.** It mutates routing defaults until the next swap or restart. `via` is the per-call escape hatch.

- **Do not invent enum values in examples.** Active langIds and manifests are box-dependent. Quote the shape (`properties.langs.items.enum: [...]`) generically; if specific values appear inline, mark them "example from a dev box" so they don't rot into false claims.

## 7. Failure modes to recognize

**`binary_not_found` manifests return informative empties, not errors.** If `symbol_search({"langs": ["bash"]})` is called and bash-language-server's binary is not on PATH, the response is an empty hit array with a status message — not a tool error. Check `list_languages` for the `status` field if results come back unexpectedly empty.

**`symbol_search` can return 0 hits on local-scope symbols.** Function-local variables, private struct fields, or symbols inside unexported modules may not appear in workspace symbol queries — LSPs vary. If the symbol is genuinely present but missing, fall back to `outline` on the containing file, or `lsp` with a raw `workspace/symbol` method and custom query parameters.

**Schema enum reflects active LSPs, not all registered manifests.** A manifest with `status: "binary_not_found"` is registered in the router but excluded from tool-schema enums — so `symbol_search({"langs": ["bash"]})` is a schema-level reject if bash-language-server is missing. Install the binary or omit the lang.
