import { existsSync, readdirSync, readFileSync } from 'fs';
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

export function discoverBuiltinManifests(): DiscoveredManifest[] {
    if (!existsSync(BUILTIN_DIR)) {
        process.stderr.write(
            `[lsp-mcp] built-in manifests dir missing at ${BUILTIN_DIR} — skipping built-in source\n`
        );
        return [];
    }

    const files = readdirSync(BUILTIN_DIR, { withFileTypes: true })
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name)
        .sort();

    const out: DiscoveredManifest[] = [];
    for (const name of files) {
        const full = path.join(BUILTIN_DIR, name);
        let raw: unknown;
        try {
            raw = JSON.parse(readFileSync(full, 'utf-8'));
        } catch (err) {
            process.stderr.write(
                `[lsp-mcp] failed to parse built-in manifest ${full}: ${(err as Error).message} — skipping\n`
            );
            continue;
        }
        const parsed = PluginManifestSchema.safeParse(raw);
        if (!parsed.success) {
            process.stderr.write(
                `[lsp-mcp] built-in manifest ${full} failed schema validation — skipping\n`
            );
            continue;
        }
        out.push({
            manifest: parsed.data,
            sourceKind: 'builtin',
            sourcePath: full,
        });
    }
    return out;
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

export function discoverManifests(opts: { configPath: string }): DiscoveredManifest[] {
    const builtins = discoverBuiltinManifests();
    const configFile = discoverConfigFileManifests(opts.configPath);
    return mergeDiscoveryPipeline([builtins, configFile]);
}
