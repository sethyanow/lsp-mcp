import { Router } from '../router';
import type { LspServer } from '../lsp-server';
import type { SymbolInfo } from '../types';
import { SymbolKind } from '../types';

// ---- Mock LspServer --------------------------------------------------------

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
        openDocument: jest.fn().mockResolvedValue(false),
        waitForAnalysis: jest.fn().mockResolvedValue(undefined),
        workspaceSymbol: jest.fn(),
        ownsFile: jest.fn((filePath: string) =>
            fileGlobs.some((g) => filePath.endsWith(g.replace(/\*\*\/\*/, '')))
        ),
        ownsLang: jest.fn((l: string) => langIds.includes(l)),
    } as unknown as jest.Mocked<LspServer>;
}

// ---- Helpers ---------------------------------------------------------------

function makeSymbol(name: string, kind: SymbolKind, uri: string, line = 0): SymbolInfo {
    return {
        name,
        kind,
        location: {
            uri,
            range: { start: { line, character: 0 }, end: { line, character: name.length } },
        },
    };
}

// ---- Tests -----------------------------------------------------------------

describe('Router.serverForFile', () => {
    it('returns the server whose fileGlobs match', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);
        const router = new Router([pyServer, tsServer]);

        expect(router.serverForFile('/workspace/main.py')).toBe(pyServer);
        expect(router.serverForFile('/workspace/app.ts')).toBe(tsServer);
    });

    it('returns undefined when no server matches', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router([pyServer]);
        expect(router.serverForFile('/workspace/main.rs')).toBeUndefined();
    });
});

describe('Router.serverForLang', () => {
    it('returns the server whose langIds match', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);
        const router = new Router([pyServer, tsServer]);

        expect(router.serverForLang('python')).toBe(pyServer);
        expect(router.serverForLang('typescript')).toBe(tsServer);
        expect(router.serverForLang('rust')).toBeUndefined();
    });
});

describe('Router.symbolSearch', () => {
    it('fans out to all servers and merges results', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);

        const pySymbol = makeSymbol('MyClass', SymbolKind.Class, 'file:///a.py', 0);
        const tsSymbol = makeSymbol('MyClass', SymbolKind.Class, 'file:///a.ts', 5);

        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([pySymbol]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([tsSymbol]);

        const router = new Router([pyServer, tsServer]);
        const results = await router.symbolSearch('MyClass');

        expect(results).toHaveLength(2);
        expect(results).toContainEqual(pySymbol);
        expect(results).toContainEqual(tsSymbol);
    });

    it('deduplicates symbols with the same (uri, line, character)', async () => {
        const server1 = makeMockServer(['python'], ['**/*.py']);
        const server2 = makeMockServer(['python'], ['**/*.py']);

        const sym = makeSymbol('Dup', SymbolKind.Function, 'file:///dup.py', 3);
        (server1.workspaceSymbol as jest.Mock).mockResolvedValue([sym]);
        (server2.workspaceSymbol as jest.Mock).mockResolvedValue([sym]);

        const router = new Router([server1, server2]);
        const results = await router.symbolSearch('Dup');

        expect(results).toHaveLength(1);
    });

    it('filters by langIds when provided', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);

        const pySym = makeSymbol('Fn', SymbolKind.Function, 'file:///fn.py');
        const tsSym = makeSymbol('Fn', SymbolKind.Function, 'file:///fn.ts');

        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([pySym]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([tsSym]);

        const router = new Router([pyServer, tsServer]);
        const results = await router.symbolSearch('Fn', ['python']);

        expect(results).toHaveLength(1);
        expect(results[0].location.uri).toBe('file:///fn.py');
        expect(tsServer.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('returns empty array when all servers fail', async () => {
        const server = makeMockServer(['python'], ['**/*.py']);
        (server.workspaceSymbol as jest.Mock).mockRejectedValue(new Error('timeout'));

        const router = new Router([server]);
        const results = await router.symbolSearch('X');
        expect(results).toHaveLength(0);
    });
});

describe('Router.definitions', () => {
    it('delegates to the owning server', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const location = {
            uri: 'file:///def.py',
            range: { start: { line: 1, character: 0 }, end: { line: 1, character: 5 } },
        };
        (pyServer.request as jest.Mock).mockResolvedValue([location]);

        const router = new Router([pyServer]);
        const result = await router.definitions('file:///main.py', { line: 0, character: 0 });

        expect(pyServer.openDocument).toHaveBeenCalledWith('file:///main.py', 'python');
        expect(result).toEqual([location]);
    });

    it('returns empty array when no server owns the file', async () => {
        const router = new Router([]);
        const result = await router.definitions('file:///main.rs', { line: 0, character: 0 });
        expect(result).toEqual([]);
    });
});

describe('Router.raw', () => {
    it('forwards the request to the matching language server', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue({ result: 'ok' });

        const router = new Router([pyServer]);
        const result = await router.raw('python', 'workspace/symbol', { query: 'X' });

        expect(pyServer.ensureRunning).toHaveBeenCalled();
        expect(pyServer.request).toHaveBeenCalledWith('workspace/symbol', { query: 'X' });
        expect(result).toEqual({ result: 'ok' });
    });

    it('throws when no server handles the language', async () => {
        const router = new Router([]);
        await expect(router.raw('rust', 'workspace/symbol', {})).rejects.toThrow(
            'No server configured for language: rust'
        );
    });
});

describe('Router.shutdownAll', () => {
    it('calls shutdown on every server', async () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['typescript'], ['**/*.ts']);

        const router = new Router([s1, s2]);
        await router.shutdownAll();

        expect(s1.shutdown).toHaveBeenCalled();
        expect(s2.shutdown).toHaveBeenCalled();
    });
});

describe('Router._fileRequest — post-open pause', () => {
    it('skips the 100ms pause when document was already open', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        // Simulate document already open: openDocument returns false
        (pyServer.openDocument as jest.Mock).mockResolvedValue(false);
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const router = new Router([pyServer]);
        const start = Date.now();
        await router.definitions('file:///main.py', { line: 0, character: 0 });
        const elapsed = Date.now() - start;

        // Should NOT have waited 100ms
        expect(elapsed).toBeLessThan(80);
    });

    it('applies the 100ms pause when document is newly opened', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        // Simulate first open: openDocument returns true
        (pyServer.openDocument as jest.Mock).mockResolvedValue(true);
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const router = new Router([pyServer]);
        const start = Date.now();
        await router.definitions('file:///main.py', { line: 0, character: 0 });
        const elapsed = Date.now() - start;

        // Should have waited ~100ms
        expect(elapsed).toBeGreaterThanOrEqual(80);
    });
});
