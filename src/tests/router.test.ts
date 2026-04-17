import { Router } from '../router';
import type { LspServer } from '../lsp-server';
import type { PluginManifest, SymbolInfo } from '../types';
import { SymbolKind } from '../types';
import { minimatch } from 'minimatch';

// ---- Mock LspServer --------------------------------------------------------

function makeMockServer(langIds: string[], fileGlobs: string[]): jest.Mocked<LspServer> {
    const manifest: PluginManifest = {
        name: 'mock',
        version: '0.1.0',
        langIds,
        fileGlobs,
        workspaceMarkers: [],
        server: { cmd: ['echo'] },
        capabilities: {
            workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 },
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
        workspaceSymbol: jest.fn(),
        ownsFile: jest.fn((filePath: string) =>
            fileGlobs.some((g) => minimatch(filePath, g, { nocase: true, dot: true }))
        ),
        ownsLang: jest.fn((l: string) => langIds.includes(l)),
    } as unknown as jest.Mocked<LspServer>;
}

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

    it('matches nested glob patterns via minimatch', () => {
        const pyServer = makeMockServer(['python'], ['src/**/*.py']);
        const router = new Router([pyServer]);

        expect(router.serverForFile('src/deep/nested/file.py')).toBe(pyServer);
        expect(router.serverForFile('other/file.py')).toBeUndefined();
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

    it('deduplicates symbols with the same (uri, range)', async () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['python'], ['**/*.py']);

        const sym = makeSymbol('Dup', SymbolKind.Function, 'file:///dup.py', 3);
        (s1.workspaceSymbol as jest.Mock).mockResolvedValue([sym]);
        (s2.workspaceSymbol as jest.Mock).mockResolvedValue([sym]);

        const router = new Router([s1, s2]);
        expect(await router.symbolSearch('Dup')).toHaveLength(1);
    });

    it('filters by langIds when provided', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);

        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            makeSymbol('Fn', SymbolKind.Function, 'file:///fn.py'),
        ]);
        (tsServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            makeSymbol('Fn', SymbolKind.Function, 'file:///fn.ts'),
        ]);

        const router = new Router([pyServer, tsServer]);
        const results = await router.symbolSearch('Fn', ['python']);

        expect(results).toHaveLength(1);
        expect(results[0].location.uri).toBe('file:///fn.py');
        expect(tsServer.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('logs to stderr when a server rejects but still merges others', async () => {
        const bad = makeMockServer(['python'], ['**/*.py']);
        const good = makeMockServer(['typescript'], ['**/*.ts']);

        (bad.workspaceSymbol as jest.Mock).mockRejectedValue(new Error('boom'));
        (good.workspaceSymbol as jest.Mock).mockResolvedValue([
            makeSymbol('X', SymbolKind.Class, 'file:///x.ts'),
        ]);

        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const router = new Router([bad, good]);
            const results = await router.symbolSearch('X');

            expect(results).toHaveLength(1);
            expect(stderrSpy).toHaveBeenCalledWith(expect.stringContaining('boom'));
        } finally {
            stderrSpy.mockRestore();
        }
    });

    it('keeps URI-only symbols distinct by name even with identical zero-range', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const sameLoc = { uri: 'file:///a.py', range: {
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        } };
        (pyServer.workspaceSymbol as jest.Mock).mockResolvedValue([
            { name: 'Alpha', kind: SymbolKind.Class, location: sameLoc },
            { name: 'Beta', kind: SymbolKind.Class, location: sameLoc },
        ]);

        const router = new Router([pyServer]);
        const results = await router.symbolSearch('');
        expect(results.map((s) => s.name).sort()).toEqual(['Alpha', 'Beta']);
    });
});

describe('Router.definitions', () => {
    it('delegates to the owning server with the server\'s default langId', async () => {
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

    it('propagates server errors instead of swallowing them', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('LSP timed out'));

        const router = new Router([pyServer]);
        await expect(
            router.definitions('file:///main.py', { line: 0, character: 0 })
        ).rejects.toThrow('LSP timed out');
    });
});

