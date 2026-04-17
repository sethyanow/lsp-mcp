import { fileURLToPath } from 'url';
import type { LspServer } from './lsp-server.js';
import type { DiagnosticInfo, Location, SymbolInfo } from './types.js';

/**
 * Router: manages a set of LspServer instances and dispatches requests to the
 * appropriate server(s) based on file path or language ID.
 *
 * - File-targeted requests (defs, refs, hover, etc.) are routed to the single
 *   server that owns the file.
 * - Workspace-scoped requests (symbol_search) are fanned out across all servers
 *   and results are merged + deduped.
 */
export class Router {
    private readonly _servers: LspServer[];

    constructor(servers: LspServer[]) {
        this._servers = servers;
    }

    get servers(): LspServer[] {
        return this._servers;
    }

    // ---- Server selection ---------------------------------------------------

    /** Return the server that owns the given file path. */
    serverForFile(filePath: string): LspServer | undefined {
        return this._servers.find((s) => s.ownsFile(filePath));
    }

    /** Return the server that handles the given language ID. */
    serverForLang(langId: string): LspServer | undefined {
        return this._servers.find((s) => s.ownsLang(langId));
    }

    // ---- Fan-out workspace-scoped requests ----------------------------------

    /**
     * workspace/symbol fanned across all servers.
     * Results are deduped by (uri, line, character).
     */
    async symbolSearch(
        query: string,
        langIds?: string[]
    ): Promise<SymbolInfo[]> {
        const targets = langIds
            ? this._servers.filter((s) =>
                  langIds.some((l) => s.ownsLang(l))
              )
            : this._servers;

        const settled = await Promise.allSettled(
            targets.map((s) => s.workspaceSymbol(query))
        );

        const merged: SymbolInfo[] = [];
        const seen = new Set<string>();

        for (let i = 0; i < settled.length; i++) {
            const result = settled[i];
            if (result.status !== 'fulfilled') {
                const reason = result.reason;
                const message =
                    reason instanceof Error ? reason.message : String(reason);
                process.stderr.write(
                    `[lsp-mcp] symbol_search on ${targets[i].manifest.name} failed: ${message}\n`
                );
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

    async definitions(fileUri: string, position: LspPosition): Promise<Location[]> {
        return this._fileRequest<Location[]>(
            fileUri,
            'textDocument/definition',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async references(
        fileUri: string,
        position: LspPosition,
        includeDeclaration = true
    ): Promise<Location[]> {
        return this._fileRequest<Location[]>(
            fileUri,
            'textDocument/references',
            {
                textDocument: { uri: fileUri },
                position,
                context: { includeDeclaration },
            },
            []
        );
    }

    async implementations(fileUri: string, position: LspPosition): Promise<Location[]> {
        return this._fileRequest<Location[]>(
            fileUri,
            'textDocument/implementation',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async hover(
        fileUri: string,
        position: LspPosition
    ): Promise<Record<string, unknown> | null> {
        return this._fileRequest<Record<string, unknown> | null>(
            fileUri,
            'textDocument/hover',
            buildTextDocParams(fileUri, position),
            null
        );
    }

    async documentSymbols(
        fileUri: string
    ): Promise<SymbolInfo[]> {
        return this._fileRequest<SymbolInfo[]>(
            fileUri,
            'textDocument/documentSymbol',
            { textDocument: { uri: fileUri } },
            []
        );
    }

    async diagnostics(fileUri: string): Promise<DiagnosticInfo[]> {
        const server = this._serverForUri(fileUri);
        if (!server) return [];

        await this._openWithPause(server, fileUri);
        const result = await server.request('textDocument/diagnostic', {
            textDocument: { uri: fileUri },
        });
        const report = result as { items?: DiagnosticInfo[] } | null;
        return report?.items ?? [];
    }

    async prepareCallHierarchy(
        fileUri: string,
        position: LspPosition
    ): Promise<unknown[]> {
        return this._fileRequest<unknown[]>(
            fileUri,
            'textDocument/prepareCallHierarchy',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async incomingCalls(item: unknown): Promise<unknown[]> {
        const server = this._serverForCallHierarchyItem(item);
        if (!server) return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/incomingCalls', { item });
        return Array.isArray(result) ? result : [];
    }

    async outgoingCalls(item: unknown): Promise<unknown[]> {
        const server = this._serverForCallHierarchyItem(item);
        if (!server) return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/outgoingCalls', { item });
        return Array.isArray(result) ? result : [];
    }

    /** Raw passthrough: route to server owning `lang`, forward method+params. */
    async raw(
        lang: string,
        method: string,
        params: unknown
    ): Promise<unknown> {
        const server = this.serverForLang(lang);
        if (!server) {
            throw new Error(`No server configured for language: ${lang}`);
        }
        return server.request(method, params);
    }

    // ---- Lifecycle ----------------------------------------------------------

    async shutdownAll(): Promise<void> {
        await Promise.allSettled(this._servers.map((s) => s.shutdown()));
    }

    forceKillAll(): void {
        for (const s of this._servers) s.forceKill();
    }

    // ---- Internals ----------------------------------------------------------

    private _serverForUri(uri: string): LspServer | undefined {
        let filePath = uri;
        if (uri.startsWith('file://')) {
            try {
                filePath = fileURLToPath(uri);
            } catch {
                return undefined;
            }
        }
        return this.serverForFile(filePath);
    }

    private _serverForCallHierarchyItem(item: unknown): LspServer | undefined {
        const uri = (item as { uri?: string } | null)?.uri;
        if (typeof uri !== 'string') return undefined;
        return this._serverForUri(uri);
    }

    private async _openWithPause(server: LspServer, fileUri: string): Promise<void> {
        const justOpened = await server.openDocument(fileUri, server.defaultLangId);
        if (justOpened) {
            const delay = Number(server.manifest.capabilities?.didOpenDelayMs) || 100;
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    private async _fileRequest<T>(
        fileUri: string,
        method: string,
        params: Record<string, unknown>,
        fallback: T
    ): Promise<T> {
        const server = this._serverForUri(fileUri);
        if (!server) return fallback;

        await this._openWithPause(server, fileUri);
        const result = await server.request(method, params);
        return (result ?? fallback) as T;
    }
}

// ---- Small helpers ---------------------------------------------------------

export interface LspPosition {
    line: number;
    character: number;
}

function buildTextDocParams(
    uri: string,
    position: LspPosition
): Record<string, unknown> {
    return { textDocument: { uri }, position };
}

function dedupeKey(sym: SymbolInfo): string {
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
