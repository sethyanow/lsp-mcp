#!/usr/bin/env node
/**
 * Entry point for the meta-LSP MCP server.
 *
 * Reads a plugin configuration file and starts the MCP server.
 *
 * Configuration:
 *   LSP_MCP_CONFIG          Path to a JSON config file listing plugin manifests.
 *                           Defaults to ./lsp-mcp.config.json.
 *   LSP_MCP_MANIFESTS_DIR   Optional directory of JSON manifest files. Each
 *                           *.json file is parsed as a PluginManifest. Highest
 *                           priority source — entries here override config-file
 *                           and built-in defaults on name collision. Use
 *                           absolute paths; CC invokes the server from
 *                           arbitrary working directories.
 *   LSP_MCP_ROOT            Workspace root passed to each LSP server.
 *                           Defaults to process.cwd().
 *   LSP_MCP_PLUGINS_DIR     Directory containing per-plugin asset dirs.
 *                           ${pluginDir} in cmd/buildHook expands to
 *                           "$LSP_MCP_PLUGINS_DIR/<manifest.name>".
 *                           Defaults to "<dirname(LSP_MCP_CONFIG)>/plugins".
 */
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspServer } from './lsp-server.js';
import { Router, type ManifestEntry } from './router.js';
import { createMcpServer } from './mcp-server.js';
import { discoverManifests, resolveManifestsDirEnv } from './discover.js';

const SHUTDOWN_TIMEOUT_MS = 5_000;

async function main(): Promise<void> {
    const configPath = path.resolve(
        process.env.LSP_MCP_CONFIG ?? path.join(process.cwd(), 'lsp-mcp.config.json'),
    );
    const workspaceRoot = path.resolve(process.env.LSP_MCP_ROOT ?? process.cwd());
    const pluginsDir = path.resolve(
        process.env.LSP_MCP_PLUGINS_DIR ?? path.join(path.dirname(configPath), 'plugins'),
    );
    const manifestsDir = resolveManifestsDirEnv(process.env.LSP_MCP_MANIFESTS_DIR);

    const discovered = discoverManifests({ configPath, manifestsDir });

    if (discovered.length === 0) {
        process.stderr.write(`[lsp-mcp] loaded 0 manifests\n`);
    } else {
        const countsBySource = discovered.reduce<Record<string, number>>((acc, d) => {
            acc[d.sourceKind] = (acc[d.sourceKind] ?? 0) + 1;
            return acc;
        }, {});
        process.stderr.write(
            `[lsp-mcp] loaded ${discovered.length} manifests (` +
                Object.entries(countsBySource)
                    .map(([k, v]) => `${k}: ${v}`)
                    .join(', ') +
                `)\n`
        );
    }

    for (const d of discovered) {
        if (d.manifest.capabilities?.implementations?.stringPrefilter === false) {
            process.stderr.write(
                `[lsp-mcp] warning: impls on "${d.manifest.name}" may time out on cold cache — ` +
                    `outer-layer prefilter is not yet implemented.\n`
            );
        }
    }

    const entries: ManifestEntry[] = discovered.map((d) => ({
        manifest: d.manifest,
        server: new LspServer(d.manifest, workspaceRoot, pluginsDir),
        sourceKind: d.sourceKind,
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
