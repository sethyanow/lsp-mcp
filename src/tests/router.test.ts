import { Router, type ManifestEntry } from '../router';
import type { LspServer } from '../lsp-server';
import type { PluginManifest, SymbolInfo } from '../types';
import { SymbolKind } from '../types';
import { minimatch } from 'minimatch';

// Test-fixture convention (lspm-h1n): attach sourceKind:"config-file" on every
// synthesized ManifestEntry. Avoids implying the fixture represents a shipped
// default. Keep this convention identical in mcp-server.test.ts and e2e.test.ts.
function entriesFrom(servers: LspServer[]): ManifestEntry[] {
    return servers.map((s) => ({
        manifest: s.manifest,
        server: s,
        sourceKind: 'config-file' as const,
        status: 'ok' as const,
    }));
}

// ---- Mock LspServer --------------------------------------------------------

let mockCounter = 0;
function nextMockName(): string {
    return `mock-${mockCounter++}`;
}

function makeMockServer(
    langIds: string[],
    fileGlobs: string[],
    opts: { name?: string } = {}
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

describe('Router multi-candidate routing', () => {
    it('first-registered candidate becomes primary for a lang', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });

        const router = new Router(entriesFrom([pyright, pyrightFork]));

        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it('candidatesForLang returns all candidates in registration order', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });

        const router = new Router(entriesFrom([pyright, pyrightFork]));

        expect(router.candidatesForLang('python').map((e) => e.manifest.name)).toEqual([
            'pyright',
            'pyright-fork',
        ]);
    });

    it('unknown lang returns undefined primary and empty candidates', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        expect(router.primaryForLang('rust')).toBeUndefined();
        expect(router.candidatesForLang('rust')).toEqual([]);
    });

    it('entry() returns the ManifestEntry by manifest name', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });

        const router = new Router(entriesFrom([pyright, pyrightFork]));

        expect(router.entry('pyright-fork')?.manifest.name).toBe('pyright-fork');
        expect(router.entry('nope')).toBeUndefined();
    });

    it('duplicate manifest names are dropped with first-wins + stderr log', () => {
        const first = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const second = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });

        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const router = new Router(entriesFrom([first, second]));

            expect(router.entries).toHaveLength(1);
            expect(router.entry('pyright')?.server).toBe(first);
            expect(router.candidatesForLang('python').map((e) => e.server)).toEqual([first]);
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('duplicate manifest name "pyright"')
            );
        } finally {
            stderrSpy.mockRestore();
        }
    });

    it('primaryForFile returns the first candidate whose server owns the file', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });

        const router = new Router(entriesFrom([pyright, pyrightFork]));

        expect(router.primaryForFile('/workspace/main.py')?.manifest.name).toBe('pyright');
    });

    it('primaryForFile picks the lang whose primary owns the file', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });

        const router = new Router(entriesFrom([pyright, rustAnalyzer]));

        expect(router.primaryForFile('/workspace/main.rs')?.manifest.name).toBe('rust-analyzer');
        expect(router.primaryForFile('/workspace/main.py')?.manifest.name).toBe('pyright');
    });

    it('primaryForFile returns undefined when no candidate owns the file', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        expect(router.primaryForFile('/workspace/main.go')).toBeUndefined();
    });
});

describe('Router.serverForFile', () => {
    it('returns the server whose fileGlobs match', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);
        const router = new Router(entriesFrom([pyServer, tsServer]));

        expect(router.serverForFile('/workspace/main.py')).toBe(pyServer);
        expect(router.serverForFile('/workspace/app.ts')).toBe(tsServer);
    });

    it('matches nested glob patterns via minimatch', () => {
        const pyServer = makeMockServer(['python'], ['src/**/*.py']);
        const router = new Router(entriesFrom([pyServer]));

        expect(router.serverForFile('src/deep/nested/file.py')).toBe(pyServer);
        expect(router.serverForFile('other/file.py')).toBeUndefined();
    });

    it('returns undefined when no server matches', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const router = new Router(entriesFrom([pyServer]));
        expect(router.serverForFile('/workspace/main.rs')).toBeUndefined();
    });
});

describe('Router.serverForLang', () => {
    it('returns the server whose langIds match', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        const tsServer = makeMockServer(['typescript'], ['**/*.ts']);
        const router = new Router(entriesFrom([pyServer, tsServer]));

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

        const router = new Router(entriesFrom([pyServer, tsServer]));
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

        const router = new Router(entriesFrom([s1, s2]));
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

        const router = new Router(entriesFrom([pyServer, tsServer]));
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
            const router = new Router(entriesFrom([bad, good]));
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

        const router = new Router(entriesFrom([pyServer]));
        const results = await router.symbolSearch('');
        expect(results.map((s) => s.name).sort()).toEqual(['Alpha', 'Beta']);
    });
});

