import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp-server';
import { Router, type ManifestEntry } from '../router';
import type { LspServer } from '../lsp-server';
import type { PluginManifest } from '../types';
import { SymbolKind } from '../types';
import { minimatch } from 'minimatch';

// Test-fixture convention (lspm-h1n): see comment in router.test.ts.
function entriesFrom(servers: LspServer[]): ManifestEntry[] {
    return servers.map((s) => ({
        manifest: s.manifest,
        server: s,
        sourceKind: 'config-file' as const,
        status: 'ok' as const,
    }));
}

// ---- Mock helpers ----------------------------------------------------------

interface MockOpts {
    callHierarchy?: boolean;
    name?: string;
}

let mockCounter = 0;
function nextMockName(): string {
    return `mock-${mockCounter++}`;
}

function makeMockServer(
    langIds: string[],
    fileGlobs: string[],
    opts: MockOpts = {}
): jest.Mocked<LspServer> {
    const manifest: PluginManifest = {
        name: opts.name ?? nextMockName(),
        version: '0.1.0',
        langIds,
        fileGlobs,
        workspaceMarkers: [],
        server: { cmd: ['echo'] },
        capabilities: {
            workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 },
            ...(opts.callHierarchy ? { callHierarchy: true } : {}),
        },
    };
    return {
        manifest,
        defaultLangId: langIds[0] ?? 'plaintext',
        resolvedRootUri: null,
        ensureRunning: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
        forceKill: jest.fn(),
        request: jest.fn(),
        openDocument: jest.fn().mockResolvedValue(false),
        waitForAnalysis: jest.fn().mockResolvedValue(true),
        workspaceSymbol: jest.fn().mockResolvedValue([]),
        ownsFile: jest.fn((filePath: string) =>
            fileGlobs.some((g) => minimatch(filePath, g, { nocase: true, dot: true }))
        ),
        ownsLang: jest.fn((l: string) => langIds.includes(l)),
    } as unknown as jest.Mocked<LspServer>;
}

async function buildClientServer(router: Router): Promise<{
    client: Client;
    teardown: () => Promise<void>;
}> {
    const mcpServer = createMcpServer(router);
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(serverTransport);

    const client = new Client({ name: 'test-client', version: '1.0.0' });
    await client.connect(clientTransport);

    return {
        client,
        teardown: async () => {
            await client.close();
        },
    };
}

function textOf(result: { content: unknown }): string {
    const content = result.content as Array<{ type: string; text: string }>;
    return content[0].text;
}

// ---- Tests -----------------------------------------------------------------

describe('MCP server tool registration', () => {
    it('registers the core tools', async () => {
        const router = new Router(entriesFrom([]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const { tools } = await client.listTools();
            const names = tools.map((t) => t.name);
            for (const t of [
                'symbol_search', 'defs', 'refs', 'impls',
                'hover', 'outline', 'diagnostics', 'lsp',
            ]) {
                expect(names).toContain(t);
            }
            expect(names).not.toContain('call_hierarchy_prepare');
        } finally {
            await teardown();
        }
    });

    it('registers call-hierarchy tools when any server declares the capability', async () => {
        const router = new Router(entriesFrom([makeMockServer(['python'], ['**/*.py'], { callHierarchy: true })]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const { tools } = await client.listTools();
            const names = tools.map((t) => t.name);
            expect(names).toContain('call_hierarchy_prepare');
            expect(names).toContain('incoming_calls');
            expect(names).toContain('outgoing_calls');
        } finally {
            await teardown();
        }
    });
});

describe('symbol_search tool', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;
    let tsServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        tsServer = makeMockServer(['typescript'], ['**/*.ts']);
        const router = new Router(entriesFrom([pyServer, tsServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    beforeEach(() => {
        jest.clearAllMocks();
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);
    });

    afterAll(() => teardown());

    it('returns merged results from all servers', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            {
                name: 'MyClass',
                kind: SymbolKind.Class,
                location: {
                    uri: 'file:///a.py',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                },
            },
        ]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            {
                name: 'MyClass',
                kind: SymbolKind.Class,
                location: {
                    uri: 'file:///a.ts',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } },
                },
            },
        ]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'MyClass' },
        });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(textOf(result as { content: unknown }))).toHaveLength(2);
    });

    it('filters by kind when provided', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            {
                name: 'build',
                kind: SymbolKind.Function,
                location: {
                    uri: 'file:///a.py',
                    range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
                },
            },
            {
                name: 'BUILD_DIR',
                kind: SymbolKind.Constant,
                location: {
                    uri: 'file:///a.py',
                    range: { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } },
                },
            },
        ]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'build', kind: 'function' },
        });
        const symbols = JSON.parse(textOf(result as { content: unknown }));
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('build');
    });

    it('filters by langs when provided', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            {
                name: 'Fn',
                kind: SymbolKind.Function,
                location: {
                    uri: 'file:///fn.py',
                    range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } },
                },
            },
        ]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'Fn', langs: ['python'] },
        });
        expect(JSON.parse(textOf(result as { content: unknown }))).toHaveLength(1);
        expect(tsServer.workspaceSymbol).not.toHaveBeenCalled();
    });
});

