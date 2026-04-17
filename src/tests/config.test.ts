import path from 'path';
import { writeFileSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { resolveManifests } from '../config';

describe('resolveManifests', () => {
    let stderrSpy: jest.SpyInstance;

    beforeEach(() => {
        stderrSpy = jest.spyOn(process.stderr, 'write').mockImplementation(() => true);
    });

    afterEach(() => {
        stderrSpy.mockRestore();
    });

    it('returns an empty array and writes a stderr notice when the config file does not exist', () => {
        const missing = path.join(tmpdir(), `lsp-mcp-missing-${Date.now()}.json`);

        const result = resolveManifests(missing);

        expect(result).toEqual([]);
        const writtenArgs = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
        expect(writtenArgs).toContain('no config file');
        expect(writtenArgs).toContain(missing);
        expect(writtenArgs).toContain('zero manifests');
    });

    it('delegates to loadManifests and returns the parsed manifests when the config file exists', () => {
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
            const result = resolveManifests(cfg);
            expect(result).toHaveLength(1);
            expect(result[0].name).toBe('stub');
        } finally {
            rmSync(dir, { recursive: true, force: true });
        }
    });
});
