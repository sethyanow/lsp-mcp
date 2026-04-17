import { existsSync, readFileSync } from 'fs';
import { z } from 'zod';
import { PluginManifest, PluginManifestSchema } from './types';

export function loadManifests(configPath: string): PluginManifest[] {
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
    return parsed.data;
}

export function resolveManifests(configPath: string): PluginManifest[] {
    if (!existsSync(configPath)) {
        process.stderr.write(
            `lsp-mcp: no config file at ${configPath}; starting with zero manifests. ` +
                `Set LSP_MCP_CONFIG to provide plugins.\n`
        );
        return [];
    }
    return loadManifests(configPath);
}

function formatZodError(err: z.ZodError): string {
    return err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
}