describe('defs tool', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router(entriesFrom([pyServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('returns locations from textDocument/definition', async () => {
        const loc = {
            uri: 'file:///def.py',
            range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } },
        };
        (pyServer.request as jest.Mock).mockResolvedValue([loc]);

        const result = await client.callTool({
            name: 'defs',
            arguments: { file: 'file:///main.py', pos: { line: 0, character: 4 } },
        });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(textOf(result as { content: unknown }))).toContainEqual(loc);
    });

    it('returns empty array when file has no owning server', async () => {
        const result = await client.callTool({
            name: 'defs',
            arguments: { file: 'file:///main.rs', pos: { line: 0, character: 0 } },
        });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(textOf(result as { content: unknown }))).toEqual([]);
    });

    it('rejects non-file:// URIs via schema validation', async () => {
        const result = await client.callTool({
            name: 'defs',
            arguments: { file: '/not-a-uri.py', pos: { line: 0, character: 0 } },
        });
        expect(result.isError).toBeTruthy();
    });

    it('returns isError when the underlying LSP request fails', async () => {
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('LSP exploded'));
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const result = await client.callTool({
                name: 'defs',
                arguments: { file: 'file:///main.py', pos: { line: 0, character: 0 } },
            });
            expect(result.isError).toBe(true);
            expect(textOf(result as { content: unknown })).toContain('LSP exploded');
            expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('defs error'));
        } finally {
            stderrSpy.mockRestore();
        }
    });
});

describe('refs / impls / outline / hover tools', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router(entriesFrom([pyServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('refs returns location array', async () => {
        const loc = {
            uri: 'file:///r.py',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        };
        (pyServer.request as jest.Mock).mockResolvedValue([loc]);

        const result = await client.callTool({
            name: 'refs',
            arguments: { file: 'file:///main.py', pos: { line: 1, character: 1 } },
        });
        expect(JSON.parse(textOf(result as { content: unknown }))).toContainEqual(loc);
    });

    it('impls returns implementations', async () => {
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const result = await client.callTool({
            name: 'impls',
            arguments: { file: 'file:///main.py', pos: { line: 0, character: 0 } },
        });
        expect(result.isError).toBeFalsy();
        expect(pyServer.request).toHaveBeenCalledWith(
            'textDocument/implementation',
            expect.any(Object)
        );
    });

    it('outline returns document symbols', async () => {
        const syms = [
            {
                name: 'MyClass',
                kind: SymbolKind.Class,
                location: {
                    uri: 'file:///a.py',
                    range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } },
                },
            },
        ];
        (pyServer.request as jest.Mock).mockResolvedValue(syms);

        const result = await client.callTool({
            name: 'outline',
            arguments: { file: 'file:///a.py' },
        });
        expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(syms);
    });

    it('hover returns markdown payload', async () => {
        const hover = { contents: { kind: 'markdown', value: '```py\nfoo\n```' } };
        (pyServer.request as jest.Mock).mockResolvedValue(hover);

        const result = await client.callTool({
            name: 'hover',
            arguments: { file: 'file:///main.py', pos: { line: 2, character: 4 } },
        });
        expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(hover);
    });
});

describe('diagnostics tool', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router(entriesFrom([pyServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('returns diagnostic items', async () => {
        const items = [
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                message: 'bad',
            },
        ];
        (pyServer.request as jest.Mock).mockResolvedValue({ items });

        const result = await client.callTool({
            name: 'diagnostics',
            arguments: { file: 'file:///main.py' },
        });
        expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(items);
    });

    it('returns isError when server does not support pull diagnostics', async () => {
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('Method not found'));
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const result = await client.callTool({
                name: 'diagnostics',
                arguments: { file: 'file:///main.py' },
            });
            expect(result.isError).toBe(true);
            expect(textOf(result as { content: unknown })).toContain('Method not found');
        } finally {
            stderrSpy.mockRestore();
        }
    });
});

