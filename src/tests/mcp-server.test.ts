import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../mcp-server';
import { Router } from '../router';
import type { LspServer } from '../lsp-server';
import { SymbolKind } from '../types';

// ---- Mock helpers ----------------------------------------------------------

function makeMockServer(langIds: string[], fileGlobs: string[]): jest.Mocked<LspServer> {
    return {
        manifest: {
            name: 'mock',
            version: '0.1.0',
            langIds,
            fileGlobs,
            workspaceMarkers: [],
            server: { cmd: ['echo'] },
            capabilities: {
                workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 },
            },
        },
        ensureRunning: jest.fn().mockResolvedValue(undefined),
        shutdown: jest.fn().mockResolvedValue(undefined),
        request: jest.fn(),
        openDocument: jest.fn().mockResolvedValue(undefined),
        waitForAnalysis: jest.fn().mockResolvedValue(undefined),
        workspaceSymbol: jest.fn().mockResolvedValue([]),
        ownsFile: jest.fn((filePath: string) =>
            fileGlobs.some((g) => filePath.endsWith(g.replace(/\*\*\/\*/, '')))
        ),
        ownsLang: jest.fn((l: string) => langIds.includes(l)),
    } as unknown as jest.Mocked<LspServer>;
}

// ---- Shared setup ----------------------------------------------------------

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

// ---- Tests -----------------------------------------------------------------

describe('MCP server tool registration', () => {
    let client: Client;
    let teardown: () => Promise<void>;

    beforeAll(async () => {
        const router = new Router([]);
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('registers all expected tools', async () => {
        const { tools } = await client.listTools();
        const names = tools.map((t) => t.name);
        expect(names).toContain('symbol_search');
        expect(names).toContain('defs');
        expect(names).toContain('refs');
        expect(names).toContain('impls');
        expect(names).toContain('hover');
        expect(names).toContain('outline');
        expect(names).toContain('diagnostics');
        expect(names).toContain('lsp');
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
        // Restore default mocks cleared above
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);
    });

    afterAll(() => teardown());

    it('returns merged results from all servers', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            { name: 'MyClass', kind: SymbolKind.Class, location: { uri: 'file:///a.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } } },
        ]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            { name: 'MyClass', kind: SymbolKind.Class, location: { uri: 'file:///a.ts', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 7 } } } },
        ]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'MyClass' },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        const symbols = JSON.parse(content[0].text);
        expect(symbols).toHaveLength(2);
    });

    it('filters by kind when provided', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            { name: 'build', kind: SymbolKind.Function, location: { uri: 'file:///a.py', range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } } } },
            { name: 'BUILD_DIR', kind: SymbolKind.Constant, location: { uri: 'file:///a.py', range: { start: { line: 2, character: 0 }, end: { line: 2, character: 9 } } } },
        ]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'build', kind: 'function' },
        });

        const content = result.content as Array<{ type: string; text: string }>;
        const symbols = JSON.parse(content[0].text);
        expect(symbols).toHaveLength(1);
        expect(symbols[0].name).toBe('build');
    });

    it('filters by langs when provided', async () => {
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            { name: 'Fn', kind: SymbolKind.Function, location: { uri: 'file:///fn.py', range: { start: { line: 0, character: 0 }, end: { line: 0, character: 2 } } } },
        ]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([]);

        const result = await client.callTool({
            name: 'symbol_search',
            arguments: { name: 'Fn', langs: ['python'] },
        });

        const content = result.content as Array<{ type: string; text: string }>;
        const symbols = JSON.parse(content[0].text);
        expect(symbols).toHaveLength(1);
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
        const loc = { uri: 'file:///def.py', range: { start: { line: 5, character: 0 }, end: { line: 5, character: 3 } } };
        (pyServer.request as jest.Mock).mockResolvedValue([loc]);

        const result = await client.callTool({
            name: 'defs',
            arguments: { file: 'file:///main.py', pos: { line: 0, character: 4 } },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        const locations = JSON.parse(content[0].text);
        expect(locations).toContainEqual(loc);
    });

    it('returns empty array when file has no owning server', async () => {
        const result = await client.callTool({
            name: 'defs',
            arguments: { file: 'file:///main.rs', pos: { line: 0, character: 0 } },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0].text)).toEqual([]);
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
            arguments: { lang: 'python', method: 'textDocument/codeLens', params: { textDocument: { uri: 'file:///x.py' } } },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0].text)).toEqual(rawResult);
    });

    it('returns error when no server handles the language', async () => {
        const result = await client.callTool({
            name: 'lsp',
            arguments: { lang: 'rust', method: 'workspace/symbol', params: { query: '' } },
        });

        expect(result.isError).toBe(true);
    });
});

describe('hover tool', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router([pyServer]);
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('returns hover info', async () => {
        const hoverResult = { contents: { kind: 'markdown', value: '```python\ndef foo() -> int\n```' } };
        (pyServer.request as jest.Mock).mockResolvedValue(hoverResult);

        const result = await client.callTool({
            name: 'hover',
            arguments: { file: 'file:///main.py', pos: { line: 2, character: 4 } },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0].text)).toEqual(hoverResult);
    });
});

describe('outline tool', () => {
    let client: Client;
    let teardown: () => Promise<void>;
    let pyServer: jest.Mocked<LspServer>;

    beforeAll(async () => {
        pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router([pyServer]);
        ({ client, teardown } = await buildClientServer(router));
    });

    afterAll(() => teardown());

    it('returns document symbols', async () => {
        const syms = [
            { name: 'MyClass', kind: SymbolKind.Class, location: { uri: 'file:///a.py', range: { start: { line: 0, character: 0 }, end: { line: 5, character: 0 } } } },
        ];
        (pyServer.request as jest.Mock).mockResolvedValue(syms);

        const result = await client.callTool({
            name: 'outline',
            arguments: { file: 'file:///a.py' },
        });

        expect(result.isError).toBeFalsy();
        const content = result.content as Array<{ type: string; text: string }>;
        expect(JSON.parse(content[0].text)).toEqual(syms);
    });
});
