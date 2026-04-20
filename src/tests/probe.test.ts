import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import * as path from 'path';

import type { DiscoveredManifest } from '../discover.js';
import type { PluginManifest } from '../types.js';
import {
    formatMissingBinarySummary,
    probeAll,
    probeBinaryOnPath,
    type ProbeStatus,
} from '../probe.js';

function stubManifest(name: string, cmd: string): PluginManifest {
    return {
        name,
        version: '0.1.0',
        langIds: ['lang'],
        fileGlobs: ['**/*'],
        workspaceMarkers: [],
        server: { cmd: [cmd] },
        capabilities: {},
    };
}

describe('probeBinaryOnPath — absolute paths', () => {
    it('returns binary_not_found for a nonexistent absolute path', () => {
        const ghost = `/nonexistent-lsp-mcp-probe-${Date.now()}-${Math.random()}`;
        const status: ProbeStatus = probeBinaryOnPath(ghost);
        expect(status).toBe('binary_not_found');
    });

    it('returns ok for an existing executable absolute path (process.execPath)', () => {
        // process.execPath is the Node binary currently running the test — guaranteed to exist
        // and be executable on every platform. Works on POSIX + Windows without guards.
        const status: ProbeStatus = probeBinaryOnPath(process.execPath);
        expect(status).toBe('ok');
    });
});

