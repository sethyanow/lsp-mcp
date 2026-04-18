import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import path from 'path';
import { PluginManifestSchema } from '../types';

const MANIFESTS_DIR = path.resolve(__dirname, '../../manifests');

const CANONICAL = [
    'pyright',
    'typescript-language-server',
    'gopls',
    'rust-analyzer',
    'zls',
    'clangd',
    'lua-language-server',
    'elixir-ls',
    'svelte-language-server',
    'bash-language-server',
    'starpls',
    'bazel-lsp',
];

function listManifestFiles(): string[] {
    if (!existsSync(MANIFESTS_DIR)) return [];
    return readdirSync(MANIFESTS_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name);
}

describe('manifests/ library', () => {
    it('manifests/ directory exists at repo root', () => {
        expect(existsSync(MANIFESTS_DIR)).toBe(true);
        expect(statSync(MANIFESTS_DIR).isDirectory()).toBe(true);
    });

    it('every JSON file parses against PluginManifestSchema', () => {
        const files = listManifestFiles();
        expect(files.length).toBeGreaterThan(0);
        for (const name of files) {
            const full = path.join(MANIFESTS_DIR, name);
            let parsed: unknown;
            try {
                parsed = JSON.parse(readFileSync(full, 'utf-8'));
            } catch (err) {
                throw new Error(`${name}: invalid JSON — ${(err as Error).message}`);
            }
            const result = PluginManifestSchema.safeParse(parsed);
            if (!result.success) {
                const issues = result.error.issues
                    .map((i) => `${i.path.join('.') || '<root>'}: ${i.message}`)
                    .join('; ');
                throw new Error(`${name}: schema validation failed — ${issues}`);
            }
        }
    });

    it('all 12 canonical manifests are present', () => {
        const files = new Set(listManifestFiles());
        const missing = CANONICAL.filter((n) => !files.has(`${n}.json`));
        expect(missing).toEqual([]);
    });

    it('manifest filename matches its name field', () => {
        const files = listManifestFiles();
        expect(files.length).toBeGreaterThanOrEqual(CANONICAL.length);
        for (const name of files) {
            const full = path.join(MANIFESTS_DIR, name);
            const parsed = PluginManifestSchema.parse(JSON.parse(readFileSync(full, 'utf-8')));
            expect(`${parsed.name}.json`).toBe(name);
        }
    });

    it('every server.cmd[0] is a bare binary name (no path separator)', () => {
        const files = listManifestFiles();
        expect(files.length).toBeGreaterThanOrEqual(CANONICAL.length);
        const offenders: string[] = [];
        for (const name of files) {
            const full = path.join(MANIFESTS_DIR, name);
            const parsed = PluginManifestSchema.parse(JSON.parse(readFileSync(full, 'utf-8')));
            const exe = parsed.server.cmd[0];
            if (exe.includes('/') || exe.includes('\\')) {
                offenders.push(`${name}: cmd[0]="${exe}"`);
            }
        }
        expect(offenders).toEqual([]);
    });

    it('starpls and bazel-lsp share canonical langId "starlark"', () => {
        const starpls = PluginManifestSchema.parse(
            JSON.parse(readFileSync(path.join(MANIFESTS_DIR, 'starpls.json'), 'utf-8'))
        );
        const bazelLsp = PluginManifestSchema.parse(
            JSON.parse(readFileSync(path.join(MANIFESTS_DIR, 'bazel-lsp.json'), 'utf-8'))
        );
        expect(starpls.langIds).toContain('starlark');
        expect(bazelLsp.langIds).toContain('starlark');
    });
});
