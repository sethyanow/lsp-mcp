import path from 'path';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import {
    discoverBuiltinManifests,
    discoverConfigFileManifests,
    discoverManifests,
    discoverManifestsDir,
    mergeDiscoveryPipeline,
    resolveManifestsDirEnv,
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
