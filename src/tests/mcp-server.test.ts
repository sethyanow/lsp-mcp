import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp-server';
import { Router } from '../router';
import type { LspServer } from '../lsp-server';
import type { PluginManifest } from '../types';
import { SymbolKind } from '../types';
import { minimatch } from 'minimatch';

// ---- Mock helpers ----------------------------------------------------------

interface MockOpts {
    callHierarchy?: boolean;
}

function makeMockServer(
    langIds: string[],
    fileGlobs: string[],
    opts: MockOpts = {}
): jest.Mocked<LspServer> {
    const manifest: PluginManifest = {
        name: 'mock',
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
        const router = new Router([]);
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
        const router = new Router([makeMockServer(['python'], ['**/*.py'], { callHierarchy: true })]);
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
        const router = new Router([pyServer, tsServer]);
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
        const router = new Router([pyServer]);
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
        const router = new Router([pyServer]);
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
        const router = new Router([pyServer]);
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
        const router = new Router([pyServer]);
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
