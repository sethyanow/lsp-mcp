#!/usr/bin/env node
"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
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
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const stdio_js_1 = require("@modelcontextprotocol/sdk/server/stdio.js");
const lsp_server_js_1 = require("./lsp-server.js");
const router_js_1 = require("./router.js");
const mcp_server_js_1 = require("./mcp-server.js");
const types_js_1 = require("./types.js");
const zod_1 = require("zod");
const SHUTDOWN_TIMEOUT_MS = 5000;
async function main() {
    const configPath = path_1.default.resolve(process.env.LSP_MCP_CONFIG ?? path_1.default.join(process.cwd(), 'lsp-mcp.config.json'));
    const workspaceRoot = path_1.default.resolve(process.env.LSP_MCP_ROOT ?? process.cwd());
    const pluginsDir = path_1.default.resolve(process.env.LSP_MCP_PLUGINS_DIR ?? path_1.default.join(path_1.default.dirname(configPath), 'plugins'));
    if (!(0, fs_1.existsSync)(configPath)) {
        process.stderr.write(`lsp-mcp: config file not found: ${configPath}\n` +
            `Set LSP_MCP_CONFIG to the path of your plugin configuration file.\n`);
        process.exit(1);
    }
    const manifests = loadManifests(configPath);
    for (const m of manifests) {
        if (m.capabilities?.implementations?.stringPrefilter === false) {
            process.stderr.write(`[lsp-mcp] warning: impls on "${m.name}" may time out on cold cache — ` +
                `outer-layer prefilter is not yet implemented.\n`);
        }
    }
    const servers = manifests.map((m) => new lsp_server_js_1.LspServer(m, workspaceRoot, pluginsDir));
    const router = new router_js_1.Router(servers);
    const mcpServer = (0, mcp_server_js_1.createMcpServer)(router);
    let shuttingDown = false;
    const doShutdown = async () => {
        if (shuttingDown)
            return;
        shuttingDown = true;
        const timer = setTimeout(() => {
            process.stderr.write(`[lsp-mcp] shutdown timed out after ${SHUTDOWN_TIMEOUT_MS}ms; force-killing\n`);
            router.forceKillAll();
            process.exit(0);
        }, SHUTDOWN_TIMEOUT_MS);
        try {
            await router.shutdownAll();
        }
        finally {
            clearTimeout(timer);
            process.exit(0);
        }
    };
    process.on('SIGTERM', doShutdown);
    process.on('SIGINT', doShutdown);
    process.stdin.on('end', doShutdown);
    const transport = new stdio_js_1.StdioServerTransport();
    await mcpServer.connect(transport);
}
function loadManifests(configPath) {
    let raw;
    try {
        raw = JSON.parse((0, fs_1.readFileSync)(configPath, 'utf-8'));
    }
    catch (err) {
        process.stderr.write(`lsp-mcp: failed to parse config: ${err.message}\n`);
        process.exit(1);
    }
    if (!Array.isArray(raw)) {
        process.stderr.write(`lsp-mcp: config ${configPath} must be a JSON array of PluginManifest objects\n`);
        process.exit(1);
    }
    const parsed = zod_1.z.array(types_js_1.PluginManifestSchema).safeParse(raw);
    if (!parsed.success) {
        process.stderr.write(`lsp-mcp: invalid config ${configPath}:\n${formatZodError(parsed.error)}\n`);
        process.exit(1);
    }
    return parsed.data;
}
function formatZodError(err) {
    return err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
}
main().catch((err) => {
    process.stderr.write(`lsp-mcp: fatal error: ${err.message}\n`);
    process.exit(1);
});
//# sourceMappingURL=index.js.map