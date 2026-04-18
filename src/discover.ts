import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { z } from 'zod';
import { PluginManifest, PluginManifestSchema } from './types';

export type SourceKind = 'builtin' | 'plugin-tree' | 'config-file' | 'manifests-dir';

export interface DiscoveredManifest {
    manifest: PluginManifest;
    sourceKind: SourceKind;
    sourcePath?: string;
}

const BUILTIN_DIR = path.resolve(__dirname, '../manifests');

/**
 * Shared loader for JSON-manifest directories. Backs both the built-in
 * defaults and user-supplied `LSP_MCP_MANIFESTS_DIR`.
 *
 * Soft-skip policy (never throw from startup):
 *   - dir absent → stderr notice, return []
 *   - dir is a file, not a directory → stderr notice, return []
 *   - listing fails (EACCES on parent, FS error) → stderr notice, return []
 *
 * The statSync + readdirSync calls share a single try/catch. `statSync` can
 * throw EACCES independently of `existsSync` (overlay FS layers, parent dir
 * with `-x` stripped), so scoping the catch to `readdirSync` alone would miss
 * that failure mode.
 */
function discoverFromJsonDir(dir: string, sourceKind: SourceKind): DiscoveredManifest[] {
    if (!existsSync(dir)) {
        process.stderr.write(
            `[lsp-mcp] ${sourceKind} source: dir missing at ${dir} — skipping\n`
        );
        return [];
    }

    let entries: Dirent[];
    try {
        const st = statSync(dir);
        if (!st.isDirectory()) {
            process.stderr.write(
                `[lsp-mcp] ${sourceKind} source: path ${dir} is not a directory — skipping\n`
            );
            return [];
        }
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        process.stderr.write(
            `[lsp-mcp] ${sourceKind} source: could not read ${dir}: ${(err as Error).message} — skipping\n`
        );
        return [];
    }

    const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name)
        .sort();

    const out: DiscoveredManifest[] = [];
    for (const name of files) {
        const full = path.join(dir, name);
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(full, 'utf-8'));
        } catch (err) {
            process.stderr.write(
                `[lsp-mcp] failed to parse ${sourceKind} manifest ${full}: ${(err as Error).message} — skipping\n`
            );
            continue;
        }
        const parsed = PluginManifestSchema.safeParse(raw);
        if (!parsed.success) {
            process.stderr.write(
                `[lsp-mcp] ${sourceKind} manifest ${full} failed schema validation — skipping\n`
            );
            continue;
        }
        out.push({
            manifest: parsed.data,
            sourceKind,
            sourcePath: full,
        });
    }
    return out;
}

export function discoverBuiltinManifests(): DiscoveredManifest[] {
    return discoverFromJsonDir(BUILTIN_DIR, 'builtin');
}

export function discoverManifestsDir(dir: string): DiscoveredManifest[] {
    return discoverFromJsonDir(dir, 'manifests-dir');
}

export function discoverConfigFileManifests(configPath: string): DiscoveredManifest[] {
    if (!existsSync(configPath)) {
        process.stderr.write(
            `lsp-mcp: no config file at ${configPath}; starting with zero config-file manifests. ` +
                `Set LSP_MCP_CONFIG to provide plugins.\n`
        );
        return [];
    }

    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
        process.stderr.write(`lsp-mcp: failed to parse config: ${(err as Error).message}\n`);
        process.exit(1);
    }

    if (!Array.isArray(raw)) {
        process.stderr.write(
            `lsp-mcp: config ${configPath} must be a JSON array of PluginManifest objects\n`
        );
        process.exit(1);
    }

    const parsed = z.array(PluginManifestSchema).safeParse(raw);
    if (!parsed.success) {
        process.stderr.write(
            `lsp-mcp: invalid config ${configPath}:\n${formatZodError(parsed.error)}\n`
        );
        process.exit(1);
    }

    return parsed.data.map((manifest) => ({
        manifest,
        sourceKind: 'config-file' as const,
        sourcePath: configPath,
    }));
}

function formatZodError(err: z.ZodError): string {
    return err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
}

/**
 * Merge sources in priority order (low → high). Later sources override prior
 * entries of the same manifest name; each override emits a stderr log naming
 * both sources + paths. Map insertion order is preserved on `set`, so an
 * override keeps the original entry's registration slot — Router's
 * first-registered-wins primary selection stays stable across collisions.
 */
export function mergeDiscoveryPipeline(
    sources: DiscoveredManifest[][]
): DiscoveredManifest[] {
    const byName = new Map<string, DiscoveredManifest>();
    for (const batch of sources) {
        for (const discovered of batch) {
            const prior = byName.get(discovered.manifest.name);
            if (prior) {
                process.stderr.write(
                    `[lsp-mcp] manifest "${discovered.manifest.name}" from ${discovered.sourceKind} ` +
                        `(${discovered.sourcePath ?? '?'}) overrides prior ${prior.sourceKind} ` +
                        `(${prior.sourcePath ?? '?'}).\n`
                );
            }
            byName.set(discovered.manifest.name, discovered);
        }
    }
    return Array.from(byName.values());
}

/**
 * Normalize the raw `LSP_MCP_MANIFESTS_DIR` env value into an absolute path
 * or `undefined`. Empty strings are treated as unset — some shells set env
 * vars to `""` with `export LSP_MCP_MANIFESTS_DIR=`, and `path.resolve('')`
 * would return `process.cwd()`, scanning the working directory for JSON.
 * Relative paths are normalized against cwd; absolute paths pass through.
 */
export function resolveManifestsDirEnv(raw: string | undefined): string | undefined {
    return raw && raw.length > 0 ? path.resolve(raw) : undefined;
}

export function discoverManifests(opts: {
    configPath: string;
    manifestsDir?: string;
}): DiscoveredManifest[] {
    const builtins = discoverBuiltinManifests();
    const configFile = discoverConfigFileManifests(opts.configPath);
    const manifestsDir = opts.manifestsDir ? discoverManifestsDir(opts.manifestsDir) : [];
    return mergeDiscoveryPipeline([builtins, configFile, manifestsDir]);
}
