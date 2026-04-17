"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.Router = void 0;
const url_1 = require("url");
/**
 * Router: manages a set of LspServer instances and dispatches requests to the
 * appropriate server(s) based on file path or language ID.
 *
 * - File-targeted requests (defs, refs, hover, etc.) are routed to the single
 *   server that owns the file.
 * - Workspace-scoped requests (symbol_search) are fanned out across all servers
 *   and results are merged + deduped.
 */
class Router {
    constructor(servers) {
        this._servers = servers;
    }
    get servers() {
        return this._servers;
    }
    // ---- Server selection ---------------------------------------------------
    /** Return the server that owns the given file path. */
    serverForFile(filePath) {
        return this._servers.find((s) => s.ownsFile(filePath));
    }
    /** Return the server that handles the given language ID. */
    serverForLang(langId) {
        return this._servers.find((s) => s.ownsLang(langId));
    }
    // ---- Fan-out workspace-scoped requests ----------------------------------
    /**
     * workspace/symbol fanned across all servers.
     * Results are deduped by (uri, line, character).
     */
    async symbolSearch(query, langIds) {
        const targets = langIds
            ? this._servers.filter((s) => langIds.some((l) => s.ownsLang(l)))
            : this._servers;
        const settled = await Promise.allSettled(targets.map((s) => s.workspaceSymbol(query)));
        const merged = [];
        const seen = new Set();
        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (result.status !== 'fulfilled') {
                const reason = result.reason;
                const message = reason instanceof Error ? reason.message : String(reason);
                process.stderr.write(`[lsp-mcp] symbol_search on ${targets[i].manifest.name} failed: ${message}\n`);
                continue;
            }
            for (const sym of result.value) {
                const key = dedupeKey(sym);
                if (!seen.has(key)) {
                    seen.add(key);
                    merged.push(sym);
                }
            }
        }
        return merged;
    }
    // ---- File-targeted requests ---------------------------------------------
    async definitions(fileUri, position) {
        return this._fileRequest(fileUri, 'textDocument/definition', buildTextDocParams(fileUri, position), []);
    }
    async references(fileUri, position, includeDeclaration = true) {
        return this._fileRequest(fileUri, 'textDocument/references', {
            textDocument: { uri: fileUri },
            position,
            context: { includeDeclaration },
        }, []);
    }
    async implementations(fileUri, position) {
        return this._fileRequest(fileUri, 'textDocument/implementation', buildTextDocParams(fileUri, position), []);
    }
    async hover(fileUri, position) {
        return this._fileRequest(fileUri, 'textDocument/hover', buildTextDocParams(fileUri, position), null);
    }
    async documentSymbols(fileUri) {
        return this._fileRequest(fileUri, 'textDocument/documentSymbol', { textDocument: { uri: fileUri } }, []);
    }
    async diagnostics(fileUri) {
        const server = this._serverForUri(fileUri);
        if (!server)
            return [];
        await this._openWithPause(server, fileUri);
        const result = await server.request('textDocument/diagnostic', {
            textDocument: { uri: fileUri },
        });
        const report = result;
        return report?.items ?? [];
    }
    async prepareCallHierarchy(fileUri, position) {
        return this._fileRequest(fileUri, 'textDocument/prepareCallHierarchy', buildTextDocParams(fileUri, position), []);
    }
    async incomingCalls(item) {
        const server = this._serverForCallHierarchyItem(item);
        if (!server)
            return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/incomingCalls', { item });
        return Array.isArray(result) ? result : [];
    }
    async outgoingCalls(item) {
        const server = this._serverForCallHierarchyItem(item);
        if (!server)
            return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/outgoingCalls', { item });
        return Array.isArray(result) ? result : [];
    }
    /** Raw passthrough: route to server owning `lang`, forward method+params. */
    async raw(lang, method, params) {
        const server = this.serverForLang(lang);
        if (!server) {
            throw new Error(`No server configured for language: ${lang}`);
        }
        return server.request(method, params);
    }
    // ---- Lifecycle ----------------------------------------------------------
    async shutdownAll() {
        await Promise.allSettled(this._servers.map((s) => s.shutdown()));
    }
    forceKillAll() {
        for (const s of this._servers)
            s.forceKill();
    }
    // ---- Internals ----------------------------------------------------------
    _serverForUri(uri) {
        let filePath = uri;
        if (uri.startsWith('file://')) {
            try {
                filePath = (0, url_1.fileURLToPath)(uri);
            }
            catch {
                return undefined;
            }
        }
        return this.serverForFile(filePath);
    }
    _serverForCallHierarchyItem(item) {
        const uri = item?.uri;
        if (typeof uri !== 'string')
            return undefined;
        return this._serverForUri(uri);
    }
    async _openWithPause(server, fileUri) {
        const justOpened = await server.openDocument(fileUri, server.defaultLangId);
        if (justOpened) {
            const delay = Number(server.manifest.capabilities?.didOpenDelayMs) || 100;
            await new Promise((r) => setTimeout(r, delay));
        }
    }
    async _fileRequest(fileUri, method, params, fallback) {
        const server = this._serverForUri(fileUri);
        if (!server)
            return fallback;
        await this._openWithPause(server, fileUri);
        const result = await server.request(method, params);
        return (result ?? fallback);
    }
}
exports.Router = Router;
function buildTextDocParams(uri, position) {
    return { textDocument: { uri }, position };
}
function dedupeKey(sym) {
    const r = sym.location.range;
    // Include name/kind/containerName so multiple symbols from the same file
    // without ranges (e.g. WorkspaceSymbol entries normalized to zero-range)
    // don't collapse into a single entry.
    return [
        sym.location.uri,
        r.start.line,
        r.start.character,
        r.end.line,
        r.end.character,
        sym.kind,
        sym.name,
        sym.containerName ?? '',
    ].join(':');
}
//# sourceMappingURL=router.js.map