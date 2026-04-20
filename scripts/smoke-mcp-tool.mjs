#!/usr/bin/env node
// Generic stdio smoke harness — spawns the built lsp-mcp server, calls one MCP
// tool, prints a summary. Portable: resolves dist/index.js relative to this
// script so it works in any clone / CI / dev env.
//
// Usage:
//   node scripts/smoke-mcp-tool.mjs                       # default: list_languages
//   node scripts/smoke-mcp-tool.mjs list_languages        # explicit
//   node scripts/smoke-mcp-tool.mjs symbol_search '{"name":"foo"}'
//   node scripts/smoke-mcp-tool.mjs --inspect-schema set_primary  # print tool's inputSchema
//
// Env overrides:
//   LSP_MCP_CONFIG        — passed through; defaults to a nonexistent path so the
//                           server falls back to built-in manifests only
//   LSP_MCP_MANIFESTS_DIR — passed through if set
//
// Exit codes: 0 on success, 1 on MCP error, transport failure, or bad usage.

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const distEntry = path.join(repoRoot, 'dist', 'index.js');

let mode = 'invoke';
let toolName = 'list_languages';
let argsJson = '{}';

if (process.argv[2] === '--inspect-schema') {
    mode = 'inspect-schema';
    toolName = process.argv[3];
    if (!toolName) {
        console.error('usage: --inspect-schema <tool>');
        process.exit(1);
    }
} else {
    if (process.argv[2]) toolName = process.argv[2];
    if (process.argv[3]) argsJson = process.argv[3];
}

let args;
try {
    args = JSON.parse(argsJson);
} catch (err) {
    console.error(`invalid JSON for args: ${argsJson}`);
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
}

const env = { ...process.env };
if (!('LSP_MCP_CONFIG' in env)) env.LSP_MCP_CONFIG = '/nonexistent';

const transport = new StdioClientTransport({
    command: 'node',
    args: [distEntry],
    env,
});
const client = new Client({ name: 'smoke', version: '0.0.0' });

try {
    await client.connect(transport);

    const { tools } = await client.listTools();
    console.log(`tools (${tools.length}): ${tools.map((t) => t.name).join(', ')}`);

    const tool = tools.find((t) => t.name === toolName);
    if (!tool) {
        console.error(`tool '${toolName}' not registered on server`);
        await client.close();
        process.exit(1);
    }

    if (mode === 'inspect-schema') {
        console.log(`\n${toolName}.inputSchema:`);
        console.log(JSON.stringify(tool.inputSchema, null, 2));
        await client.close();
        process.exit(0);
    }

    const result = await client.callTool({ name: toolName, arguments: args });
    if (result.isError) {
        console.error(`tool '${toolName}' returned an error:`);
        console.error(result.content);
        await client.close();
        process.exit(1);
    }

    const payload = JSON.parse(result.content[0].text);

    // Tool-specific summary for list_languages; generic fallback otherwise.
    if (toolName === 'list_languages' && Array.isArray(payload)) {
        const ok = payload.filter((r) => r.status === 'ok');
        const missing = payload.filter((r) => r.status === 'binary_not_found');
        const uniq = (arr) => [...new Set(arr)].sort();
        console.log(`rows: ${payload.length}, ok: ${ok.length}, missing: ${missing.length}`);
        console.log(`ok manifests: ${uniq(ok.map((r) => r.manifest)).join(', ')}`);
        console.log(`missing manifests: ${uniq(missing.map((r) => r.manifest)).join(', ')}`);
        console.log(`primary langs: ${uniq(payload.filter((r) => r.primary).map((r) => r.lang)).join(', ')}`);
    } else {
        console.log(JSON.stringify(payload, null, 2));
    }

    await client.close();
} catch (err) {
    console.error(`smoke failed: ${err instanceof Error ? err.message : String(err)}`);
    try {
        await client.close();
    } catch {
        // ignore
    }
    process.exit(1);
}
