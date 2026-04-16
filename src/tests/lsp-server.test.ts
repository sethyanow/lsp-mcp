import { mkdtempSync, mkdirSync, writeFileSync, existsSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { LspServer, findRoot } from '../lsp-server';
import { normalizeSymbol, PluginManifestSchema } from '../types';
import type { PluginManifest } from '../types';

const STUB = path.resolve(__dirname, 'fixtures/stub-lsp.js');

function manifest(overrides: Partial<PluginManifest> = {}): PluginManifest {
    return PluginManifestSchema.parse({
        name: 'stub',
        version: '0.1.0',
        langIds: ['python'],
        fileGlobs: ['**/*.py'],
        workspaceMarkers: [],
        server: { cmd: ['node', STUB] },
        capabilities: { workspaceSymbol: { stringPrefilter: true, timeoutMs: 3000 } },
        ...overrides,
    });
}

function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
    const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-test-'));
    return Promise.resolve(fn(dir)).finally(() => {
        try {
            rmSync(dir, { recursive: true, force: true });
        } catch {
            /* ignore */
        }
    }) as Promise<T>;
}

describe('findRoot', () => {
    it('walks up to find a marker', async () => {
        await withTempDir((dir) => {
            const nested = path.join(dir, 'a', 'b', 'c');
            mkdirSync(nested, { recursive: true });
            writeFileSync(path.join(dir, 'pyproject.toml'), '');
            expect(findRoot(nested, ['pyproject.toml'])).toBe(path.resolve(dir));
        });
    });

    it('returns startDir when no marker is found', async () => {
        await withTempDir((dir) => {
            expect(findRoot(dir, ['nothing-here.toml'])).toBe(dir);
        });
    });

    it('returns startDir when markers is empty', async () => {
        await withTempDir((dir) => {
            expect(findRoot(dir, [])).toBe(dir);
        });
    });
});

describe('normalizeSymbol', () => {
    it('accepts SymbolInformation shape', () => {
        const raw = {
            name: 'foo',
            kind: 12,
            location: {
                uri: 'file:///a.py',
                range: {
                    start: { line: 1, character: 0 },
                    end: { line: 1, character: 3 },
                },
            },
        };
        expect(normalizeSymbol(raw)).toEqual({
            name: 'foo',
            kind: 12,
            location: raw.location,
        });
    });

    it('fills a zero range for WorkspaceSymbol without a range', () => {
        const raw = { name: 'foo', kind: 12, location: { uri: 'file:///a.py' } };
        const sym = normalizeSymbol(raw);
        expect(sym?.location.range).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        });
    });

    it('returns null for malformed entries', () => {
        expect(normalizeSymbol(null)).toBeNull();
        expect(normalizeSymbol({ name: 'x' })).toBeNull();
        expect(normalizeSymbol({ name: 'x', kind: 1 })).toBeNull();
        expect(normalizeSymbol({ name: 'x', kind: 1, location: {} })).toBeNull();
    });

    it('substitutes a zero-range when range is structurally invalid', () => {
        const raw = {
            name: 'x',
            kind: 5,
            location: { uri: 'file:///a.py', range: 'not-a-range' },
        };
        const sym = normalizeSymbol(raw);
        expect(sym?.location.range).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        });

        const partial = {
            name: 'x',
            kind: 5,
            location: {
                uri: 'file:///a.py',
                range: { start: { line: 1 }, end: { line: 1, character: 2 } },
            },
        };
        expect(normalizeSymbol(partial)?.location.range).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        });
    });
});

describe('LspServer lifecycle', () => {
    let server: LspServer;

    afterEach(async () => {
        if (server) await server.shutdown();
    });

    it('starts the child process and responds to workspaceSymbol', async () => {
        server = new LspServer(manifest(), process.cwd(), '/unused');
        const results = await server.workspaceSymbol('X');
        expect(results).toHaveLength(1);
        expect(results[0].name).toBe('X');
    });

    it('ensureRunning rejects on premature exit and clears state for retry', async () => {
        server = new LspServer(
            manifest({
                server: { cmd: ['node', STUB, '--init-exit=1'] },
            }),
            process.cwd(),
            '/unused',
        );
        await expect(server.ensureRunning()).rejects.toThrow(/exited before initialize/);

        // State must be cleared so a second call retries from scratch
        // (rather than returning the cached rejection).
        await expect(server.ensureRunning()).rejects.toThrow(/exited before initialize/);
    });

    it('openDocument dedups by uri', async () => {
        server = new LspServer(manifest(), process.cwd(), '/unused');
        const filePath = path.resolve(__dirname, 'fixtures/stub-lsp.js');
        const uri = pathToFileURL(filePath).toString();

        expect(await server.openDocument(uri, 'python')).toBe(true);
        expect(await server.openDocument(uri, 'python')).toBe(false);

        const opened = await server.request('_debug/openedCount', {});
        expect(opened).toBe(1);
    });

    it('shutdown clears _openedUris and _warm state', async () => {
        server = new LspServer(manifest(), process.cwd(), '/unused');
        const filePath = path.resolve(__dirname, 'fixtures/stub-lsp.js');
        const uri = pathToFileURL(filePath).toString();

        await server.workspaceSymbol('X'); // warms
        await server.openDocument(uri, 'python');
        await server.shutdown();

        // After shutdown, re-opening works (state cleared).
        expect(await server.openDocument(uri, 'python')).toBe(true);
        await server.shutdown();
    });
});

