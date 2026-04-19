import path from 'path';
import {
    chmodSync,
    mkdirSync,
    mkdtempSync,
    rmSync,
    utimesSync,
    writeFileSync,
} from 'fs';
import { tmpdir } from 'os';
import {
    discoverBuiltinManifests,
    discoverConfigFileManifests,
    discoverManifests,
    discoverManifestsDir,
    discoverPluginTreeManifests,
    mergeDiscoveryPipeline,
    resolveManifestsDirEnv,
    resolvePluginTreeEnv,
    type DiscoveredManifest,
} from '../discover';
import type { PluginManifest } from '../types';

const CANONICAL = [
    'bash-language-server',
    'bazel-lsp',
    'clangd',
    'elixir-ls',
    'gopls',
    'lua-language-server',
    'pyright',
    'rust-analyzer',
    'starpls',
    'svelte-language-server',
    'typescript-language-server',
    'zls',
];

describe('discoverBuiltinManifests', () => {
    it('loads the 12 manifests lspm-177 shipped, each tagged sourceKind:"builtin", in alphabetical order by name', () => {
        const discovered = discoverBuiltinManifests();

        expect(discovered).toHaveLength(12);
        for (const d of discovered) {
            expect(d.sourceKind).toBe('builtin');
            expect(d.sourcePath).toMatch(/manifests[\\/][a-z0-9-]+\.json$/);
        }
        const names = discovered.map((d) => d.manifest.name);
        expect(names).toEqual(CANONICAL);
    });
});

