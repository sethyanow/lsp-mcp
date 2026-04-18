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
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspServer } from './lsp-server.js';
import { Router, type ManifestEntry } from './router.js';
import { createMcpServer } from './mcp-server.js';
import { resolveManifests } from './config.js';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
    const configPath = path.resolve(
        process.env.LSP_MCP_CONFIG ?? path.join(process.cwd(), 'lsp-mcp.config.json'),
    );
    const workspaceRoot = path.resolve(process.env.LSP_MCP_ROOT ?? process.cwd());
    const pluginsDir = path.resolve(
        process.env.LSP_MCP_PLUGINS_DIR ?? path.join(path.dirname(configPath), 'plugins'),
    );

    const manifests = resolveManifests(configPath);

    for (const m of manifests) {
        if (m.capabilities?.implementations?.stringPrefilter === false) {
            process.stderr.write(
                `[lsp-mcp] warning: impls on "${m.name}" may time out on cold cache — ` +
                    `outer-layer prefilter is not yet implemented.\n`
            );
        }
    }

    const entries: ManifestEntry[] = manifests.map((m) => ({
        manifest: m,
        server: new LspServer(m, workspaceRoot, pluginsDir),
    }));
    const router = new Router(entries);
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

main().catch((err) => {
    process.stderr.write(`lsp-mcp: fatal error: ${(err as Error).message}\n`);
    process.exit(1);
});
