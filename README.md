# lsp-mcp

A thin meta-LSP MCP server that gives any MCP-speaking agent (Claude Code, Cursor, custom agents) cross-language code intelligence over a user-configured set of LSP servers.

## Problem

Polyglot codebases need cross-language intel. Agents fall back to `grep` when precise semantic lookups are unavailable — grep can't distinguish definitions from mentions, can't follow types across files, can't jump across language boundaries. This server fills that gap by routing MCP tool calls to whatever LSP servers the user has configured.

## Architecture

```
MCP Client (Claude Code / Cursor / …)
         │  MCP protocol
         ▼
    lsp-mcp  (this project — thin router, no language semantics)
    ├─ LspServer[pyright]  ──JSON-RPC──▶  pyright-langserver
    ├─ LspServer[zls]      ──JSON-RPC──▶  zls
    └─ LspServer[…]        ──JSON-RPC──▶  …
```

Each LSP server is described by a **plugin manifest** (see below). `lsp-mcp` spawns and holds persistent LSP server processes (warm-cache performance after first request), routes file-targeted requests to the owning server, and fans out workspace-scoped requests (`workspace/symbol`) across all servers, merging and deduping results.

## Tool Surface

| Tool | Description |
|---|---|
| `symbol_search(name, kind?, langs?)` | **Keystone verb.** Fans `workspace/symbol` across all configured servers; merges, dedupes by `(uri, range)`, normalises `SymbolKind`. |
| `defs(file, pos)` | Go-to-definition, routed to the server owning `file`. |
| `refs(file, pos)` | Find references. |
| `impls(file, pos)` | Implementations / concrete subclasses. |
| `hover(file, pos)` | Type info / signature. |
| `outline(file)` | Document symbols. |
| `diagnostics(file)` | Errors / warnings. |
| `lsp(lang, method, params)` | Raw passthrough — escape hatch for anything not covered above. |
| `call_hierarchy_prepare(file, pos)` | Gated on `capabilities.callHierarchy`. Returns `CallHierarchyItem`s at the position. |
| `incoming_calls(item)` | Callers of a call-hierarchy item. |
| `outgoing_calls(item)` | Callees of a call-hierarchy item. |

## Configuration

Create a config file (default: `lsp-mcp.config.json` in the working directory) containing an array of plugin manifests:

```json
[
  {
    "name": "pyright",
    "version": "0.1.0",
    "langIds": ["python"],
    "fileGlobs": ["**/*.py", "**/*.pyi"],
    "workspaceMarkers": ["pyrightconfig.json", "pyproject.toml", "setup.py"],
    "server": {
      "cmd": ["node", "/path/to/pyright-langserver.js", "--stdio"],
      "initOptions": {}
    },
    "capabilities": {
      "workspaceSymbol": { "stringPrefilter": true, "timeoutMs": 10000 },
      "implementations": { "stringPrefilter": true }
    }
  }
]
```

### Manifest fields

| Field | Description |
|---|---|
| `name` | Unique plugin identifier. |
| `langIds` | LSP language IDs handled by this server (used for routing). |
| `fileGlobs` | Glob patterns that identify files owned by this server. |
| `workspaceMarkers` | File/directory names that mark a project root. lsp-mcp walks up from `LSP_MCP_ROOT` to find the nearest directory containing any marker and uses that as the server's `rootUri`. Empty array → use `LSP_MCP_ROOT` verbatim. |
| `server.cmd` | Command array to spawn the LSP server. `${pluginDir}` expands to `$LSP_MCP_PLUGINS_DIR/<manifest.name>`. |
| `server.buildHook` | Optional shell command run **once per process** before the first spawn. Executed with `cwd=pluginDir` (if it exists) and `LSP_MCP_PLUGIN_DIR` in the env. Non-zero exit aborts startup. |
| `server.initOptions` | Passed as LSP `initializationOptions`. |
| `capabilities.workspaceSymbol.stringPrefilter` | `true` if the server handles string-prefilter-before-bind internally. `false` means the outer layer should pre-filter candidate files before dispatch. |
| `capabilities.workspaceSymbol.timeoutMs` | Per-server timeout for workspace/symbol queries (default 10 000 ms). |
| `capabilities.implementations.stringPrefilter` | Same contract as above, for `textDocument/implementation`. If `false`, lsp-mcp emits a startup warning — outer-layer prefilter is not yet implemented. |
| `capabilities.callHierarchy` | `true` to register the `call_hierarchy_prepare` / `incoming_calls` / `outgoing_calls` tools. Omit when no server supports LSP call hierarchy. |
| `capabilities.didOpenDelayMs` | Milliseconds to wait after `textDocument/didOpen` before dispatching the first request on a file (default 100). Raise for slow-warming servers. |

## Usage

```bash
# Install
npm install

# Build
npm run build

# Run (config auto-discovered from ./lsp-mcp.config.json)
node dist/index.js

# Run with explicit config and workspace root
LSP_MCP_CONFIG=/path/to/config.json LSP_MCP_ROOT=/path/to/workspace node dist/index.js
```

### Environment variables

| Variable | Default | Description |
|---|---|---|
| `LSP_MCP_CONFIG` | `./lsp-mcp.config.json` | Path to the plugin configuration file. |
| `LSP_MCP_ROOT` | `process.cwd()` | Workspace root — the start point for `workspaceMarkers` walk-up. |
| `LSP_MCP_PLUGINS_DIR` | `<dirname(LSP_MCP_CONFIG)>/plugins` | Base directory for `${pluginDir}` expansion and `buildHook` cwd. Each plugin's assets live at `$LSP_MCP_PLUGINS_DIR/<manifest.name>/`. |

### MCP client configuration (Claude Code example)

```json
{
  "mcpServers": {
    "lsp": {
      "command": "node",
      "args": ["/path/to/lsp-mcp/dist/index.js"],
      "env": {
        "LSP_MCP_CONFIG": "/path/to/lsp-mcp.config.json",
        "LSP_MCP_ROOT": "/path/to/workspace"
      }
    }
  }
}
```

## Development

```bash
npm install      # install deps
npm run build    # compile TypeScript → dist/
npm test         # run Jest tests
npm run clean    # remove dist/
```

## Cold-cache discipline

From the pyright-mcp design history: any workspace-scoped operation must assume servers may not have binding warmup. The `capabilities.workspaceSymbol.stringPrefilter` flag in each manifest declares whether the server handles prefiltering internally. When `false`, a future outer-layer prefilter (string-BFS across raw file text) can be applied before dispatching — keeping `workspace/symbol` within the MCP timeout even on cold cache.

## Related

- [`sethyanow/pyright`](https://github.com/sethyanow/pyright) (dev branch) — pyright fork with `pyright-mcp` package; reference implementation for persistent JSON-RPC bridge pattern.
- [`sethyanow/zls`](https://github.com/sethyanow/zls) (dev branch) — zls fork.
- [`sethyanow/markymark`](https://github.com/sethyanow/markymark) — MCP-native Markdown LSP; candidate for first plugin.
- [`sethyanow/chunkhound`](https://github.com/sethyanow/chunkhound) — semantic + regex chunk search; companion tool to lsp-mcp.