describe('lsp escape hatch', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router(entriesFrom([pyServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('forwards raw request to matching language server', async () => {
        const rawResult = { items: [] };
        (pyServer.request as jest.Mock).mockResolvedValue(rawResult);

        const result = await client.callTool({
            name: 'lsp',
            arguments: {
                lang: 'python',
                method: 'textDocument/codeLens',
                params: { textDocument: { uri: 'file:///x.py' } },
            },
        });
        expect(result.isError).toBeFalsy();
        expect(JSON.parse(textOf(result as { content: unknown }))).toEqual(rawResult);
    });

    it('accepts array params', async () => {
        (pyServer.request as jest.Mock).mockResolvedValue({ ok: true });
        const result = await client.callTool({
            name: 'lsp',
            arguments: { lang: 'python', method: 'custom/batch', params: [1, 2, 3] },
        });
        expect(result.isError).toBeFalsy();
        expect(pyServer.request).toHaveBeenCalledWith('custom/batch', [1, 2, 3]);
    });

    it('returns error when no server handles the language', async () => {
        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const result = await client.callTool({
                name: 'lsp',
                arguments: { lang: 'rust', method: 'workspace/symbol', params: { query: '' } },
            });
            expect(result.isError).toBe(true);
        } finally {
            stderrSpy.mockRestore();
        }
    });
});

describe('Tool schemas expose via/manifests', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;
    let router: Router;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py'], {
            name: 'pyright',
            callHierarchy: true,
        });
        router = new Router(entriesFrom([pyServer]));
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('positional tools accept optional via in inputSchema', async () => {
        const { tools } = await client.listTools();
        const positional = [
            'defs', 'refs', 'impls', 'hover', 'outline', 'diagnostics', 'lsp',
            'call_hierarchy_prepare', 'incoming_calls', 'outgoing_calls',
        ];
        for (const name of positional) {
            const tool = tools.find((t) => t.name === name);
            expect(tool).toBeDefined();
            const schema = tool!.inputSchema as {
                properties?: Record<string, unknown>;
                required?: string[];
            };
            expect(schema.properties?.via).toBeDefined();
            expect(schema.required ?? []).not.toContain('via');
        }
    });

    it('symbol_search accepts optional manifests (array of strings)', async () => {
        const { tools } = await client.listTools();
        const tool = tools.find((t) => t.name === 'symbol_search');
        const schema = tool!.inputSchema as {
            properties?: Record<string, { type?: string; items?: { type?: string } }>;
            required?: string[];
        };
        expect(schema.properties?.manifests?.type).toBe('array');
        expect(schema.properties?.manifests?.items?.type).toBe('string');
        expect(schema.required ?? []).not.toContain('manifests');
    });

    it('defs tool forwards via to router.definitions as (file, pos, via)', async () => {
        const spy = jest.spyOn(router, 'definitions').mockResolvedValue([]);
        try {
            await client.callTool({
                name: 'defs',
                arguments: {
                    file: 'file:///x.py',
                    pos: { line: 1, character: 2 },
                    via: 'pyright',
                },
            });
            expect(spy).toHaveBeenCalledWith(
                'file:///x.py',
                { line: 1, character: 2 },
                'pyright'
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('refs tool forwards via to router.references as (file, pos, true, via)', async () => {
        const spy = jest.spyOn(router, 'references').mockResolvedValue([]);
        try {
            await client.callTool({
                name: 'refs',
                arguments: {
                    file: 'file:///x.py',
                    pos: { line: 1, character: 2 },
                    via: 'pyright',
                },
            });
            expect(spy).toHaveBeenCalledWith(
                'file:///x.py',
                { line: 1, character: 2 },
                true,
                'pyright'
            );
        } finally {
            spy.mockRestore();
        }
    });

    it('symbol_search tool forwards manifests to router.symbolSearch', async () => {
        const spy = jest.spyOn(router, 'symbolSearch').mockResolvedValue([]);
        try {
            await client.callTool({
                name: 'symbol_search',
                arguments: { name: 'Foo', manifests: ['pyright'] },
            });
            expect(spy).toHaveBeenCalledWith('Foo', undefined, ['pyright']);
        } finally {
            spy.mockRestore();
        }
    });

    it('symbol_search.langs is an enum of active langIds', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const r = new Router(entriesFrom([py, ts]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const tool = tools.find((t) => t.name === 'symbol_search')!;
            const schema = tool.inputSchema as {
                properties?: { langs?: { items?: { enum?: string[] } } };
            };
            expect(schema.properties?.langs?.items?.enum).toEqual(
                expect.arrayContaining(['python', 'typescript'])
            );
            expect(schema.properties?.langs?.items?.enum).toHaveLength(2);
        } finally {
            await td();
        }
    });

    it('every positional tool publishes via.enum with OK manifest names; via stays optional', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], {
            name: 'pyright',
            callHierarchy: true,
        });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const broken = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-missing' });
        const r = new Router([
            { manifest: py.manifest, server: py, sourceKind: 'config-file', status: 'ok' },
            { manifest: ts.manifest, server: ts, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: broken.manifest,
                server: broken,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const positional = [
                'defs', 'refs', 'impls', 'hover', 'outline', 'diagnostics', 'lsp',
                'call_hierarchy_prepare', 'incoming_calls', 'outgoing_calls',
            ];
            for (const name of positional) {
                const tool = tools.find((t) => t.name === name);
                expect(tool).toBeDefined();
                const schema = tool!.inputSchema as {
                    properties?: { via?: { enum?: string[] } };
                    required?: string[];
                };
                expect(schema.properties?.via?.enum).toEqual(
                    expect.arrayContaining(['pyright', 'tsserver'])
                );
                expect(schema.properties?.via?.enum).toHaveLength(2);
                expect(schema.properties?.via?.enum).not.toContain('pyright-missing');
                expect(schema.required ?? []).not.toContain('via');
            }
        } finally {
            await td();
        }
    });

    it('set_primary.lang and set_primary.manifest are required enums of active langs / OK manifest names', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const broken = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-missing' });
        const r = new Router([
            { manifest: py.manifest, server: py, sourceKind: 'config-file', status: 'ok' },
            { manifest: ts.manifest, server: ts, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: broken.manifest,
                server: broken,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const tool = tools.find((t) => t.name === 'set_primary')!;
            const schema = tool.inputSchema as {
                properties?: {
                    lang?: { enum?: string[] };
                    manifest?: { enum?: string[] };
                };
                required?: string[];
            };
            // lang: required enum of active langs (deduped — python appears once even though two manifests declare it)
            expect(schema.properties?.lang?.enum).toEqual(
                expect.arrayContaining(['python', 'typescript'])
            );
            expect(schema.properties?.lang?.enum).toHaveLength(2);
            expect(schema.required ?? []).toContain('lang');
            // manifest: required enum of OK names; pyright-missing EXCLUDED
            expect(schema.properties?.manifest?.enum).toEqual(
                expect.arrayContaining(['pyright', 'tsserver'])
            );
            expect(schema.properties?.manifest?.enum).toHaveLength(2);
            expect(schema.properties?.manifest?.enum).not.toContain('pyright-missing');
            expect(schema.required ?? []).toContain('manifest');
        } finally {
            await td();
        }
    });

    // ---- Adversarial battery (lspm-4vb Step 15) -------------------------
    // Patterns: singular, dense, multi-langId, redundant, state-transitions
    // (10 swaps), second-run, encoding-boundaries. Each test asserts a
    // structural invariant the factory must hold.

    it('adversarial-singular: one-manifest router → well-formed enum with single value', async () => {
        const only = makeMockServer(['python'], ['**/*.py'], { name: 'only-one' });
        const r = new Router(entriesFrom([only]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const ss = tools.find((t) => t.name === 'symbol_search')!;
            const ssSchema = ss.inputSchema as {
                properties?: { manifests?: { items?: { enum?: string[] } } };
            };
            // single-element array, NOT collapsed to a non-array shape
            expect(ssSchema.properties?.manifests?.items?.enum).toEqual(['only-one']);
            expect(Array.isArray(ssSchema.properties?.manifests?.items?.enum)).toBe(true);
        } finally {
            await td();
        }
    });

    it('adversarial-dense: 20 OK manifests → enum lists all 20, preserves router.entries registration order', async () => {
        const N = 20;
        const servers = Array.from({ length: N }, (_, i) =>
            makeMockServer([`lang-${i}`], [`**/*.l${i}`], { name: `manifest-${i}` })
        );
        const r = new Router(entriesFrom(servers));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const ss = tools.find((t) => t.name === 'symbol_search')!;
            const ssSchema = ss.inputSchema as {
                properties?: { manifests?: { items?: { enum?: string[] } } };
            };
            const expectedNames = Array.from({ length: N }, (_, i) => `manifest-${i}`);
            expect(ssSchema.properties?.manifests?.items?.enum).toEqual(expectedNames);
        } finally {
            await td();
        }
    });

    it('adversarial-multi-langId: one manifest with langIds=[ts, js] contributes BOTH to lang enum (no langId drop)', async () => {
        const tsjs = makeMockServer(['typescript', 'javascript'], ['**/*.{ts,js}'], {
            name: 'tsserver',
        });
        const r = new Router(entriesFrom([tsjs]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const spSchema = setPrim.inputSchema as {
                properties?: { lang?: { enum?: string[] } };
            };
            expect(spSchema.properties?.lang?.enum).toEqual(
                expect.arrayContaining(['typescript', 'javascript'])
            );
            expect(spSchema.properties?.lang?.enum).toHaveLength(2);
        } finally {
            await td();
        }
    });

    it('adversarial-redundant: two manifests both declaring [python] → langs enum lists python once (Set dedupe)', async () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const r = new Router(entriesFrom([a, b]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const spSchema = setPrim.inputSchema as {
                properties?: { lang?: { enum?: string[] } };
            };
            expect(spSchema.properties?.lang?.enum).toEqual(['python']);
        } finally {
            await td();
        }
    });

    it('adversarial-state-transitions: 10 sequential set_primary swaps → schema enums unchanged at every step', async () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const r = new Router(entriesFrom([a, b]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const initial = await c.listTools();
            const captureEnum = (listResp: typeof initial, name: string): string[] | undefined => {
                const tool = listResp.tools.find((t) => t.name === name)!;
                const schema = tool.inputSchema as {
                    properties?: { manifests?: { items?: { enum?: string[] } } };
                };
                return schema.properties?.manifests?.items?.enum;
            };
            const baseline = captureEnum(initial, 'symbol_search');
            for (let i = 0; i < 10; i++) {
                const target = i % 2 === 0 ? 'pyright-fork' : 'pyright';
                await c.callTool({
                    name: 'set_primary',
                    arguments: { lang: 'python', manifest: target },
                });
                const list = await c.listTools();
                expect(captureEnum(list, 'symbol_search')).toEqual(baseline);
            }
        } finally {
            await td();
        }
    });

    it('adversarial-second-run: buildDynamicSchemas via two separate createMcpServer calls on the same router → identical schemas', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const r = new Router(entriesFrom([py, ts]));
        const first = await buildClientServer(r);
        const second = await buildClientServer(r);
        try {
            const firstTools = await first.client.listTools();
            const secondTools = await second.client.listTools();
            // Compare set_primary schemas across both server instances built from
            // the same router — schemas must be byte-identical (no random state,
            // no mutation across calls).
            const firstSP = firstTools.tools.find((t) => t.name === 'set_primary')!;
            const secondSP = secondTools.tools.find((t) => t.name === 'set_primary')!;
            expect(secondSP.inputSchema).toEqual(firstSP.inputSchema);
            const firstSS = firstTools.tools.find((t) => t.name === 'symbol_search')!;
            const secondSS = secondTools.tools.find((t) => t.name === 'symbol_search')!;
            expect(secondSS.inputSchema).toEqual(firstSS.inputSchema);
        } finally {
            await first.teardown();
            await second.teardown();
        }
    });

    it('adversarial-encoding-boundaries: non-ASCII langIds and manifest names preserved byte-identically in enum', async () => {
        // Non-ASCII manifest name + langId — JSON Schema preserves strings
        // byte-identically; zod doesn't transform.
        const m = makeMockServer(['日本語'], ['**/*.ja'], { name: 'lsp-très-special' });
        const r = new Router(entriesFrom([m]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const spSchema = setPrim.inputSchema as {
                properties?: {
                    lang?: { enum?: string[] };
                    manifest?: { enum?: string[] };
                };
            };
            expect(spSchema.properties?.lang?.enum).toEqual(['日本語']);
            expect(spSchema.properties?.manifest?.enum).toEqual(['lsp-très-special']);
        } finally {
            await td();
        }
    });

    it('set_primary swap does NOT alter tool schemas (R7 anti-pattern lock: schemas built once, stable across swaps)', async () => {
        const pyrightA = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightB = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const r = new Router(entriesFrom([pyrightA, pyrightB]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            // Snapshot before swap.
            const before = await c.listTools();
            const ssBefore = before.tools.find((t) => t.name === 'symbol_search')!.inputSchema;
            const setPrimBefore = before.tools.find((t) => t.name === 'set_primary')!.inputSchema;
            const lspBefore = before.tools.find((t) => t.name === 'lsp')!.inputSchema;
            const defsBefore = before.tools.find((t) => t.name === 'defs')!.inputSchema;

            // Swap primary from pyright → pyright-fork.
            await c.callTool({
                name: 'set_primary',
                arguments: { lang: 'python', manifest: 'pyright-fork' },
            });

            // Re-fetch and compare deep-equal.
            const after = await c.listTools();
            const ssAfter = after.tools.find((t) => t.name === 'symbol_search')!.inputSchema;
            const setPrimAfter = after.tools.find((t) => t.name === 'set_primary')!.inputSchema;
            const lspAfter = after.tools.find((t) => t.name === 'lsp')!.inputSchema;
            const defsAfter = after.tools.find((t) => t.name === 'defs')!.inputSchema;

            expect(ssAfter).toEqual(ssBefore);
            expect(setPrimAfter).toEqual(setPrimBefore);
            expect(lspAfter).toEqual(lspBefore);
            expect(defsAfter).toEqual(defsBefore);
        } finally {
            await td();
        }
    });

    it('all-binary_not_found router → no enum on lang/manifest/via schemas (factory ok-filter)', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-missing' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver-missing' });
        const r = new Router([
            { manifest: py.manifest, server: py, sourceKind: 'config-file', status: 'binary_not_found' },
            { manifest: ts.manifest, server: ts, sourceKind: 'config-file', status: 'binary_not_found' },
        ]);
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();

            const symbolSearch = tools.find((t) => t.name === 'symbol_search')!;
            const ssSchema = symbolSearch.inputSchema as {
                properties?: {
                    langs?: { items?: { enum?: unknown } };
                    manifests?: { items?: { enum?: unknown } };
                };
            };
            expect(ssSchema.properties?.langs?.items?.enum).toBeUndefined();
            expect(ssSchema.properties?.manifests?.items?.enum).toBeUndefined();

            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const spSchema = setPrim.inputSchema as {
                properties?: { lang?: { enum?: unknown }; manifest?: { enum?: unknown } };
            };
            expect(spSchema.properties?.lang?.enum).toBeUndefined();
            expect(spSchema.properties?.manifest?.enum).toBeUndefined();

            const lspTool = tools.find((t) => t.name === 'lsp')!;
            const lspSchema = lspTool.inputSchema as {
                properties?: { lang?: { enum?: unknown }; via?: { enum?: unknown } };
            };
            expect(lspSchema.properties?.lang?.enum).toBeUndefined();
            expect(lspSchema.properties?.via?.enum).toBeUndefined();

            const defs = tools.find((t) => t.name === 'defs')!;
            const defsSchema = defs.inputSchema as {
                properties?: { via?: { enum?: unknown } };
            };
            expect(defsSchema.properties?.via?.enum).toBeUndefined();
        } finally {
            await td();
        }
    });

    it('empty router → schemas fall back to plain string (no enum); required-vs-optional preserved per param', async () => {
        const r = new Router(entriesFrom([]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();

            const symbolSearch = tools.find((t) => t.name === 'symbol_search')!;
            const ssSchema = symbolSearch.inputSchema as {
                properties?: {
                    langs?: { items?: { type?: string; enum?: unknown } };
                    manifests?: { items?: { type?: string; enum?: unknown } };
                };
                required?: string[];
            };
            // langs / manifests stay optional arrays of plain strings
            expect(ssSchema.properties?.langs?.items?.enum).toBeUndefined();
            expect(ssSchema.properties?.langs?.items?.type).toBe('string');
            expect(ssSchema.properties?.manifests?.items?.enum).toBeUndefined();
            expect(ssSchema.properties?.manifests?.items?.type).toBe('string');
            expect(ssSchema.required ?? []).not.toContain('langs');
            expect(ssSchema.required ?? []).not.toContain('manifests');

            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const spSchema = setPrim.inputSchema as {
                properties?: {
                    lang?: { type?: string; enum?: unknown };
                    manifest?: { type?: string; enum?: unknown };
                };
                required?: string[];
            };
            // lang / manifest stay required plain strings
            expect(spSchema.properties?.lang?.enum).toBeUndefined();
            expect(spSchema.properties?.lang?.type).toBe('string');
            expect(spSchema.properties?.manifest?.enum).toBeUndefined();
            expect(spSchema.properties?.manifest?.type).toBe('string');
            expect(spSchema.required ?? []).toContain('lang');
            expect(spSchema.required ?? []).toContain('manifest');

            const lspTool = tools.find((t) => t.name === 'lsp')!;
            const lspSchema = lspTool.inputSchema as {
                properties?: {
                    lang?: { type?: string; enum?: unknown };
                    via?: { type?: string; enum?: unknown };
                };
                required?: string[];
            };
            // lsp.lang required plain string; via optional plain string
            expect(lspSchema.properties?.lang?.enum).toBeUndefined();
            expect(lspSchema.properties?.lang?.type).toBe('string');
            expect(lspSchema.required ?? []).toContain('lang');
            expect(lspSchema.properties?.via?.enum).toBeUndefined();
            expect(lspSchema.properties?.via?.type).toBe('string');
            expect(lspSchema.required ?? []).not.toContain('via');

            // positional defs: via optional plain string
            const defs = tools.find((t) => t.name === 'defs')!;
            const defsSchema = defs.inputSchema as {
                properties?: { via?: { type?: string; enum?: unknown } };
                required?: string[];
            };
            expect(defsSchema.properties?.via?.enum).toBeUndefined();
            expect(defsSchema.properties?.via?.type).toBe('string');
            expect(defsSchema.required ?? []).not.toContain('via');
        } finally {
            await td();
        }
    });

    it('lsp.lang is a required enum of active langs and equals set_primary.lang.enum (single LangEnum source)', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const r = new Router(entriesFrom([py, ts]));
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const lspTool = tools.find((t) => t.name === 'lsp')!;
            const setPrim = tools.find((t) => t.name === 'set_primary')!;
            const lspSchema = lspTool.inputSchema as {
                properties?: { lang?: { enum?: string[] } };
                required?: string[];
            };
            const setPrimSchema = setPrim.inputSchema as {
                properties?: { lang?: { enum?: string[] } };
            };
            expect(lspSchema.properties?.lang?.enum).toEqual(
                expect.arrayContaining(['python', 'typescript'])
            );
            expect(lspSchema.properties?.lang?.enum).toHaveLength(2);
            expect(lspSchema.required ?? []).toContain('lang');
            // Single-source invariant: both consumers wire to the same LangEnum.
            expect(lspSchema.properties?.lang?.enum).toEqual(setPrimSchema.properties?.lang?.enum);
        } finally {
            await td();
        }
    });

    it('symbol_search.manifests is an enum of OK manifest names; binary_not_found EXCLUDED', async () => {
        const py = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const ts = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsserver' });
        const broken = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-missing' });
        const r = new Router([
            { manifest: py.manifest, server: py, sourceKind: 'config-file', status: 'ok' },
            { manifest: ts.manifest, server: ts, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: broken.manifest,
                server: broken,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);
        const { client: c, teardown: td } = await buildClientServer(r);
        try {
            const { tools } = await c.listTools();
            const tool = tools.find((t) => t.name === 'symbol_search')!;
            const schema = tool.inputSchema as {
                properties?: { manifests?: { items?: { enum?: string[] } } };
            };
            expect(schema.properties?.manifests?.items?.enum).toEqual(
                expect.arrayContaining(['pyright', 'tsserver'])
            );
            expect(schema.properties?.manifests?.items?.enum).toHaveLength(2);
            expect(schema.properties?.manifests?.items?.enum).not.toContain('pyright-missing');
        } finally {
            await td();
        }
    });
});

describe('list_languages tool', () => {
    it('is registered in the tool list', async () => {
        const router = new Router(entriesFrom([makeMockServer(['python'], ['**/*.py'])]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const { tools } = await client.listTools();
            const names = tools.map((t) => t.name);
            expect(names).toContain('list_languages');
        } finally {
            await teardown();
        }
    });

    it('returns array matching Router.listLanguages() shape — 1 ok + 1 binary_not_found', async () => {
        const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'ok-lsp' });
        const missingServer = makeMockServer(['rust'], ['**/*.rs'], { name: 'missing-lsp' });
        const router = new Router([
            { manifest: okServer.manifest, server: okServer, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: missingServer.manifest,
                server: missingServer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);
        const { client, teardown } = await buildClientServer(router);
        try {
            const result = await client.callTool({ name: 'list_languages', arguments: {} });
            expect(result.isError).toBeFalsy();

            const parsed = JSON.parse(textOf(result as { content: unknown }));
            // Matches Router.listLanguages() shape exactly.
            expect(parsed).toEqual(router.listLanguages());
            expect(parsed).toHaveLength(2);
            expect(parsed[0]).toMatchObject({ lang: 'python', manifest: 'ok-lsp', primary: true, status: 'ok' });
            expect(parsed[1]).toMatchObject({
                lang: 'rust',
                manifest: 'missing-lsp',
                primary: false,
                status: 'binary_not_found',
            });
        } finally {
            await teardown();
        }
    });

    // Adversarial: MCP response must be pure JSON — no LspServer circular refs.
    it('response payload round-trips through JSON.stringify/JSON.parse (no circular refs)', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const result = await client.callTool({ name: 'list_languages', arguments: {} });
            const text = textOf(result as { content: unknown });
            // If the handler leaked a LspServer into the response, JSON.stringify would
            // throw on the circular reference. The MCP SDK text-wrapping already serialized,
            // so we verify the payload is idempotent under an additional round-trip.
            const parsed = JSON.parse(text);
            expect(() => JSON.stringify(parsed)).not.toThrow();
            const reencoded = JSON.parse(JSON.stringify(parsed));
            expect(reencoded).toEqual(parsed);
            // Confirm no 'server' key leaked from ManifestEntry into LanguageInfo.
            for (const row of parsed) {
                expect(row).not.toHaveProperty('server');
            }
        } finally {
            await teardown();
        }
    });
});