describe('resolveManifestsDirEnv', () => {
    it('returns undefined for undefined input', () => {
        expect(resolveManifestsDirEnv(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string (guards against path.resolve("") = cwd)', () => {
        expect(resolveManifestsDirEnv('')).toBeUndefined();
    });

    it('returns an absolute path unchanged', () => {
        const abs = path.resolve('/tmp/lsp-mcp-r8b-abs');
        expect(resolveManifestsDirEnv(abs)).toBe(abs);
    });

    it('resolves a relative path against cwd', () => {
        expect(resolveManifestsDirEnv('my-dir')).toBe(path.resolve(process.cwd(), 'my-dir'));
    });
});

describe('resolvePluginTreeEnv', () => {
    it('returns undefined for undefined input', () => {
        expect(resolvePluginTreeEnv(undefined)).toBeUndefined();
    });

    it('returns undefined for empty string (guards against path.resolve("", "../../..") = cwd grandparent)', () => {
        expect(resolvePluginTreeEnv('')).toBeUndefined();
    });

    it('walks an absolute plugin-root path up 3 levels to the cache root', () => {
        const abs = path.resolve('/foo/cache/mkt/plug/ver');
        expect(resolvePluginTreeEnv(abs)).toBe(path.resolve('/foo/cache'));
    });

    it('resolves a relative path against cwd, then walks 3 levels up', () => {
        expect(resolvePluginTreeEnv('mkt/plug/ver')).toBe(
            path.resolve(process.cwd(), 'mkt/plug/ver', '../../..')
        );
    });
});

describe('discoverManifestsDir', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('returns [] and writes a stderr notice when the dir is absent', () => {
        const missing = `/nonexistent-lsp-mcp-r8b-${Date.now()}`;

        const result = discoverManifestsDir(missing);

        expect(result).toEqual([]);
        const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toMatch(/manifests-dir.*(skipping|missing)/i);
        expect(written).toContain(missing);
    });

    it('loads manifests from a valid dir, tags sourceKind:"manifests-dir", sorts alphabetically', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-manifests-dir-'));
        try {
            writeFileSync(
                path.join(dir, 'beta.json'),
                JSON.stringify(mkManifest('beta'))
            );
            writeFileSync(
                path.join(dir, 'alpha.json'),
                JSON.stringify(mkManifest('alpha'))
            );

            const result = discoverManifestsDir(dir);

            expect(result).toHaveLength(2);
            expect(result.map((d) => d.manifest.name)).toEqual(['alpha', 'beta']);
            for (const d of result) {
                expect(d.sourceKind).toBe('manifests-dir');
                expect(d.sourcePath).toMatch(/\.json$/);
                expect(d.sourcePath).toContain(dir);
            }
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

describe('discoverConfigFileManifests', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('returns an empty array and writes a stderr notice when the config file does not exist', () => {
        const missing = path.join(tmpdir(), `lsp-mcp-missing-${Date.now()}.json`);

        const result = discoverConfigFileManifests(missing);

        expect(result).toEqual([]);
        const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toContain('no config file');
        expect(written).toContain(missing);
    });

    it('returns discovered entries tagged sourceKind:"config-file" with sourcePath set to configPath when the file is valid', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-cfg-'));
        const cfg = path.join(dir, 'config.json');
        const manifest = {
            name: 'stub',
            version: '0.1.0',
            langIds: ['python'],
            fileGlobs: ['**/*.py'],
            workspaceMarkers: [],
            server: { cmd: ['node', 'stub-lsp.js'] },
            capabilities: { workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 } },
        };
        writeFileSync(cfg, JSON.stringify([manifest]));

        try {
            const result = discoverConfigFileManifests(cfg);
            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('stub');
            expect(result[0].sourceKind).toBe('config-file');
            expect(result[0].sourcePath).toBe(cfg);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

function writeConfigFixture(manifests: unknown[]): { dir: string; cfg: string } {
    const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-discover-'));
    const cfg = path.join(dir, 'config.json');
    writeFileSync(cfg, JSON.stringify(manifests));
    return { dir, cfg };
}

describe('discoverManifests', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('returns exactly the 12 builtins (all sourceKind:"builtin") when config-file is absent', () => {
        const missing = path.join(tmpdir(), `lsp-mcp-absent-${Date.now()}.json`);

        const result = discoverManifests({ configPath: missing });

        expect(result).toHaveLength(12);
        expect(result.every((d) => d.sourceKind === 'builtin')).toBe(true);
    });

    it('preserves unique config-file entries alongside builtins, emits no override log for non-colliding names', () => {
        const { dir, cfg } = writeConfigFixture([
            {
                name: 'my-custom-lsp',
                version: '0.1.0',
                langIds: ['custom'],
                fileGlobs: ['**/*.custom'],
                workspaceMarkers: [],
                server: { cmd: ['my-lsp'] },
            },
        ]);

        try {
            const result = discoverManifests({ configPath: cfg });

            expect(result).toHaveLength(13);
            const custom = result.find((d) => d.manifest.name === 'my-custom-lsp');
            expect(custom?.sourceKind).toBe('config-file');
            const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(allStderr).not.toMatch(/overrides prior/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('overrides a builtin with a config-file entry of the same name and logs a stderr notice', () => {
        const { dir, cfg } = writeConfigFixture([
            {
                name: 'pyright',
                version: '99.99.99',
                langIds: ['python'],
                fileGlobs: ['**/*.py'],
                workspaceMarkers: [],
                server: { cmd: ['my-forked-pyright'] },
            },
        ]);

        try {
            const result = discoverManifests({ configPath: cfg });

            const pyright = result.find((d) => d.manifest.name === 'pyright');
            expect(pyright?.sourceKind).toBe('config-file');
            expect(pyright?.manifest.version).toBe('99.99.99');

            const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(allStderr).toMatch(/"pyright" from config-file .* overrides prior builtin/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('preserves the builtin registration slot when a config-file overrides a colliding name (primary-stability invariant)', () => {
        // bazel-lsp is index 1 in alphabetical built-in order; starpls is index 8.
        // When config-file overrides bazel-lsp, the merged output MUST keep bazel-lsp
        // at its original slot (before starpls) so Router's first-registered-wins
        // primary selection returns bazel-lsp for "starlark".
        const { dir, cfg } = writeConfigFixture([
            {
                name: 'bazel-lsp',
                version: '99.99.99',
                langIds: ['starlark'],
                fileGlobs: ['**/BUILD', '**/BUILD.bazel', '**/*.bzl'],
                workspaceMarkers: ['WORKSPACE', 'MODULE.bazel'],
                server: { cmd: ['my-forked-bazel-lsp'] },
            },
        ]);

        try {
            const result = discoverManifests({ configPath: cfg });

            const bazelIdx = result.findIndex((d) => d.manifest.name === 'bazel-lsp');
            const starplsIdx = result.findIndex((d) => d.manifest.name === 'starpls');
            expect(bazelIdx).toBeGreaterThanOrEqual(0);
            expect(starplsIdx).toBeGreaterThanOrEqual(0);
            expect(bazelIdx).toBeLessThan(starplsIdx);
            // The bazel-lsp in the merged result is the overridden (config-file) one.
            expect(result[bazelIdx].sourceKind).toBe('config-file');
            expect(result[bazelIdx].manifest.server.cmd[0]).toBe('my-forked-bazel-lsp');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('three-way merge: builtin < config-file < manifests-dir, with chained override logs and slot preservation', () => {
        const { dir: cfgDir, cfg } = writeConfigFixture([
            {
                name: 'pyright',
                version: '88.88.88',
                langIds: ['python'],
                fileGlobs: ['**/*.py'],
                workspaceMarkers: [],
                server: { cmd: ['config-pyright'] },
            },
        ]);
        const mDir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-3way-'));
        try {
            writeFileSync(
                path.join(mDir, 'pyright.json'),
                JSON.stringify({
                    name: 'pyright',
                    version: '99.99.99',
                    langIds: ['python'],
                    fileGlobs: ['**/*.py'],
                    workspaceMarkers: [],
                    server: { cmd: ['dir-pyright'] },
                })
            );
            writeFileSync(
                path.join(mDir, 'bazel-lsp.json'),
                JSON.stringify({
                    name: 'bazel-lsp',
                    version: '99.99.99',
                    langIds: ['starlark'],
                    fileGlobs: ['**/BUILD', '**/*.bzl'],
                    workspaceMarkers: ['WORKSPACE'],
                    server: { cmd: ['dir-bazel'] },
                })
            );

            const result = discoverManifests({ configPath: cfg, manifestsDir: mDir });

            const pyright = result.find((d) => d.manifest.name === 'pyright');
            expect(pyright?.sourceKind).toBe('manifests-dir');
            expect(pyright?.manifest.server.cmd[0]).toBe('dir-pyright');

            const bazel = result.find((d) => d.manifest.name === 'bazel-lsp');
            expect(bazel?.sourceKind).toBe('manifests-dir');
            expect(bazel?.manifest.server.cmd[0]).toBe('dir-bazel');

            const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(allStderr).toMatch(/"pyright" from config-file .* overrides prior builtin/);
            expect(allStderr).toMatch(/"pyright" from manifests-dir .* overrides prior config-file/);
            expect(allStderr).toMatch(/"bazel-lsp" from manifests-dir .* overrides prior builtin/);

            // Slot preservation: bazel-lsp keeps its builtin slot (before starpls)
            // even after chained override through manifests-dir.
            const bazelIdx = result.findIndex((d) => d.manifest.name === 'bazel-lsp');
            const starplsIdx = result.findIndex((d) => d.manifest.name === 'starpls');
            expect(bazelIdx).toBeGreaterThanOrEqual(0);
            expect(starplsIdx).toBeGreaterThanOrEqual(0);
            expect(bazelIdx).toBeLessThan(starplsIdx);
        } finally {
            rmSync(cfgDir, { recursive: true, force: true });
            rmSync(mDir, { recursive: true, force: true });
        }
    });

    it('four-way merge: builtin < plugin-tree < config-file < manifests-dir, with full chained override log and slot preservation', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-4way-tree-'));
        const { dir: cfgDir, cfg } = writeConfigFixture([
            {
                name: 'pyright',
                version: '88.88.88',
                langIds: ['python'],
                fileGlobs: ['**/*.py'],
                workspaceMarkers: [],
                server: { cmd: ['config-pyright'] },
            },
        ]);
        const mDir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-4way-dir-'));
        try {
            // Plugin-tree fixture — CC-shaped layout.
            const treeVersion = path.join(cacheRoot, 'mkt', 'fork', '1.0.0');
            mkdirSync(treeVersion, { recursive: true });
            writeFileSync(
                path.join(treeVersion, 'lsp-manifest.json'),
                JSON.stringify({
                    name: 'pyright',
                    version: '77.77.77',
                    langIds: ['python'],
                    fileGlobs: ['**/*.py'],
                    workspaceMarkers: [],
                    server: { cmd: ['tree-pyright'] },
                })
            );

            writeFileSync(
                path.join(mDir, 'pyright.json'),
                JSON.stringify({
                    name: 'pyright',
                    version: '99.99.99',
                    langIds: ['python'],
                    fileGlobs: ['**/*.py'],
                    workspaceMarkers: [],
                    server: { cmd: ['dir-pyright'] },
                })
            );
            writeFileSync(
                path.join(mDir, 'bazel-lsp.json'),
                JSON.stringify({
                    name: 'bazel-lsp',
                    version: '99.99.99',
                    langIds: ['starlark'],
                    fileGlobs: ['**/BUILD', '**/*.bzl'],
                    workspaceMarkers: ['WORKSPACE'],
                    server: { cmd: ['dir-bazel'] },
                })
            );

            const result = discoverManifests({
                configPath: cfg,
                pluginTreeRoot: cacheRoot,
                manifestsDir: mDir,
            });

            const pyright = result.find((d) => d.manifest.name === 'pyright');
            expect(pyright?.sourceKind).toBe('manifests-dir');
            expect(pyright?.manifest.server.cmd[0]).toBe('dir-pyright');

            const allStderr = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(allStderr).toMatch(/"pyright" from plugin-tree .* overrides prior builtin/);
            expect(allStderr).toMatch(/"pyright" from config-file .* overrides prior plugin-tree/);
            expect(allStderr).toMatch(/"pyright" from manifests-dir .* overrides prior config-file/);

            // Slot preservation survives the 4-batch chain.
            const bazelIdx = result.findIndex((d) => d.manifest.name === 'bazel-lsp');
            const starplsIdx = result.findIndex((d) => d.manifest.name === 'starpls');
            expect(bazelIdx).toBeGreaterThanOrEqual(0);
            expect(starplsIdx).toBeGreaterThanOrEqual(0);
            expect(bazelIdx).toBeLessThan(starplsIdx);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
            rmSync(cfgDir, { recursive: true, force: true });
            rmSync(mDir, { recursive: true, force: true });
        }
    });
});

// ---- Adversarial battery (lspm-h1n Step 7) ---------------------------------

function mkManifest(name: string, langIds: string[] = ['python']): PluginManifest {
    return {
        name,
        version: '0.1.0',
        langIds,
        fileGlobs: ['**/*.py'],
        workspaceMarkers: [],
        server: { cmd: ['stub'] },
        capabilities: {},
    };
}

function mkDiscovered(
    name: string,
    sourceKind: DiscoveredManifest['sourceKind'],
    sourcePath: string
): DiscoveredManifest {
    return {
        manifest: mkManifest(name),
        sourceKind,
        sourcePath,
    };
}

describe('mergeDiscoveryPipeline — adversarial', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('empty: zero sources returns empty array, no stderr', () => {
        const result = mergeDiscoveryPipeline([]);
        expect(result).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('empty: multiple empty batches returns empty array, no stderr', () => {
        const result = mergeDiscoveryPipeline([[], [], []]);
        expect(result).toEqual([]);
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('singular: one batch with one entry returns that entry unchanged', () => {
        const entry = mkDiscovered('solo', 'builtin', '/m/solo.json');
        const result = mergeDiscoveryPipeline([[entry]]);
        expect(result).toEqual([entry]);
        expect(stderrSpy).not.toHaveBeenCalled();
    });

    it('self-referential: identical entry appearing twice in the same batch collapses with override log', () => {
        const first = mkDiscovered('twin', 'config-file', '/a.json');
        const second = mkDiscovered('twin', 'config-file', '/b.json');
        const result = mergeDiscoveryPipeline([[first, second]]);

        expect(result).toHaveLength(1);
        expect(result[0].sourcePath).toBe('/b.json');

        const log = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(log).toMatch(/"twin" from config-file \(\/b\.json\) overrides prior config-file \(\/a\.json\)/);
    });

    it('disconnected: multiple batches with no name overlap returns union with no override log', () => {
        const a = mkDiscovered('alpha', 'builtin', '/a.json');
        const b = mkDiscovered('beta', 'builtin', '/b.json');
        const c = mkDiscovered('gamma', 'config-file', '/c.json');

        const result = mergeDiscoveryPipeline([[a, b], [c]]);

        expect(result).toHaveLength(3);
        expect(result.map((d) => d.manifest.name)).toEqual(['alpha', 'beta', 'gamma']);

        const log = stderrSpy.mock.calls.map((x) => String(x[0])).join('');
        expect(log).not.toMatch(/overrides prior/);
    });

    it('state transition: override preserves original slot index across collision', () => {
        // Slot invariant: later-wins on name, but the slot (insertion order) is
        // the one set by the FIRST occurrence. Router's first-registered-wins
        // primary selection depends on this.
        const a = mkDiscovered('first', 'builtin', '/a.json');
        const b = mkDiscovered('second', 'builtin', '/b.json');
        const c = mkDiscovered('third', 'builtin', '/c.json');

        const override = mkDiscovered('second', 'config-file', '/override.json');

        const result = mergeDiscoveryPipeline([[a, b, c], [override]]);

        expect(result.map((d) => d.manifest.name)).toEqual(['first', 'second', 'third']);
        expect(result[1].sourceKind).toBe('config-file');
        expect(result[1].sourcePath).toBe('/override.json');
    });
});

describe('discoverConfigFileManifests — adversarial', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('empty: config file with empty JSON array returns empty array, no stderr', () => {
        const { dir, cfg } = writeConfigFixture([]);
        try {
            const result = discoverConfigFileManifests(cfg);
            expect(result).toEqual([]);
            expect(stderrSpy).not.toHaveBeenCalled();
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('singular: config file with a single valid manifest returns one entry', () => {
        const { dir, cfg } = writeConfigFixture([mkManifest('only')]);
        try {
            const result = discoverConfigFileManifests(cfg);
            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('only');
            expect(result[0].sourceKind).toBe('config-file');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('second-run: running twice against the same file returns equivalent results', () => {
        const { dir, cfg } = writeConfigFixture([mkManifest('idempotent')]);
        try {
            const run1 = discoverConfigFileManifests(cfg);
            const run2 = discoverConfigFileManifests(cfg);
            expect(run2).toEqual(run1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});

// ---- discoverManifestsDir adversarial battery (lspm-kgj Step 7) ------------

describe('discoverManifestsDir — adversarial', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('empty: dir exists with zero .json files returns []', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-empty-'));
        try {
            const result = discoverManifestsDir(dir);
            expect(result).toEqual([]);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('type boundary: path points at a file, not a directory → soft-skip with "not a directory" stderr', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-filepath-'));
        const filePath = path.join(dir, 'just-a-file.json');
        try {
            writeFileSync(filePath, JSON.stringify(mkManifest('trap')));

            const result = discoverManifestsDir(filePath);

            expect(result).toEqual([]);
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/not a directory/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('semantically hostile: non-.json file sibling is filtered out', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-mixed-'));
        try {
            writeFileSync(path.join(dir, 'valid.json'), JSON.stringify(mkManifest('valid')));
            writeFileSync(path.join(dir, 'notes.txt'), 'ignore me');
            writeFileSync(path.join(dir, 'README'), 'ignore me too');

            const result = discoverManifestsDir(dir);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('valid');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('semantically hostile: subdir with .json extension is filtered out (isFile guard)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-subdir-'));
        try {
            mkdirSync(path.join(dir, 'subdir.json'));
            writeFileSync(path.join(dir, 'real.json'), JSON.stringify(mkManifest('real')));

            const result = discoverManifestsDir(dir);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('real');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('semantically hostile: invalid JSON content is soft-skipped with stderr notice', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-badjson-'));
        try {
            writeFileSync(path.join(dir, 'broken.json'), '{ not valid json');
            writeFileSync(path.join(dir, 'good.json'), JSON.stringify(mkManifest('good')));

            const result = discoverManifestsDir(dir);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('good');
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/failed to parse.*broken\.json/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('semantically hostile: JSON that fails schema validation is soft-skipped', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-badschema-'));
        try {
            // Missing required fields (name, server, etc.)
            writeFileSync(path.join(dir, 'bad.json'), JSON.stringify({ version: '0.1.0' }));
            writeFileSync(path.join(dir, 'good.json'), JSON.stringify(mkManifest('good')));

            const result = discoverManifestsDir(dir);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('good');
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/failed schema validation/);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('second-run: calling twice with the same dir returns equivalent results (idempotent)', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-idem-'));
        try {
            writeFileSync(path.join(dir, 'one.json'), JSON.stringify(mkManifest('one')));
            writeFileSync(path.join(dir, 'two.json'), JSON.stringify(mkManifest('two')));

            const run1 = discoverManifestsDir(dir);
            const run2 = discoverManifestsDir(dir);

            expect(run2).toEqual(run1);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('self-referential: discoverManifests with manifestsDir pointing at the builtin dir yields 12 manifests-dir entries + 12 override logs', () => {
        const builtinDir = path.resolve(__dirname, '../../manifests');
        const { dir: cfgDir, cfg } = writeConfigFixture([]);

        try {
            const result = discoverManifests({ configPath: cfg, manifestsDir: builtinDir });

            expect(result).toHaveLength(12);
            expect(result.every((d) => d.sourceKind === 'manifests-dir')).toBe(true);

            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            const overrides = written.match(/from manifests-dir .* overrides prior builtin/g) ?? [];
            expect(overrides.length).toBe(12);
        } finally {
            rmSync(cfgDir, { recursive: true, force: true });
        }
    });
});

describe('discoverPluginTreeManifests', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('returns [] and writes a stderr notice when the cache root is absent', () => {
        const missing = `/nonexistent-lsp-mcp-r8c-${Date.now()}`;

        const result = discoverPluginTreeManifests(missing);

        expect(result).toEqual([]);
        const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(written).toMatch(/plugin-tree.*(skipping|missing)/i);
    });

    it('walks <cache>/<mkt>/<plug>/<ver>/ layout, picks newest version per plugin, finds lsp-manifest.json at any depth', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-walker-'));
        try {
            // plug-a: two semver versions — v2 must win over v1.
            const pluginAv1 = path.join(cacheRoot, 'mkt-a', 'plug-a', '1.0.0');
            const pluginAv2 = path.join(cacheRoot, 'mkt-a', 'plug-a', '2.0.0');
            mkdirSync(pluginAv1, { recursive: true });
            mkdirSync(pluginAv2, { recursive: true });
            const v1Manifest = { ...mkManifest('plug-a-v1'), server: { cmd: ['v1'] } };
            const v2Manifest = { ...mkManifest('plug-a-v2'), server: { cmd: ['v2'] } };
            writeFileSync(path.join(pluginAv1, 'lsp-manifest.json'), JSON.stringify(v1Manifest));
            writeFileSync(path.join(pluginAv2, 'lsp-manifest.json'), JSON.stringify(v2Manifest));

            // plug-b: hash version only.
            const pluginB = path.join(cacheRoot, 'mkt-a', 'plug-b', 'abc123hash');
            mkdirSync(pluginB, { recursive: true });
            writeFileSync(
                path.join(pluginB, 'lsp-manifest.json'),
                JSON.stringify(mkManifest('plug-b-hash'))
            );

            // plug-c: manifest nested several dirs deep + decoy wrong-name file.
            const pluginC = path.join(cacheRoot, 'mkt-b', 'plug-c', '0.1.0');
            mkdirSync(path.join(pluginC, 'nested', 'deep'), { recursive: true });
            writeFileSync(
                path.join(pluginC, 'nested', 'deep', 'lsp-manifest.json'),
                JSON.stringify(mkManifest('plug-c-deep'))
            );
            writeFileSync(
                path.join(pluginC, 'other.json'),
                JSON.stringify(mkManifest('decoy'))
            );

            const result = discoverPluginTreeManifests(cacheRoot);
            const names = result.map((d) => d.manifest.name);

            expect(result).toHaveLength(3);
            expect(names).toEqual(expect.arrayContaining(['plug-a-v2', 'plug-b-hash', 'plug-c-deep']));
            expect(names).not.toContain('plug-a-v1');
            expect(names).not.toContain('decoy');

            const plugA = result.find((d) => d.manifest.name === 'plug-a-v2');
            expect(plugA?.manifest.server.cmd).toEqual(['v2']);

            for (const d of result) {
                expect(d.sourceKind).toBe('plugin-tree');
                expect(d.sourcePath).toMatch(/lsp-manifest\.json$/);
            }

            const sorted = [...result].sort((a, b) =>
                (a.sourcePath ?? '').localeCompare(b.sourcePath ?? '')
            );
            expect(result).toEqual(sorted);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });
});

describe('discoverPluginTreeManifests — adversarial (lspm-mcp Step 11)', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    function writeTreeManifest(fullPath: string, name: string, cmdArg?: string): void {
        mkdirSync(path.dirname(fullPath), { recursive: true });
        const body = cmdArg
            ? { ...mkManifest(name), server: { cmd: [cmdArg] } }
            : mkManifest(name);
        writeFileSync(fullPath, JSON.stringify(body));
    }

    it('empty: cache root exists with zero marketplace subdirs → []', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-empty-'));
        try {
            expect(discoverPluginTreeManifests(cacheRoot)).toEqual([]);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('type boundary: cache root is a file, not a directory → stderr "not a directory" + []', () => {
        const dir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-file-'));
        const filePath = path.join(dir, 'not-a-dir');
        writeFileSync(filePath, '');
        try {
            const result = discoverPluginTreeManifests(filePath);
            expect(result).toEqual([]);
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/not a directory/i);
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });

    it('non-dir marketplace entry: stray file at layer 1 is skipped cleanly; other marketplaces still walked', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-stray-'));
        try {
            writeFileSync(path.join(cacheRoot, '.DS_Store'), 'noise');
            writeTreeManifest(
                path.join(cacheRoot, 'mkt-real', 'plug', '1.0.0', 'lsp-manifest.json'),
                'real-plug'
            );

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('real-plug');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('deep nesting: lsp-manifest.json at depth ≥5 inside the winning version dir is still found', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-deep-'));
        try {
            const manifestPath = path.join(
                cacheRoot,
                'mkt',
                'plug',
                '1.0.0',
                'a',
                'b',
                'c',
                'd',
                'e',
                'lsp-manifest.json'
            );
            writeTreeManifest(manifestPath, 'deep-plug');

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('deep-plug');
            expect(result[0].sourcePath).toBe(manifestPath);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('hostile: a subdir literally named "lsp-manifest.json" is filtered by the isFile guard', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-dir-name-'));
        try {
            const versionDir = path.join(cacheRoot, 'mkt', 'plug', '1.0.0');
            mkdirSync(path.join(versionDir, 'lsp-manifest.json'), { recursive: true });
            writeTreeManifest(
                path.join(versionDir, 'real', 'lsp-manifest.json'),
                'real-one'
            );

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('real-one');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('hostile: invalid JSON in one manifest is soft-skipped; sibling manifests unaffected', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-badjson-'));
        try {
            writeTreeManifest(
                path.join(cacheRoot, 'mkt-a', 'good', '1.0.0', 'lsp-manifest.json'),
                'good-plug'
            );
            const badDir = path.join(cacheRoot, 'mkt-b', 'bad', '1.0.0');
            mkdirSync(badDir, { recursive: true });
            writeFileSync(path.join(badDir, 'lsp-manifest.json'), '{not valid json');

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('good-plug');
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/failed to parse plugin-tree manifest/);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('hostile: non-matching filenames (plugin-manifest.json, lsp-manifest.txt) are filtered', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-wrongname-'));
        try {
            const versionDir = path.join(cacheRoot, 'mkt', 'plug', '1.0.0');
            mkdirSync(versionDir, { recursive: true });
            writeFileSync(
                path.join(versionDir, 'plugin-manifest.json'),
                JSON.stringify(mkManifest('wrong-1'))
            );
            writeFileSync(
                path.join(versionDir, 'lsp-manifest.txt'),
                JSON.stringify(mkManifest('wrong-2'))
            );

            expect(discoverPluginTreeManifests(cacheRoot)).toEqual([]);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('latest-version filter — mixed semver: picks highest numeric across major/minor/patch', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-semver-'));
        try {
            const plug = path.join(cacheRoot, 'mkt', 'plug');
            writeTreeManifest(path.join(plug, '0.9.9', 'lsp-manifest.json'), 'p', 'v099');
            writeTreeManifest(path.join(plug, '1.0.0', 'lsp-manifest.json'), 'p', 'v100');
            writeTreeManifest(path.join(plug, '1.0.1', 'lsp-manifest.json'), 'p', 'v101');

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.server.cmd[0]).toBe('v101');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('latest-version filter — mixed semver+hash: semver wins even when hash has newer mtime', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-semver-hash-'));
        try {
            const plug = path.join(cacheRoot, 'mkt', 'plug');
            const semverPath = path.join(plug, '1.0.0');
            const hashPath = path.join(plug, 'abc123hash');
            writeTreeManifest(path.join(semverPath, 'lsp-manifest.json'), 'p', 'semver-wins');
            writeTreeManifest(path.join(hashPath, 'lsp-manifest.json'), 'p', 'hash-loses');
            // Make hash dir strictly newer than semver dir.
            const future = new Date(Date.now() + 60_000);
            utimesSync(hashPath, future, future);

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.server.cmd[0]).toBe('semver-wins');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('latest-version filter — all hash: newer mtime wins', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-hash-mtime-'));
        try {
            const plug = path.join(cacheRoot, 'mkt', 'plug');
            const older = path.join(plug, 'aaaa-older');
            const newer = path.join(plug, 'bbbb-newer');
            writeTreeManifest(path.join(older, 'lsp-manifest.json'), 'p', 'older-cmd');
            writeTreeManifest(path.join(newer, 'lsp-manifest.json'), 'p', 'newer-cmd');
            const past = new Date(Date.now() - 60_000);
            utimesSync(older, past, past);

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.server.cmd[0]).toBe('newer-cmd');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('latest-version filter — mtime tie: alphabetically-first name wins (deterministic tie-break)', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-tie-'));
        try {
            const plug = path.join(cacheRoot, 'mkt', 'plug');
            const hashA = path.join(plug, 'aaaa-first');
            const hashB = path.join(plug, 'bbbb-second');
            writeTreeManifest(path.join(hashA, 'lsp-manifest.json'), 'p', 'first-cmd');
            writeTreeManifest(path.join(hashB, 'lsp-manifest.json'), 'p', 'second-cmd');
            // Pin identical mtimes on both version dirs.
            const t = new Date(Date.now() - 10_000);
            utimesSync(hashA, t, t);
            utimesSync(hashB, t, t);

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.server.cmd[0]).toBe('first-cmd');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('per-layer EACCES: one marketplace unreadable → stderr notice + other marketplaces still discovered', () => {
        if (process.platform === 'win32' || process.getuid?.() === 0) {
            // chmod-based EACCES test is POSIX and non-root only.
            return;
        }
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-eacces-'));
        const badMkt = path.join(cacheRoot, 'mkt-bad');
        try {
            mkdirSync(badMkt, { recursive: true });
            // Readable marketplace with a good plugin.
            writeTreeManifest(
                path.join(cacheRoot, 'mkt-good', 'plug', '1.0.0', 'lsp-manifest.json'),
                'good-plug'
            );
            // Lock down mkt-bad — readdirSync on it will EACCES.
            chmodSync(badMkt, 0o000);

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('good-plug');
            const written = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
            expect(written).toMatch(/plugin-tree: marketplace .* unreadable/);
        } finally {
            // Restore perms so rmSync can clean up.
            try {
                chmodSync(badMkt, 0o700);
            } catch {
                /* ignore */
            }
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('plugin dir with zero version subdirs → skipped cleanly, no crash, other plugins unaffected', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-zero-ver-'));
        try {
            // Empty plugin dir — no versions inside.
            mkdirSync(path.join(cacheRoot, 'mkt', 'empty-plug'), { recursive: true });
            // Good plugin alongside.
            writeTreeManifest(
                path.join(cacheRoot, 'mkt', 'good-plug', '1.0.0', 'lsp-manifest.json'),
                'good-plug'
            );

            const result = discoverPluginTreeManifests(cacheRoot);

            expect(result).toHaveLength(1);
            expect(result[0].manifest.name).toBe('good-plug');
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('second-run idempotency: two calls against the same cache root produce deep-equal results', () => {
        const cacheRoot = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-r8c-idem-'));
        try {
            writeTreeManifest(
                path.join(cacheRoot, 'mkt-a', 'plug-a', '1.0.0', 'lsp-manifest.json'),
                'a'
            );
            writeTreeManifest(
                path.join(cacheRoot, 'mkt-b', 'plug-b', 'abc', 'lsp-manifest.json'),
                'b'
            );

            const run1 = discoverPluginTreeManifests(cacheRoot);
            const run2 = discoverPluginTreeManifests(cacheRoot);

            expect(run2).toEqual(run1);
        } finally {
            rmSync(cacheRoot, { recursive: true, force: true });
        }
    });

    it('self-referential: cache root pointed at lsp-mcp repo does not pick up builtin `<name>.json` files', () => {
        // The repo's manifests/ dir holds <name>.json, not lsp-manifest.json.
        // Scanning it via plugin-tree must produce zero matches — distinct
        // filename conventions are the guard.
        const repoRoot = path.resolve(__dirname, '../..');
        const result = discoverPluginTreeManifests(repoRoot);
        expect(result.every((d) => d.sourcePath?.endsWith('lsp-manifest.json'))).toBe(true);
        // No manifest named after a builtin should slip in from the repo root.
        const builtinNames = discoverBuiltinManifests().map((d) => d.manifest.name);
        for (const d of result) {
            expect(builtinNames).not.toContain(d.manifest.name);
        }
    });
});