describe('Router.references and implementations', () => {
    it('references passes includeDeclaration and routes correctly', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const loc = {
            uri: 'file:///r.py',
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } },
        };
        (pyServer.request as jest.Mock).mockResolvedValue([loc]);

        const router = new Router([pyServer]);
        const result = await router.references('file:///main.py', { line: 1, character: 2 });

        expect(pyServer.request).toHaveBeenCalledWith(
            'textDocument/references',
            expect.objectContaining({ context: { includeDeclaration: true } })
        );
        expect(result).toEqual([loc]);
    });

    it('implementations calls textDocument/implementation', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const router = new Router([pyServer]);
        await router.implementations('file:///main.py', { line: 0, character: 0 });

        expect(pyServer.request).toHaveBeenCalledWith(
            'textDocument/implementation',
            expect.any(Object)
        );
    });
});

describe('Router.diagnostics', () => {
    it('returns the report items when the server supports pull diagnostics', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const items = [
            {
                range: { start: { line: 0, character: 0 }, end: { line: 0, character: 1 } },
                message: 'oops',
            },
        ];
        (pyServer.request as jest.Mock).mockResolvedValue({ items });

        const router = new Router([pyServer]);
        const result = await router.diagnostics('file:///main.py');
        expect(result).toEqual(items);
    });

    it('propagates errors from servers that do not support pull diagnostics', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('Method not found'));

        const router = new Router([pyServer]);
        await expect(router.diagnostics('file:///main.py')).rejects.toThrow('Method not found');
    });
});

describe('Router.raw', () => {
    it('forwards the request to the matching language server', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue({ result: 'ok' });

        const router = new Router([pyServer]);
        const result = await router.raw('python', 'workspace/symbol', { query: 'X' });

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

describe('Router call-hierarchy routing', () => {
    it('prepareCallHierarchy routes by fileUri', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue([{ name: 'foo' }]);

        const router = new Router([pyServer]);
        const result = await router.prepareCallHierarchy('file:///m.py', { line: 0, character: 0 });
        expect(result).toEqual([{ name: 'foo' }]);
        expect(pyServer.request).toHaveBeenCalledWith(
            'textDocument/prepareCallHierarchy',
            expect.any(Object)
        );
    });

    it('incomingCalls routes by item.uri', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue([{ from: 'bar' }]);

        const router = new Router([pyServer]);
        const result = await router.incomingCalls({ uri: 'file:///m.py', name: 'foo' });
        expect(result).toEqual([{ from: 'bar' }]);
    });

    it('incomingCalls returns [] when the item has no routable uri', async () => {
        const router = new Router([makeMockServer(['python'], ['**/*.py'])]);
        const result = await router.incomingCalls({ name: 'foo' });
        expect(result).toEqual([]);
    });
});

describe('Router.shutdownAll / forceKillAll', () => {
    it('calls shutdown on every server', async () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['typescript'], ['**/*.ts']);

        const router = new Router([s1, s2]);
        await router.shutdownAll();

        expect(s1.shutdown).toHaveBeenCalled();
        expect(s2.shutdown).toHaveBeenCalled();
    });

    it('forceKillAll calls forceKill on every server', () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['typescript'], ['**/*.ts']);

        const router = new Router([s1, s2]);
        router.forceKillAll();

        expect(s1.forceKill).toHaveBeenCalled();
        expect(s2.forceKill).toHaveBeenCalled();
    });
});

describe('Router._fileRequest — post-open pause', () => {
    it('skips the 100ms pause when document was already open', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.openDocument as jest.Mock).mockResolvedValue(false);
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        try {
            const router = new Router([pyServer]);
            await router.definitions('file:///main.py', { line: 0, character: 0 });
            const delayCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 100);
            expect(delayCalls).toHaveLength(0);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });

    it('schedules a 100ms pause when the document is newly opened', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.openDocument as jest.Mock).mockResolvedValue(true);
        (pyServer.request as jest.Mock).mockResolvedValue([]);

        const setTimeoutSpy = jest.spyOn(global, 'setTimeout');
        try {
            const router = new Router([pyServer]);
            await router.definitions('file:///main.py', { line: 0, character: 0 });
            const delayCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 100);
            expect(delayCalls).toHaveLength(1);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});
