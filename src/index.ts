#!/usr/bin/env node
/**
 * Entry point for the meta-LSP MCP server.
 *
 * Reads a plugin configuration file and starts the MCP server.
 *
 * Configuration:
 *   LSP_MCP_CONFIG        Path to a JSON config file listing plugin manifests.
 *                         Defaults to ./lsp-mcp.config.json.
 *   LSP_MCP_ROOT          Workspace root passed to each LSP server.
 *                         Defaults to process.cwd().
 *   LSP_MCP_PLUGINS_DIR   Directory containing per-plugin asset dirs.
 *                         ${pluginDir} in cmd/buildHook expands to
 *                         "$LSP_MCP_PLUGINS_DIR/<manifest.name>".
 *                         Defaults to "<dirname(LSP_MCP_CONFIG)>/plugins".
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspServer } from './lsp-server.js';
import { Router } from './router.js';
import { createMcpServer } from './mcp-server.js';
import { PluginManifestSchema } from './types.js';
import type { PluginManifest } from './types.js';
import { z } from 'zod';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
    const configPath = process.env.LSP_MCP_CONFIG ?? path.join(process.cwd(), 'lsp-mcp.config.json');
    const workspaceRoot = process.env.LSP_MCP_ROOT ?? process.cwd();
    const pluginsDir =
        process.env.LSP_MCP_PLUGINS_DIR ?? path.join(path.dirname(configPath), 'plugins');

    if (!existsSync(configPath)) {
        process.stderr.write(
            `lsp-mcp: config file not found: ${configPath}\n` +
            `Set LSP_MCP_CONFIG to the path of your plugin configuration file.\n`
        );
        process.exit(1);
    }

    const manifests = loadManifests(configPath);

    for (const m of manifests) {
        if (m.capabilities?.implementations?.stringPrefilter === false) {
            process.stderr.write(
                `[lsp-mcp] warning: impls on "${m.name}" may time out on cold cache — ` +
                    `outer-layer prefilter is not yet implemented.\n`
            );
        }
    }

    const servers = manifests.map((m) => new LspServer(m, workspaceRoot, pluginsDir));
    const router = new Router(servers);
    const mcpServer = createMcpServer(router);

    let shuttingDown = false;
    const doShutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        const timer = setTimeout(() => {
            process.stderr.write(`[lsp-mcp] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; force-killing\n`);
            router.forceKillAll();
            process.exit(0);
        }, SHUTDOWN_TIMEOUT_MS);
        try {
            await router.shutdownAll();
        } finally {
            clearTimeout(timer);
            process.exit(0);
        }
    };
    process.on('SIGTERM', doShutdown);
    process.on('SIGINT', doShutdown);
    process.stdin.on('end', doShutdown);

    const transport = new StdioServerTransport();
    await mcpServer.connect(transport);
}

function loadManifests(configPath: string): PluginManifest[] {
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

function formatZodError(err: z.ZodError): string {
    return err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
}

main().catch((err) => {
    process.stderr.write(`lsp-mcp: fatal error: ${(err as Error).message}\n`);
    process.exit(1);
});