describe('Router via parameter', () => {
    function setupCandidates(): {
        pyright: jest.Mocked<LspServer>;
        pyrightFork: jest.Mocked<LspServer>;
        router: Router;
    } {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        (pyright.request as jest.Mock).mockResolvedValue([]);
        (pyrightFork.request as jest.Mock).mockResolvedValue([]);
        const router = new Router(entriesFrom([pyright, pyrightFork]));
        return { pyright, pyrightFork, router };
    }

    it('definitions routes to the named candidate when via is given', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.definitions('file:///x.py', { line: 0, character: 0 }, 'pyright-fork');

        expect(pyrightFork.request).toHaveBeenCalled();
        expect(pyrightFork.openDocument).toHaveBeenCalled();
        expect(pyright.request).not.toHaveBeenCalled();
    });

    it('definitions falls through to primary when via is undefined', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.definitions('file:///x.py', { line: 0, character: 0 });

        expect(pyright.request).toHaveBeenCalled();
        expect(pyrightFork.request).not.toHaveBeenCalled();
    });

    it('definitions with unknown via throws', async () => {
        const { router } = setupCandidates();

        await expect(
            router.definitions('file:///x.py', { line: 0, character: 0 }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('definitions with empty-string via throws (adversarial edge case)', async () => {
        const { router } = setupCandidates();

        await expect(
            router.definitions('file:///x.py', { line: 0, character: 0 }, '')
        ).rejects.toThrow(/No manifest named ""/);
    });

    it('references routes to named candidate via + default includeDeclaration', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.references('file:///x.py', { line: 0, character: 0 }, true, 'pyright-fork');

        expect(pyrightFork.request).toHaveBeenCalledWith(
            'textDocument/references',
            expect.objectContaining({ context: { includeDeclaration: true } })
        );
        expect(pyright.request).not.toHaveBeenCalled();
    });

    it('references with unknown via throws', async () => {
        const { router } = setupCandidates();
        await expect(
            router.references('file:///x.py', { line: 0, character: 0 }, true, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('implementations routes via; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.implementations('file:///x.py', { line: 0, character: 0 }, 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalledWith(
            'textDocument/implementation',
            expect.any(Object)
        );
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.implementations('file:///x.py', { line: 0, character: 0 }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('hover routes via; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();
        (pyrightFork.request as jest.Mock).mockResolvedValue({ contents: 'x' });

        const result = await router.hover('file:///x.py', { line: 0, character: 0 }, 'pyright-fork');
        expect(result).toEqual({ contents: 'x' });
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.hover('file:///x.py', { line: 0, character: 0 }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('documentSymbols routes via; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.documentSymbols('file:///x.py', 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalledWith(
            'textDocument/documentSymbol',
            expect.any(Object)
        );
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.documentSymbols('file:///x.py', 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('diagnostics routes via; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();
        (pyrightFork.request as jest.Mock).mockResolvedValue({ items: [] });

        await router.diagnostics('file:///x.py', 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalledWith(
            'textDocument/diagnostic',
            expect.any(Object)
        );
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.diagnostics('file:///x.py', 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('prepareCallHierarchy routes via; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();

        await router.prepareCallHierarchy('file:///x.py', { line: 0, character: 0 }, 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalledWith(
            'textDocument/prepareCallHierarchy',
            expect.any(Object)
        );
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.prepareCallHierarchy('file:///x.py', { line: 0, character: 0 }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('incomingCalls routes via overriding item.uri; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();
        (pyrightFork.request as jest.Mock).mockResolvedValue([]);

        // item.uri points at a python file (would normally route to pyright),
        // but via pins to pyright-fork.
        await router.incomingCalls({ uri: 'file:///x.py', name: 'f' }, 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalled();
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.incomingCalls({ uri: 'file:///x.py', name: 'f' }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('outgoingCalls routes via overriding item.uri; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();
        (pyrightFork.request as jest.Mock).mockResolvedValue([]);

        await router.outgoingCalls({ uri: 'file:///x.py', name: 'f' }, 'pyright-fork');
        expect(pyrightFork.request).toHaveBeenCalled();
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.outgoingCalls({ uri: 'file:///x.py', name: 'f' }, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });

    it('raw routes via by manifest name; unknown via throws', async () => {
        const { pyright, pyrightFork, router } = setupCandidates();
        (pyrightFork.request as jest.Mock).mockResolvedValue({ ok: true });

        const result = await router.raw('python', 'workspace/symbol', { query: 'X' }, 'pyright-fork');
        expect(result).toEqual({ ok: true });
        expect(pyright.request).not.toHaveBeenCalled();

        await expect(
            router.raw('python', 'workspace/symbol', {}, 'nope')
        ).rejects.toThrow(/No manifest named "nope"/);
    });
});

describe('Router.symbolSearch multi-candidate fan-out', () => {
    function setupFanOut(): {
        pyright: jest.Mocked<LspServer>;
        pyrightFork: jest.Mocked<LspServer>;
        tsLs: jest.Mocked<LspServer>;
        router: Router;
    } {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const tsLs = makeMockServer(['typescript'], ['**/*.ts'], { name: 'typescript-language-server' });
        (pyright.workspaceSymbol as jest.Mock).mockResolvedValue([]);
        (pyrightFork.workspaceSymbol as jest.Mock).mockResolvedValue([]);
        (tsLs.workspaceSymbol as jest.Mock).mockResolvedValue([]);
        const router = new Router(entriesFrom([pyright, pyrightFork, tsLs]));
        return { pyright, pyrightFork, tsLs, router };
    }

    it('default fan-out hits primaries only (not sibling candidates)', async () => {
        const { pyright, pyrightFork, tsLs, router } = setupFanOut();

        await router.symbolSearch('x');

        expect(pyright.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(pyrightFork.workspaceSymbol).not.toHaveBeenCalled();
        expect(tsLs.workspaceSymbol).toHaveBeenCalledTimes(1);
    });

    it('langIds filter restricts to that lang\'s primary only', async () => {
        const { pyright, pyrightFork, tsLs, router } = setupFanOut();

        await router.symbolSearch('x', ['python']);

        expect(pyright.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(pyrightFork.workspaceSymbol).not.toHaveBeenCalled();
        expect(tsLs.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('explicit manifests scopes fan-out to named entries only', async () => {
        const { pyright, pyrightFork, tsLs, router } = setupFanOut();

        await router.symbolSearch('x', undefined, ['pyright-fork']);

        expect(pyrightFork.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(pyright.workspaceSymbol).not.toHaveBeenCalled();
        expect(tsLs.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('explicit manifests with unknown name: skipped, stderr logged, known names still called', async () => {
        const { pyrightFork, router } = setupFanOut();

        const stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            await router.symbolSearch('x', undefined, ['unknown', 'pyright-fork']);

            expect(pyrightFork.workspaceSymbol).toHaveBeenCalledTimes(1);
            expect(stderrSpy).toHaveBeenCalledWith(
                expect.stringContaining('no manifest named "unknown"')
            );
        } finally {
            stderrSpy.mockRestore();
        }
    });

    it('empty manifests array falls through to primary-only default', async () => {
        const { pyright, pyrightFork, tsLs, router } = setupFanOut();

        await router.symbolSearch('x', undefined, []);

        expect(pyright.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(pyrightFork.workspaceSymbol).not.toHaveBeenCalled();
        expect(tsLs.workspaceSymbol).toHaveBeenCalledTimes(1);
    });

    it('duplicate manifest names in explicit list fan exactly once (adversarial)', async () => {
        const { pyright, pyrightFork, router } = setupFanOut();

        await router.symbolSearch('x', undefined, ['pyright-fork', 'pyright-fork']);

        expect(pyrightFork.workspaceSymbol).toHaveBeenCalledTimes(1);
        expect(pyright.workspaceSymbol).not.toHaveBeenCalled();
    });
});

describe('Router adversarial: structural edge cases', () => {
    it('manifest with empty langIds is reachable by name but absent from langMap', () => {
        const noLang = makeMockServer([], ['**/*.weird'], { name: 'no-lang' });
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });

        const router = new Router(entriesFrom([noLang, pyright]));

        expect(router.entries).toHaveLength(2);
        expect(router.entry('no-lang')?.manifest.name).toBe('no-lang');
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
        // No langId declared → candidatesForLang returns empty for any lang.
        expect(router.candidatesForLang('')).toEqual([]);
    });

    it('single manifest declaring multiple langIds is primary for each, no duplicate candidates', () => {
        const multi = makeMockServer(['python', 'jython'], ['**/*.py'], { name: 'multi' });

        const router = new Router(entriesFrom([multi]));

        expect(router.primaryForLang('python')?.manifest.name).toBe('multi');
        expect(router.primaryForLang('jython')?.manifest.name).toBe('multi');
        expect(router.candidatesForLang('python')).toHaveLength(1);
        expect(router.candidatesForLang('jython')).toHaveLength(1);
    });

    it('three same-lang candidates: first-wins primary, ordered candidate list', () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const c = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-exp' });

        const router = new Router(entriesFrom([a, b, c]));

        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
        expect(router.candidatesForLang('python').map((e) => e.manifest.name)).toEqual([
            'pyright',
            'pyright-fork',
            'pyright-exp',
        ]);
    });

    it('symbolSearch with empty langIds filter returns nothing and fans zero servers', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        (pyright.workspaceSymbol as jest.Mock).mockResolvedValue([]);

        const router = new Router(entriesFrom([pyright]));
        const result = await router.symbolSearch('x', []);

        expect(result).toEqual([]);
        expect(pyright.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('symbolSearch with langIds containing only unknown langs returns empty', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        (pyright.workspaceSymbol as jest.Mock).mockResolvedValue([]);

        const router = new Router(entriesFrom([pyright]));
        const result = await router.symbolSearch('x', ['klingon']);

        expect(result).toEqual([]);
        expect(pyright.workspaceSymbol).not.toHaveBeenCalled();
    });

    it('via can override lang routing to a cross-lang manifest', async () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });
        (rustAnalyzer.request as jest.Mock).mockResolvedValue([]);

        const router = new Router(entriesFrom([pyright, rustAnalyzer]));

        // File is *.py (would normally route to pyright) but via pins to rust-analyzer.
        // The LSP request is still dispatched — manifest boundary trumps glob ownership.
        await router.definitions('file:///x.py', { line: 0, character: 0 }, 'rust-analyzer');

        expect(rustAnalyzer.request).toHaveBeenCalled();
        expect(pyright.request).not.toHaveBeenCalled();
    });

    it('Router([]) — no manifests: all accessors are benign', () => {
        const router = new Router([]);

        expect(router.entries).toEqual([]);
        expect(router.servers).toEqual([]);
        expect(router.entry('anything')).toBeUndefined();
        expect(router.primaryForLang('python')).toBeUndefined();
        expect(router.candidatesForLang('python')).toEqual([]);
        expect(router.primaryForFile('/x.py')).toBeUndefined();
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

        const router = new Router(entriesFrom([pyServer]));
        const result = await router.definitions('file:///main.py', { line: 0, character: 0 });

        expect(pyServer.openDocument).toHaveBeenCalledWith('file:///main.py', 'python');
        expect(result).toEqual([location]);
    });

    it('returns empty array when no server owns the file', async () => {
        const router = new Router(entriesFrom([]));
        const result = await router.definitions('file:///main.rs', { line: 0, character: 0 });
        expect(result).toEqual([]);
    });

    it('propagates server errors instead of swallowing them', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('LSP timed out'));

        const router = new Router(entriesFrom([pyServer]));
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

        const router = new Router(entriesFrom([pyServer]));
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

        const router = new Router(entriesFrom([pyServer]));
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

        const router = new Router(entriesFrom([pyServer]));
        const result = await router.diagnostics('file:///main.py');
        expect(result).toEqual(items);
    });

    it('propagates errors from servers that do not support pull diagnostics', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockRejectedValue(new Error('Method not found'));

        const router = new Router(entriesFrom([pyServer]));
        await expect(router.diagnostics('file:///main.py')).rejects.toThrow('Method not found');
    });
});

describe('Router.raw', () => {
    it('forwards the request to the matching language server', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue({ result: 'ok' });

        const router = new Router(entriesFrom([pyServer]));
        const result = await router.raw('python', 'workspace/symbol', { query: 'X' });

        expect(pyServer.request).toHaveBeenCalledWith('workspace/symbol', { query: 'X' });
        expect(result).toEqual({ result: 'ok' });
    });

    it('throws when no server handles the language', async () => {
        const router = new Router(entriesFrom([]));
        await expect(router.raw('rust', 'workspace/symbol', {})).rejects.toThrow(
            'No server configured for language: rust'
        );
    });
});

describe('Router call-hierarchy routing', () => {
    it('prepareCallHierarchy routes by fileUri', async () => {
        const pyServer = makeMockServer(['python'], ['**/*.py']);
        (pyServer.request as jest.Mock).mockResolvedValue([{ name: 'foo' }]);

        const router = new Router(entriesFrom([pyServer]));
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

        const router = new Router(entriesFrom([pyServer]));
        const result = await router.incomingCalls({ uri: 'file:///m.py', name: 'foo' });
        expect(result).toEqual([{ from: 'bar' }]);
    });

    it('incomingCalls returns [] when the item has no routable uri', async () => {
        const router = new Router(entriesFrom([makeMockServer(['python'], ['**/*.py'])]));
        const result = await router.incomingCalls({ name: 'foo' });
        expect(result).toEqual([]);
    });
});

describe('Router.shutdownAll / forceKillAll', () => {
    it('calls shutdown on every server', async () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['typescript'], ['**/*.ts']);

        const router = new Router(entriesFrom([s1, s2]));
        await router.shutdownAll();

        expect(s1.shutdown).toHaveBeenCalled();
        expect(s2.shutdown).toHaveBeenCalled();
    });

    it('forceKillAll calls forceKill on every server', () => {
        const s1 = makeMockServer(['python'], ['**/*.py']);
        const s2 = makeMockServer(['typescript'], ['**/*.ts']);

        const router = new Router(entriesFrom([s1, s2]));
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
            const router = new Router(entriesFrom([pyServer]));
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
            const router = new Router(entriesFrom([pyServer]));
            await router.definitions('file:///main.py', { line: 0, character: 0 });
            const delayCalls = setTimeoutSpy.mock.calls.filter(([, ms]) => ms === 100);
            expect(delayCalls).toHaveLength(1);
        } finally {
            setTimeoutSpy.mockRestore();
        }
    });
});

describe('ManifestEntry.sourceKind threading', () => {
    it('preserves the sourceKind attached at construction on each entry', () => {
        const pyServer = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const tsServer = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsls' });

        const entries: ManifestEntry[] = [
            { manifest: pyServer.manifest, server: pyServer, sourceKind: 'builtin', status: 'ok' },
            { manifest: tsServer.manifest, server: tsServer, sourceKind: 'config-file', status: 'ok' },
        ];
        const router = new Router(entries);

        expect(router.entries[0].sourceKind).toBe('builtin');
        expect(router.entries[1].sourceKind).toBe('config-file');
    });
});

describe('Router — adversarial: all manifests binary_not_found', () => {
    it('builds cleanly, _langMap is empty, primaryForLang returns undefined, symbol_search returns []', async () => {
        const missA = makeMockServer(['python'], ['**/*.py'], { name: 'miss-a' });
        const missB = makeMockServer(['rust'], ['**/*.rs'], { name: 'miss-b' });
        missA.workspaceSymbol.mockResolvedValue([]);
        missB.workspaceSymbol.mockResolvedValue([]);

        const router = new Router([
            { manifest: missA.manifest, server: missA, sourceKind: 'config-file', status: 'binary_not_found' },
            { manifest: missB.manifest, server: missB, sourceKind: 'config-file', status: 'binary_not_found' },
        ]);

        // All entries are enumerable for future list_languages (R6).
        expect(router.entries.map((e) => e.manifest.name).sort()).toEqual(['miss-a', 'miss-b']);
        expect(router.entries.every((e) => e.status === 'binary_not_found')).toBe(true);

        // Routing map is empty.
        expect(router.primaryForLang('python')).toBeUndefined();
        expect(router.primaryForLang('rust')).toBeUndefined();

        // Default symbol_search fan-out (no explicit manifests) sees no targets.
        await expect(router.symbolSearch('query')).resolves.toEqual([]);
        expect(missA.workspaceSymbol).not.toHaveBeenCalled();
        expect(missB.workspaceSymbol).not.toHaveBeenCalled();
    });
});

describe('Router — via routing rejects binary_not_found manifests with informative error', () => {
    it('throws "Manifest X is binary_not_found — binary not found on PATH" when via targets a missing-binary manifest', async () => {
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

        await expect(
            router.definitions('file:///src/main.rs', { line: 0, character: 0 }, 'missing-lsp')
        ).rejects.toThrow(/Manifest "missing-lsp" is binary_not_found.*binary not found on PATH/);

        // Unknown-name path should still surface its distinct message (regression guard).
        await expect(
            router.definitions('file:///src/main.rs', { line: 0, character: 0 }, 'no-such-manifest')
        ).rejects.toThrow(/No manifest named "no-such-manifest"/);
    });
});

describe('Router — symbol_search soft-skips binary_not_found manifests', () => {
    it('skips binary_not_found in explicit-manifests mode, emits stderr notice, does not call LspServer.workspaceSymbol', async () => {
        const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'ok-lsp' });
        const missingServer = makeMockServer(['rust'], ['**/*.rs'], { name: 'missing-lsp' });
        okServer.workspaceSymbol.mockResolvedValue([]);
        missingServer.workspaceSymbol.mockResolvedValue([]);

        const router = new Router([
            { manifest: okServer.manifest, server: okServer, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: missingServer.manifest,
                server: missingServer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        const stderr = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
        try {
            const results = await router.symbolSearch('query', undefined, ['missing-lsp']);

            expect(results).toEqual([]);
            expect(missingServer.workspaceSymbol).not.toHaveBeenCalled();
            const messages = stderr.mock.calls.map((c) => String(c[0])).join('');
            expect(messages).toMatch(/symbol_search.*"missing-lsp".*binary_not_found/i);
        } finally {
            stderr.mockRestore();
        }
    });
});

describe('Router — ManifestEntry.status gate', () => {
    it('keeps binary_not_found entries in entries/entry() but excludes them from routing', () => {
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

        // All manifests remain enumerable — list_languages (R6) depends on this.
        expect(router.entries).toHaveLength(2);
        expect(router.entry('ok-lsp')?.status).toBe('ok');
        expect(router.entry('missing-lsp')?.status).toBe('binary_not_found');

        // Only the ok manifest participates in langId → primary routing.
        expect(router.primaryForLang('python')?.manifest.name).toBe('ok-lsp');
        expect(router.primaryForLang('rust')).toBeUndefined();
    });
});

describe('Router — listLanguages', () => {
    it('returns {lang, manifest, primary, status, capabilities} rows for every (entry, langId) pair — ok-only router', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const tsls = makeMockServer(['typescript', 'javascript'], ['**/*.ts', '**/*.js'], {
            name: 'tsls',
        });

        const router = new Router(entriesFrom([pyright, tsls]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(3);

        // Row shape — every row has the 5 documented fields.
        for (const row of rows) {
            expect(Object.keys(row).sort()).toEqual(
                ['capabilities', 'lang', 'manifest', 'primary', 'status'].sort()
            );
        }

        // Python row (from pyright)
        expect(rows[0]).toEqual({
            lang: 'python',
            manifest: 'pyright',
            primary: true,
            status: 'ok',
            capabilities: pyright.manifest.capabilities,
        });

        // typescript + javascript rows (from tsls) — both primary:true, same manifest.
        expect(rows[1]).toEqual({
            lang: 'typescript',
            manifest: 'tsls',
            primary: true,
            status: 'ok',
            capabilities: tsls.manifest.capabilities,
        });
        expect(rows[2]).toEqual({
            lang: 'javascript',
            manifest: 'tsls',
            primary: true,
            status: 'ok',
            capabilities: tsls.manifest.capabilities,
        });
    });

    it('binary_not_found manifests surface with primary:false and their declared langIds', () => {
        const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'ok-lsp' });
        const missingServer = makeMockServer(['rust'], ['**/*.rs'], { name: 'missing-lsp' });

        const router = new Router([
            {
                manifest: okServer.manifest,
                server: okServer,
                sourceKind: 'config-file',
                status: 'ok',
            },
            {
                manifest: missingServer.manifest,
                server: missingServer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        const rows = router.listLanguages();

        expect(rows).toHaveLength(2);

        expect(rows[0]).toEqual({
            lang: 'python',
            manifest: 'ok-lsp',
            primary: true,
            status: 'ok',
            capabilities: okServer.manifest.capabilities,
        });

        expect(rows[1]).toEqual({
            lang: 'rust',
            manifest: 'missing-lsp',
            primary: false,
            status: 'binary_not_found',
            capabilities: missingServer.manifest.capabilities,
        });
    });

    it('two ok candidates for one lang: first-registered is primary, other is primary:false', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });

        const router = new Router(entriesFrom([pyright, pyrightFork]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(2);
        expect(rows[0]).toEqual({
            lang: 'python',
            manifest: 'pyright',
            primary: true,
            status: 'ok',
            capabilities: pyright.manifest.capabilities,
        });
        expect(rows[1]).toEqual({
            lang: 'python',
            manifest: 'pyright-fork',
            primary: false,
            status: 'ok',
            capabilities: pyrightFork.manifest.capabilities,
        });
    });

    it('manifest with multiple langIds emits one row per langId — all sharing manifest/status', () => {
        const polyglot = makeMockServer(['typescript', 'javascript', 'tsx', 'jsx'], ['**/*.{ts,tsx,js,jsx}'], {
            name: 'polyglot-ts',
        });

        const router = new Router(entriesFrom([polyglot]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(4);
        expect(rows.map((r) => r.lang)).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
        // Every row shares the same manifest name + status; each is primary for its lang.
        for (const row of rows) {
            expect(row.manifest).toBe('polyglot-ts');
            expect(row.status).toBe('ok');
            expect(row.primary).toBe(true);
        }
    });

    it('empty router returns []', () => {
        const router = new Router([]);
        expect(router.listLanguages()).toEqual([]);
    });

    // ---- Adversarial battery (Step 12 + Failure catalog) ----------------------

    it('all manifests binary_not_found: every row has primary:false', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });

        const router = new Router([
            {
                manifest: pyright.manifest,
                server: pyright,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
            {
                manifest: rustAnalyzer.manifest,
                server: rustAnalyzer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        const rows = router.listLanguages();
        expect(rows).toHaveLength(2);
        for (const row of rows) {
            expect(row.primary).toBe(false);
            expect(row.status).toBe('binary_not_found');
        }
    });

    it('manifest with zero langIds emits zero rows for that manifest', () => {
        const normal = makeMockServer(['python'], ['**/*.py'], { name: 'normal' });
        const empty = makeMockServer([], [], { name: 'empty-langids' });

        const router = new Router(entriesFrom([normal, empty]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(1);
        expect(rows[0].manifest).toBe('normal');
        expect(rows.find((r) => r.manifest === 'empty-langids')).toBeUndefined();
    });

    it('calling listLanguages twice returns equivalent shape (idempotency; no caching bugs)', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const tsls = makeMockServer(['typescript'], ['**/*.ts'], { name: 'tsls' });
        const router = new Router(entriesFrom([pyright, tsls]));

        const first = router.listLanguages();
        const second = router.listLanguages();

        expect(second).toEqual(first);
    });

    // Failure catalog: Temporal Betrayal — listLanguages must not spawn LSP processes
    it('listLanguages does NOT call any LspServer methods (spawn safety)', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const tsls = makeMockServer(['typescript', 'javascript'], ['**/*.ts'], { name: 'tsls' });
        const missing = makeMockServer(['rust'], ['**/*.rs'], { name: 'missing' });

        const router = new Router([
            { manifest: pyright.manifest, server: pyright, sourceKind: 'config-file', status: 'ok' },
            { manifest: tsls.manifest, server: tsls, sourceKind: 'config-file', status: 'ok' },
            {
                manifest: missing.manifest,
                server: missing,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        // Clear any calls that happened during construction (e.g., ownsFile probes).
        jest.clearAllMocks();

        router.listLanguages();

        for (const server of [pyright, tsls, missing]) {
            expect(server.ensureRunning).not.toHaveBeenCalled();
            expect(server.shutdown).not.toHaveBeenCalled();
            expect(server.forceKill).not.toHaveBeenCalled();
            expect(server.request).not.toHaveBeenCalled();
            expect(server.openDocument).not.toHaveBeenCalled();
            expect(server.waitForAnalysis).not.toHaveBeenCalled();
            expect(server.workspaceSymbol).not.toHaveBeenCalled();
            expect(server.ownsFile).not.toHaveBeenCalled();
            expect(server.ownsLang).not.toHaveBeenCalled();
        }
    });

    // Failure catalog: State Corruption — ok entry missing primary slot
    it('single ok manifest with one langId, no competing candidate: primary is ALWAYS true (invariant lock)', () => {
        const solo = makeMockServer(['python'], ['**/*.py'], { name: 'solo' });
        const router = new Router(entriesFrom([solo]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(1);
        expect(rows[0].primary).toBe(true);
        expect(rows[0].status).toBe('ok');
    });

    // Failure catalog: Input Hostility — duplicate langIds within one manifest
    it('duplicate langIds within one manifest emit two rows — no dedupe at list time', () => {
        const dupedLangs = makeMockServer(['python', 'python'], ['**/*.py'], { name: 'duped' });
        const router = new Router(entriesFrom([dupedLangs]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(2);
        expect(rows[0]).toMatchObject({ lang: 'python', manifest: 'duped' });
        expect(rows[1]).toMatchObject({ lang: 'python', manifest: 'duped' });
    });

    // Adversarial (stress test): encoding boundaries — empty-string and non-ASCII langIds.
    // Schema validates langIds as z.array(z.string()) — does not reject empty or unicode.
    // Expectation: listLanguages faithfully reports whatever the manifest declares; it
    // is not the enumeration's job to validate lang-ID well-formedness.
    it('tolerates empty-string and non-ASCII langIds without dropping, crashing, or mangling', () => {
        const weirdLangs = makeMockServer(['', '日本語', '\u0000', 'plain'], ['**/*.x'], {
            name: 'weird-langs',
        });
        const router = new Router(entriesFrom([weirdLangs]));
        const rows = router.listLanguages();

        expect(rows).toHaveLength(4);
        expect(rows.map((r) => r.lang)).toEqual(['', '日本語', '\u0000', 'plain']);
        // Each langId owns its own slot in _langMap, so first-registered-wins still applies
        // per-lang: this single manifest is primary for each of its 4 distinct langIds.
        for (const row of rows) {
            expect(row.manifest).toBe('weird-langs');
            expect(row.primary).toBe(true);
            expect(row.status).toBe('ok');
        }
        // Round-trips through JSON without corruption (critical for the MCP surface).
        const reencoded = JSON.parse(JSON.stringify(rows));
        expect(reencoded).toEqual(rows);
    });

    // Adversarial (stress test): dense — 50 manifests × 4 langIds each.
    // Expectation: O(N × M) enumeration completes quickly; no quadratic blowup from
    // the nested loop + _langMap lookup.
    it('scales linearly across 50 manifests × 4 langIds (dense case)', () => {
        const servers = Array.from({ length: 50 }, (_, i) =>
            makeMockServer([`lang-${i}-a`, `lang-${i}-b`, `lang-${i}-c`, `lang-${i}-d`], [`**/*.${i}`], {
                name: `manifest-${i}`,
            })
        );
        const router = new Router(entriesFrom(servers));

        const started = Date.now();
        const rows = router.listLanguages();
        const elapsed = Date.now() - started;

        expect(rows).toHaveLength(200);
        // Every row is primary:true (each lang has exactly one candidate).
        expect(rows.filter((r) => r.primary)).toHaveLength(200);
        // Wall-clock sanity — linear enumeration should finish in single-digit ms.
        expect(elapsed).toBeLessThan(500);
    });
});

describe('Router — setPrimary', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('swaps primary for a lang and returns {lang, primary, previous}', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));

        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');

        const result = router.setPrimary('python', 'pyright-fork');

        expect(result).toEqual({
            lang: 'python',
            primary: 'pyright-fork',
            previous: 'pyright',
        });
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright-fork');
    });

    it('listLanguages reflects the swap on next call (no caching)', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));

        // Pre-swap snapshot: pyright primary, pyright-fork not.
        const before = router.listLanguages();
        expect(before).toEqual([
            {
                lang: 'python',
                manifest: 'pyright',
                primary: true,
                status: 'ok',
                capabilities: pyright.manifest.capabilities,
            },
            {
                lang: 'python',
                manifest: 'pyright-fork',
                primary: false,
                status: 'ok',
                capabilities: pyrightFork.manifest.capabilities,
            },
        ]);

        router.setPrimary('python', 'pyright-fork');

        // Post-swap: pyright demoted, pyright-fork promoted. Row order preserved.
        const after = router.listLanguages();
        expect(after).toEqual([
            {
                lang: 'python',
                manifest: 'pyright',
                primary: false,
                status: 'ok',
                capabilities: pyright.manifest.capabilities,
            },
            {
                lang: 'python',
                manifest: 'pyright-fork',
                primary: true,
                status: 'ok',
                capabilities: pyrightFork.manifest.capabilities,
            },
        ]);
    });

    it('is an idempotent no-op when the new primary equals the current one (single candidate)', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        const result = router.setPrimary('python', 'pyright');

        expect(result).toEqual({
            lang: 'python',
            primary: 'pyright',
            previous: 'pyright',
        });
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
        // Stderr log is suppressed on no-op.
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('is an idempotent no-op when the new primary equals the current one (multi-candidate)', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));

        // pyright is already primary (first-registered). Setting it again is a no-op.
        const result = router.setPrimary('python', 'pyright');

        expect(result).toEqual({
            lang: 'python',
            primary: 'pyright',
            previous: 'pyright',
        });
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('throws on unknown manifest and leaves primary unchanged', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        expect(() => router.setPrimary('python', 'nonexistent-manifest')).toThrow(
            /Unknown manifest: nonexistent-manifest/
        );
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it('throws on unknown lang and leaves primary unchanged', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        expect(() => router.setPrimary('rust', 'pyright')).toThrow(/Unknown lang: rust/);
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it("throws when manifest is not a candidate for the target lang", () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const rustAnalyzer = makeMockServer(['rust'], ['**/*.rs'], { name: 'rust-analyzer' });
        const router = new Router(entriesFrom([pyright, rustAnalyzer]));

        expect(() => router.setPrimary('python', 'rust-analyzer')).toThrow(
            /not a candidate for lang 'python'/
        );
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it('refuses to promote a binary_not_found manifest and leaves primary unchanged', () => {
        const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const missingServer = makeMockServer(['python'], ['**/*.py'], {
            name: 'pyright-missing',
        });
        const router = new Router([
            {
                manifest: okServer.manifest,
                server: okServer,
                sourceKind: 'config-file',
                status: 'ok',
            },
            {
                manifest: missingServer.manifest,
                server: missingServer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        expect(() => router.setPrimary('python', 'pyright-missing')).toThrow(
            /binary_not_found/
        );
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it('logs to stderr on a successful swap with {lang previous → new} format', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const pyrightFork = makeMockServer(['python'], ['**/*.py'], { name: 'pyright-fork' });
        const router = new Router(entriesFrom([pyright, pyrightFork]));

        router.setPrimary('python', 'pyright-fork');

        const stderrCalls = stderrSpy.mock.calls.map((c) => String(c[0]));
        const swapLog = stderrCalls.find((line) =>
            line.includes('set_primary: python pyright → pyright-fork')
        );
        expect(swapLog).toBeDefined();
        expect(swapLog).toMatch(/^\[lsp-mcp\] set_primary: python pyright → pyright-fork/);
    });

    // ---- Adversarial battery ----------------------------------------------

    it('setPrimary on an empty router throws Unknown manifest', () => {
        const router = new Router([]);
        expect(() => router.setPrimary('python', 'anything')).toThrow(
            /Unknown manifest: anything/
        );
    });

    it('sequential swaps A→B→A restore initial state with correct previous at each step', () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'a' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'b' });
        const router = new Router(entriesFrom([a, b]));

        expect(router.setPrimary('python', 'b')).toEqual({
            lang: 'python',
            primary: 'b',
            previous: 'a',
        });
        expect(router.setPrimary('python', 'a')).toEqual({
            lang: 'python',
            primary: 'a',
            previous: 'b',
        });
        expect(router.primaryForLang('python')?.manifest.name).toBe('a');
    });

    it('failed swap to a binary_not_found candidate leaves primary unchanged (state-corruption lock)', () => {
        const okServer = makeMockServer(['python'], ['**/*.py'], { name: 'ok' });
        const missingServer = makeMockServer(['python'], ['**/*.py'], { name: 'missing' });
        const router = new Router([
            {
                manifest: okServer.manifest,
                server: okServer,
                sourceKind: 'config-file',
                status: 'ok',
            },
            {
                manifest: missingServer.manifest,
                server: missingServer,
                sourceKind: 'config-file',
                status: 'binary_not_found',
            },
        ]);

        expect(router.primaryForLang('python')?.manifest.name).toBe('ok');
        expect(() => router.setPrimary('python', 'missing')).toThrow(/binary_not_found/);
        expect(router.primaryForLang('python')?.manifest.name).toBe('ok');
        // listLanguages also reports the same primary after the failed attempt.
        const rows = router.listLanguages();
        const primaryRows = rows.filter((r) => r.primary);
        expect(primaryRows).toHaveLength(1);
        expect(primaryRows[0]).toMatchObject({ manifest: 'ok' });
    });

    it('post-swap state is visible to all readers (primaryForLang, listLanguages, candidatesForLang)', () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'a' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'b' });
        const router = new Router(entriesFrom([a, b]));

        const candidatesBefore = router
            .candidatesForLang('python')
            .map((c) => c.manifest.name);

        router.setPrimary('python', 'b');

        expect(router.primaryForLang('python')?.manifest.name).toBe('b');
        const rows = router.listLanguages();
        expect(rows.find((r) => r.manifest === 'b')?.primary).toBe(true);
        expect(rows.find((r) => r.manifest === 'a')?.primary).toBe(false);
        // Candidate order unchanged — only primary string flipped.
        const candidatesAfter = router
            .candidatesForLang('python')
            .map((c) => c.manifest.name);
        expect(candidatesAfter).toEqual(candidatesBefore);
    });

    it('setPrimary does NOT spawn LSP processes (no mock LspServer methods invoked)', () => {
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'a' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'b' });
        const router = new Router(entriesFrom([a, b]));

        // Clear any counts from construction.
        jest.clearAllMocks();

        router.setPrimary('python', 'b');

        // Spawn-safety: every server method must be untouched.
        for (const server of [a, b]) {
            expect(server.ensureRunning).not.toHaveBeenCalled();
            expect(server.request).not.toHaveBeenCalled();
            expect(server.openDocument).not.toHaveBeenCalled();
            expect(server.workspaceSymbol).not.toHaveBeenCalled();
            expect(server.shutdown).not.toHaveBeenCalled();
            expect(server.forceKill).not.toHaveBeenCalled();
        }
    });

    it('cross-slot isolation: setPrimary on one lang leaves sibling slots of a multi-langId manifest unchanged', () => {
        // Manifest `ts-like` declares two langIds; manifest `ts-alt` declares only one.
        // After swapping primary on `typescript`, the `javascript` slot must stay on `ts-like`.
        const tsLike = makeMockServer(['typescript', 'javascript'], ['**/*.ts', '**/*.js'], {
            name: 'ts-like',
        });
        const tsAlt = makeMockServer(['typescript'], ['**/*.ts'], { name: 'ts-alt' });
        const router = new Router(entriesFrom([tsLike, tsAlt]));

        expect(router.primaryForLang('typescript')?.manifest.name).toBe('ts-like');
        expect(router.primaryForLang('javascript')?.manifest.name).toBe('ts-like');

        router.setPrimary('typescript', 'ts-alt');

        expect(router.primaryForLang('typescript')?.manifest.name).toBe('ts-alt');
        // javascript primary MUST remain ts-like — this is the regression lock.
        expect(router.primaryForLang('javascript')?.manifest.name).toBe('ts-like');

        const rows = router.listLanguages();
        const jsRow = rows.find((r) => r.lang === 'javascript' && r.primary);
        expect(jsRow?.manifest).toBe('ts-like');
    });

    it('empty-string lang and empty-string manifest route through Unknown manifest error', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        // Empty manifest name — unknown manifest fires first per validation order.
        expect(() => router.setPrimary('python', '')).toThrow(/Unknown manifest:/);
        // Empty lang with valid manifest — step 2 unknown lang fires.
        expect(() => router.setPrimary('', 'pyright')).toThrow(/Unknown lang:/);
        // Both empty — unknown manifest still fires first.
        expect(() => router.setPrimary('', '')).toThrow(/Unknown manifest:/);
        // Primary unchanged after all three failures.
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });

    it('Router.setPrimary is synchronous — result has no .then and fields are strings', () => {
        // Regression lock against a future async refactor. The MCP handler is async
        // but does NOT await router.setPrimary(); if setPrimary returned a Promise,
        // jsonResult would serialize {} (empty object) and break the tool response.
        const a = makeMockServer(['python'], ['**/*.py'], { name: 'a' });
        const b = makeMockServer(['python'], ['**/*.py'], { name: 'b' });
        const router = new Router(entriesFrom([a, b]));

        const result = router.setPrimary('python', 'b');

        expect(result).not.toHaveProperty('then');
        expect(typeof result.lang).toBe('string');
        expect(typeof result.primary).toBe('string');
        expect(typeof result.previous).toBe('string');
    });

    it('dense: 20 candidates for one lang, sequential swap through every candidate', () => {
        const servers = Array.from({ length: 20 }, (_, i) =>
            makeMockServer(['python'], ['**/*.py'], { name: `candidate-${i}` })
        );
        const router = new Router(entriesFrom(servers));

        // First-registered wins initially.
        expect(router.primaryForLang('python')?.manifest.name).toBe('candidate-0');

        // Walk the candidate list and promote each in turn.
        let expectedPrevious = 'candidate-0';
        for (let i = 1; i < 20; i++) {
            const target = `candidate-${i}`;
            const res = router.setPrimary('python', target);
            expect(res).toEqual({
                lang: 'python',
                primary: target,
                previous: expectedPrevious,
            });
            expect(router.primaryForLang('python')?.manifest.name).toBe(target);
            expectedPrevious = target;
        }

        // Final state is the last-promoted candidate. Candidate ORDER preserved.
        const candidates = router.candidatesForLang('python').map((c) => c.manifest.name);
        expect(candidates).toEqual(
            Array.from({ length: 20 }, (_, i) => `candidate-${i}`)
        );
    });

    it('two Router instances built from equivalent entries do not share mutable state', () => {
        // "Second run" variant: if _langMap slots were accidentally shared between
        // Router instances (e.g. via a module-level cache or frozen-then-mutated
        // source), a swap on one router would leak into another.
        const makeRouter = () => {
            const a = makeMockServer(['python'], ['**/*.py'], { name: 'a' });
            const b = makeMockServer(['python'], ['**/*.py'], { name: 'b' });
            return new Router(entriesFrom([a, b]));
        };
        const r1 = makeRouter();
        const r2 = makeRouter();

        r1.setPrimary('python', 'b');

        expect(r1.primaryForLang('python')?.manifest.name).toBe('b');
        // r2 must be untouched.
        expect(r2.primaryForLang('python')?.manifest.name).toBe('a');
    });

    it('is case-sensitive on both lang and manifest args', () => {
        const pyright = makeMockServer(['python'], ['**/*.py'], { name: 'pyright' });
        const router = new Router(entriesFrom([pyright]));

        // Upper-case lang — Map.get is strict; routes through Unknown lang.
        expect(() => router.setPrimary('PYTHON', 'pyright')).toThrow(
            /Unknown lang: PYTHON/
        );
        // Upper-case manifest — routes through Unknown manifest.
        expect(() => router.setPrimary('python', 'Pyright')).toThrow(
            /Unknown manifest: Pyright/
        );
        // State unchanged after both failures.
        expect(router.primaryForLang('python')?.manifest.name).toBe('pyright');
    });
});
