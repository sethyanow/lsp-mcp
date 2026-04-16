#!/usr/bin/env node
/* eslint-disable */
/**
 * Minimal stub LSP server for tests.
 *
 * Speaks JSON-RPC over stdio via vscode-jsonrpc.
 *
 * Flags:
 *   --symbol-empty-for=N   Return [] for the first N workspace/symbol calls
 *                          before returning a real result.
 *   --symbol-shape=ws      Return WorkspaceSymbol-shaped entries (no
 *                          location.range) instead of SymbolInformation.
 *   --init-exit=N          exit(N) on initialize before responding (used to
 *                          test startup-failure retry).
 */
const rpc = require('vscode-jsonrpc/node');

const opts = parseArgs(process.argv.slice(2));

if (opts.initExit !== undefined) {
    process.exit(Number(opts.initExit));
}

const conn = rpc.createMessageConnection(
    new rpc.StreamMessageReader(process.stdin),
    new rpc.StreamMessageWriter(process.stdout),
);

conn.onRequest('initialize', () => ({ capabilities: {} }));
conn.onNotification('initialized', () => {});

let symbolCalls = 0;
conn.onRequest('workspace/symbol', ({ query }) => {
    symbolCalls++;
    const emptyFor = Number(opts.symbolEmptyFor ?? 0);
    if (symbolCalls <= emptyFor) return [];
    const base = {
        name: query || 'StubSymbol',
        kind: 5,
        location: { uri: 'file:///stub.py' },
    };
    if (opts.symbolShape !== 'ws') {
        base.location.range = {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 5 },
        };
    }
    return [base];
});

let openedCount = 0;
conn.onNotification('textDocument/didOpen', () => {
    openedCount++;
});

conn.onRequest('textDocument/definition', () => [
    {
        uri: 'file:///def.py',
        range: {
            start: { line: 1, character: 0 },
            end: { line: 1, character: 3 },
        },
    },
]);

conn.onRequest('textDocument/hover', () => ({
    contents: { kind: 'markdown', value: 'stub' },
}));

conn.onRequest('_debug/openedCount', () => openedCount);

conn.onRequest('shutdown', () => null);
conn.onNotification('exit', () => process.exit(0));

conn.listen();

function parseArgs(argv) {
    const out = {};
    for (const a of argv) {
        const m = a.match(/^--([^=]+)(?:=(.*))?$/);
        if (!m) continue;
        const key = m[1].replace(/-(.)/g, (_, c) => c.toUpperCase());
        out[key] = m[2] ?? true;
    }
    return out;
}