describe('LspServer cold-cache polling', () => {
    let server: LspServer;

    afterEach(async () => {
        if (server) await server.shutdown();
    });

    it('polls until the stub returns a non-empty result, then succeeds', async () => {
        server = new LspServer(
            manifest({
                server: { cmd: ['node', STUB, '--symbol-empty-for=3'] },
                capabilities: { workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 } },
            }),
            process.cwd(),
            '/unused',
        );
        const results = await server.workspaceSymbol('MyThing');
        expect(results.length).toBeGreaterThan(0);
        expect(results[0].name).toBe('MyThing');
    });

    it('normalizes WorkspaceSymbol shape (no range) without throwing', async () => {
        server = new LspServer(
            manifest({
                server: { cmd: ['node', STUB, '--symbol-shape=ws'] },
            }),
            process.cwd(),
            '/unused',
        );
        const results = await server.workspaceSymbol('X');
        expect(results).toHaveLength(1);
        expect(results[0].location.range).toEqual({
            start: { line: 0, character: 0 },
            end: { line: 0, character: 0 },
        });
    });
});

describe('LspServer buildHook', () => {
    it('runs the hook once before the first spawn and aborts on non-zero exit', async () => {
        await withTempDir(async (tmp) => {
            const pluginsDir = tmp;
            const pluginDir = path.join(pluginsDir, 'stub');
            mkdirSync(pluginDir);
            const marker = path.join(pluginDir, 'built');

            const good = new LspServer(
                manifest({
                    server: {
                        cmd: ['node', STUB],
                        buildHook: `touch "${marker}"`,
                    },
                }),
                process.cwd(),
                pluginsDir,
            );
            try {
                await good.ensureRunning();
                expect(existsSync(marker)).toBe(true);
            } finally {
                await good.shutdown();
            }

            const bad = new LspServer(
                manifest({
                    server: {
                        cmd: ['node', STUB],
                        buildHook: 'exit 17',
                    },
                }),
                process.cwd(),
                pluginsDir,
            );
            await expect(bad.ensureRunning()).rejects.toThrow(/exited with status 17/);
        });
    });
});

describe('LspServer ${pluginDir} expansion', () => {
    it('substitutes ${pluginDir} in cmd with the resolved plugin directory', async () => {
        await withTempDir(async (tmp) => {
            const pluginsDir = tmp;
            const pluginDir = path.join(pluginsDir, 'stub');
            mkdirSync(pluginDir);
            // Symlink the stub so Node's module resolution still walks up to
            // the real project's node_modules for vscode-jsonrpc.
            const { symlinkSync } = await import('fs');
            const stubLink = path.join(pluginDir, 'stub-lsp.js');
            symlinkSync(STUB, stubLink);

            const server = new LspServer(
                manifest({
                    server: { cmd: ['node', '${pluginDir}/stub-lsp.js'] },
                }),
                process.cwd(),
                pluginsDir,
            );
            try {
                const results = await server.workspaceSymbol('Q');
                expect(results[0].name).toBe('Q');
            } finally {
                await server.shutdown();
            }
        });
    });
});

describe('LspServer.ownsFile', () => {
    it('matches globs via minimatch', () => {
        const server = new LspServer(
            manifest({ fileGlobs: ['src/**/*.py', '**/*.pyi'] }),
            process.cwd(),
            '/unused',
        );
        expect(server.ownsFile('src/a/b/c.py')).toBe(true);
        expect(server.ownsFile('stub.pyi')).toBe(true);
        expect(server.ownsFile('other/x.py')).toBe(false);
    });

    it('does not match partial extensions or other file types', () => {
        const server = new LspServer(
            manifest({ fileGlobs: ['src/**/*.py', '**/*.pyi'] }),
            process.cwd(),
            '/unused',
        );
        expect(server.ownsFile('src/a/b/c.txt')).toBe(false);
        expect(server.ownsFile('src/a/b/c.pyx')).toBe(false);
        expect(server.ownsFile('src/a/b/python.js')).toBe(false);
    });
});