describe('set_primary tool', () => {
    it('is registered in the tool list', async () => {
        const router = new Router(entriesFrom([makeMockServer(['python'], ['**/*.py'])]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const { tools } = await client.listTools();
            const names = tools.map((t) => t.name);
            expect(names).toContain('set_primary');
        } finally {
            await teardown();
        }
    });

    it('swaps primary and returns {lang, primary, previous}; list_languages reflects the swap', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const swap = await client.callTool({
                name: 'set_primary',
                arguments: { lang: 'python', manifest: 'pyright-fork' },
            });
            expect(swap.isError).toBeFalsy();
            const parsed = JSON.parse(textOf(swap as { content: unknown }));
            expect(parsed).toEqual({
                lang: 'python',
                primary: 'pyright-fork',
                previous: 'pyright',
            });

            // Round-trip: observe the swap via list_languages.
            const listing = await client.callTool({
                name: 'list_languages',
                arguments: {},
            });
            const rows = JSON.parse(textOf(listing as { content: unknown }));
            expect(rows).toHaveLength(2);
            expect(rows).toContainEqual(
                expect.objectContaining({
                    lang: 'python',
                    manifest: 'pyright-fork',
                    primary: true,
                })
            );
            expect(rows).toContainEqual(
                expect.objectContaining({
                    lang: 'python',
                    manifest: 'pyright',
                    primary: false,
                })
            );
        } finally {
            await teardown();
        }
    });

    it('success and error responses both round-trip through JSON.stringify/JSON.parse without throwing', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));
        const { client, teardown } = await buildClientServer(router);
        try {
            // Success path.
            const ok = await client.callTool({
                name: 'set_primary',
                arguments: { lang: 'python', manifest: 'pyright-fork' },
            });
            const okParsed = JSON.parse(textOf(ok as { content: unknown }));
            expect(() => JSON.stringify(okParsed)).not.toThrow();
            expect(JSON.parse(JSON.stringify(okParsed))).toEqual(okParsed);
            // Confirm no internal objects leaked.
            expect(okParsed).not.toHaveProperty('server');

            // Error path.
            const err = await client.callTool({
                name: 'set_primary',
                arguments: { lang: 'python', manifest: 'nope' },
            });
            expect(err.isError).toBe(true);
            const errText = textOf(err as { content: unknown });
            expect(() => JSON.stringify(errText)).not.toThrow();
            // Error text survives an extra round-trip cleanly.
            expect(JSON.parse(JSON.stringify(errText))).toBe(errText);
        } finally {
            await teardown();
        }
    });

    // Post-R7b (lspm-4vb): set_primary.lang and set_primary.manifest are
    // dynamic enums. Three of the four router-level validation cases (unknown
    // manifest name, unknown lang, binary_not_found manifest) are now caught
    // by Zod schema validation at the MCP layer BEFORE reaching the router.
    // Their original assertions live below as router-direct tests; the
    // MCP-layer Zod-rejection coverage lives in the new test after that. The
    // surviving MCP-layer case (cross-dispatch — manifest exists in enum but
    // isn't a candidate for the lang) keeps its original shape.
    it('surfaces cross-dispatch validation failure (manifest not a candidate for lang) at MCP layer', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });
        const router = new Router(entriesFrom([pyright, rustAnalyzer]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const result = await client.callTool({
                name: 'set_primary',
                arguments: { lang: 'python', manifest: 'rust-analyzer' },
            });
            expect(result.isError).toBe(true);
            const text = textOf(result as { content: unknown });
            expect(text).toMatch(/not a candidate for lang 'python'/);
        } finally {
            await teardown();
        }
    });

    it('surfaces router-level validation failures (Router.setPrimary) — unknown manifest, unknown lang, binary_not_found', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });
        const pyrightMissing = makeMockServer(['python'], ['**/*.py'], {
            name: 'pyright-missing',
        });
        const router = new Router([
            { manifest: pyright.manifest, server: pyright, sourceKind: 'config-file', status: 'ok' },
            { manifest: rustAnalyzer.manifest, server: rustAnalyzer, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: pyrightMissing.manifest,
                server: pyrightMissing,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);
        // Suppress stderr — Router._binaryNotFoundError logs nothing, but
        // setPrimary emits stderr on success only; these are throws, not logs.
        expect(() => router.setPrimary('python', 'nope')).toThrow(
            /Unknown manifest: nope/
        );
        expect(() => router.setPrimary('cobol', 'pyright')).toThrow(
            /Unknown lang: cobol/
        );
        expect(() => router.setPrimary('python', 'pyright-missing')).toThrow(
            /binary_not_found/
        );
    });

    it('surfaces Zod schema validation as isError:true when set_primary called with out-of-enum lang/manifest (R7b enum-contract negative coverage)', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });
        const router = new Router(entriesFrom([pyright, rustAnalyzer]));
        const { client, teardown } = await buildClientServer(router);
        try {
            const cases: Array<{ args: { lang: string; manifest: string } }> = [
                { args: { lang: 'python', manifest: 'nope' } }, // unknown manifest → Zod rejects
                { args: { lang: 'cobol', manifest: 'pyright' } }, // unknown lang → Zod rejects
            ];
            for (const c of cases) {
                const result = await client.callTool({
                    name: 'set_primary',
                    arguments: c.args,
                });
                expect(result.isError).toBe(true);
                const text = textOf(result as { content: unknown });
                // Don't over-couple to Zod's exact wording — assert the shape:
                // some kind of validation error referencing enum / invalid.
                expect(text.toLowerCase()).toMatch(/invalid|enum/);
            }
        } finally {
            await teardown();
        }
    });
});
