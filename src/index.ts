#!/usr/bin/env node
/**
 * Entry point for the meta-LSP MCP server.
 *
 * Reads a plugin configuration file and starts the MCP server.
 *
 * Configuration:
 *   LSP_MCP_CONFIG   Path to a JSON config file listing plugin manifests.
 *                    Defaults to ./lsp-mcp.config.json.
 *   LSP_MCP_ROOT     Workspace root to pass to each LSP server.
 *                    Defaults to process.cwd().
 *
 * Config file format (array of PluginManifest objects):
 *   [
 *     {
 *       "name": "pyright",
 *       "version": "0.1.0",
 *       "langIds": ["python"],
 *       "fileGlobs": ["**\/*.py", "**\/*.pyi"],
 *       "workspaceMarkers": ["pyrightconfig.json", "pyproject.toml"],
 *       "server": {
 *         "cmd": ["node", "/path/to/pyright-langserver.js", "--stdio"]
 *       },
 *       "capabilities": {
 *         "workspaceSymbol": { "stringPrefilter": true, "timeoutMs": 10000 }
 *       }
 *     }
 *   ]
 */
import { readFileSync, existsSync } from 'fs';
import path from 'path';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { LspServer } from './lsp-server.js';
import { Router } from './router.js';
import { createMcpServer } from './mcp-server.js';
import type { PluginManifest } from './types.js';

async function main(): Promise<void> {
    const configPath = process.env.LSP_MCP_CONFIG ?? path.join(process.cwd(), 'lsp-mcp.config.json');
    const workspaceRoot = process.env.LSP_MCP_ROOT ?? process.cwd();

    if (!existsSync(configPath)) {
        process.stderr.write(
            `lsp-mcp: config file not found: ${configPath}\n` +
            `Set LSP_MCP_CONFIG to the path of your plugin configuration file.\n`
        );
        process.exit(1);
    }

    let manifests: PluginManifest[];
    try {
        const raw = readFileSync(configPath, 'utf-8');
        manifests = JSON.parse(raw) as PluginManifest[];
    } catch (err) {
        process.stderr.write(`lsp-mcp: failed to parse config: ${(err as Error).message}\n`);
        process.exit(1);
    }

    const servers = manifests.map((m) => new LspServer(m, workspaceRoot));
    const router = new Router(servers);
    const mcpServer = createMcpServer(router);

    // Graceful shutdown
    const doShutdown = async () => {
        await router.shutdownAll();
        process.exit(0);
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