describe('probeBinaryOnPath — bare names via PATH walk', () => {
    let fixtureDir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
        fixtureDir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-probe-'));
        originalPath = process.env.PATH;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('returns ok when a bare name resolves against a directory prepended to PATH', () => {
        const fakeBin = path.join(fixtureDir, 'fake-lsp');
        writeFileSync(fakeBin, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
        process.env.PATH = fixtureDir + path.delimiter + (originalPath ?? '');

        expect(probeBinaryOnPath('fake-lsp')).toBe('ok');
    });

    it('returns binary_not_found when no PATH directory contains the bare name', () => {
        process.env.PATH = fixtureDir + path.delimiter + (originalPath ?? '');
        // fixtureDir is empty — nothing to find
        expect(probeBinaryOnPath(`nonexistent-${Date.now()}`)).toBe('binary_not_found');
    });

    it('returns binary_not_found when PATH is an empty string', () => {
        process.env.PATH = '';
        expect(probeBinaryOnPath('sh')).toBe('binary_not_found');
    });
});

describe('probeAll — batch probe of DiscoveredManifest[]', () => {
    it('returns [] for an empty input — adversarial empty case', () => {
        expect(probeAll([])).toEqual([]);
    });

    it('attaches status from probeBinaryOnPath(cmd[0]) to every entry, preserving other fields', () => {
        const discovered: DiscoveredManifest[] = [
            {
                manifest: stubManifest('existing-lsp', process.execPath),
                sourceKind: 'builtin',
                sourcePath: '/some/path',
            },
            {
                manifest: stubManifest('ghost-lsp', `/nonexistent-${Date.now()}`),
                sourceKind: 'config-file',
            },
        ];

        const probed = probeAll(discovered);

        expect(probed).toHaveLength(2);
        expect(probed[0].status).toBe('ok');
        expect(probed[0].manifest.name).toBe('existing-lsp');
        expect(probed[0].sourceKind).toBe('builtin');
        expect(probed[0].sourcePath).toBe('/some/path');
        expect(probed[1].status).toBe('binary_not_found');
        expect(probed[1].manifest.name).toBe('ghost-lsp');
        expect(probed[1].sourceKind).toBe('config-file');
    });
});

describe('probeBinaryOnPath — adversarial battery', () => {
    let fixtureDir: string;
    let originalPath: string | undefined;

    beforeEach(() => {
        fixtureDir = mkdtempSync(path.join(tmpdir(), 'lsp-mcp-probe-adv-'));
        originalPath = process.env.PATH;
    });

    afterEach(() => {
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
        rmSync(fixtureDir, { recursive: true, force: true });
    });

    it('empty string cmd short-circuits to binary_not_found via entry guard', () => {
        // Without the entry guard, '' would fall through to the bare-name branch
        // and path.join() each PATH dir with '', producing directory paths that
        // accessSync(X_OK) accepts on both POSIX (traversal bit) and Windows
        // (R_OK alias). The guard prevents that misdiagnosis.
        expect(probeBinaryOnPath('')).toBe('binary_not_found');
    });

    it('absolute path that is a directory returns binary_not_found (statSync.isFile gate)', () => {
        // POSIX: X_OK on a directory tests the traversal bit and returns true.
        // Windows: X_OK aliases R_OK. Only statSync.isFile() distinguishes.
        expect(probeBinaryOnPath(fixtureDir)).toBe('binary_not_found');
    });

    it('absolute path that is a non-executable file returns binary_not_found (POSIX only)', () => {
        if (process.platform === 'win32') return;
        const nonExec = path.join(fixtureDir, 'not-executable');
        writeFileSync(nonExec, 'data', { mode: 0o644 });
        expect(probeBinaryOnPath(nonExec)).toBe('binary_not_found');
    });

    it('relative path with an embedded separator routes through PATH-walk and misses', () => {
        // Documented behavior: relative paths aren't resolved against CWD or
        // workspace. They enter the bare-name branch and path.join() with each
        // PATH dir, producing paths that won't resolve. Locks in the design
        // so no one silently changes probe() to resolve relative paths.
        expect(probeBinaryOnPath('./nonexistent-relative-path')).toBe('binary_not_found');
    });

    it('bare-name PATH hit that is a directory returns binary_not_found (statSync.isFile gate in PATH branch)', () => {
        // Prepend fixtureDir to PATH and create a DIRECTORY named "fake-lsp"
        // inside it. A naive implementation without statSync.isFile() in the
        // PATH-walk branch would accept this (X_OK passes on dirs).
        mkdirSync(path.join(fixtureDir, 'fake-lsp'));
        process.env.PATH = fixtureDir + path.delimiter + (originalPath ?? '');
        expect(probeBinaryOnPath('fake-lsp')).toBe('binary_not_found');
    });

    it('PATH with a trailing delimiter (empty segment) does not crash', () => {
        // Empty PATH segments must be filtered out. Without the filter,
        // path.join('', 'sh') = 'sh' which then accessSync'd as a relative
        // path — spurious behavior. Lock in the filter.
        process.env.PATH = '/definitely/does/not/exist' + path.delimiter;
        expect(probeBinaryOnPath('cmd-that-does-not-exist')).toBe('binary_not_found');
    });

    it('is idempotent — second invocation on the same input returns the same result', () => {
        // probe is claimed pure. Lock it in: neither success nor failure path
        // should mutate state that changes a subsequent probe of the same input.
        const realBin = process.execPath;
        const ghost = `/nonexistent-${Date.now()}`;
        expect(probeBinaryOnPath(realBin)).toBe('ok');
        expect(probeBinaryOnPath(realBin)).toBe('ok');
        expect(probeBinaryOnPath(ghost)).toBe('binary_not_found');
        expect(probeBinaryOnPath(ghost)).toBe('binary_not_found');
    });
});

describe('formatMissingBinarySummary — observability stderr line', () => {
    function mkProbed(name: string, status: ProbeStatus): DiscoveredManifest & { status: ProbeStatus } {
        return {
            manifest: stubManifest(name, 'anything'),
            sourceKind: 'builtin',
            status,
        };
    }

    it('returns undefined when every entry has status ok', () => {
        const probed = [mkProbed('a', 'ok'), mkProbed('b', 'ok')];
        expect(formatMissingBinarySummary(probed)).toBeUndefined();
    });

    it('uses the singular form when exactly one manifest is binary_not_found', () => {
        const probed = [mkProbed('a', 'ok'), mkProbed('rust-analyzer', 'binary_not_found')];
        expect(formatMissingBinarySummary(probed)).toBe(
            '[lsp-mcp] 1 manifest has binary_not_found: rust-analyzer'
        );
    });

    it('uses the plural form and alphabetical order when multiple are binary_not_found', () => {
        // Deliberately register out of alphabetical order to catch sort bugs.
        const probed = [
            mkProbed('ok-one', 'ok'),
            mkProbed('rust-analyzer', 'binary_not_found'),
            mkProbed('clangd', 'binary_not_found'),
            mkProbed('typescript-language-server', 'binary_not_found'),
        ];
        expect(formatMissingBinarySummary(probed)).toBe(
            '[lsp-mcp] 3 manifests have binary_not_found: clangd, rust-analyzer, typescript-language-server'
        );
    });
});
