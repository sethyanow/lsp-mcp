#!/usr/bin/env node
/**
 * Entry point for the meta-LSP MCP server.
 *
 * Reads a plugin configuration file and starts the MCP server.
 *
 * Configuration:
 *   LSP_MCP_CONFIG          Path to a JSON config file listing plugin manifests.
 *                           Defaults to ./lsp-mcp.config.json.
 *   CLAUDE_PLUGIN_ROOT      Set by Claude Code when this server is installed as
 *                           a plugin. Resolved via 3-level parent-walk
 *                           (`../../..`) to CC's plugin cache root; the walker
 *                           then discovers sibling-plugin `lsp-manifest.json`
 *                           files across every marketplace. Plugin-tree source
 *                           slots between built-ins and config-file in the
 *                           merge chain. Coupling to CC's (undocumented)
 *                           cache layout is accepted for MVP; walker emits
 *                           stderr if the layout ever shifts.
 *   LSP_MCP_MANIFESTS_DIR   Optional directory of JSON manifest files. Each
 *                           *.json file is parsed as a PluginManifest. Highest
 *                           priority source — entries here override config-file,
 *                           plugin-tree, and built-in defaults on name
 *                           collision. Use absolute paths; CC invokes the
 *                           server from arbitrary working directories.
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
import { formatMissingBinarySummary, probeAll } from './probe.js';
import { Router, type ManifestEntry } from './router.js';
import { createMcpServer } from './mcp-server.js';
import {
    discoverManifests,
    resolveManifestsDirEnv,
    resolvePluginTreeEnv,
} from './discover.js';

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
    const pluginTreeRoot = resolvePluginTreeEnv(process.env.CLAUDE_PLUGIN_ROOT);

    const discovered = discoverManifests({ configPath, pluginTreeRoot, manifestsDir });

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

    const probed = probeAll(discovered);
    const missingSummary = formatMissingBinarySummary(probed);
    if (missingSummary !== undefined) {
        process.stderr.write(`${missingSummary}\n`);
    }

    const entries: ManifestEntry[] = probed.map((p) => ({
        manifest: p.manifest,
        server: new LspServer(p.manifest, workspaceRoot, pluginsDir),
        sourceKind: p.sourceKind,
        status: p.status,
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
