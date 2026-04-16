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

        for (const result of settled) {
            if (result.status !== 'fulfilled') continue;
            for (const sym of result.value) {
                const key = dedupeKey(sym.location);
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

        const langId = langIdFromUri(fileUri, server);
        await server.openDocument(fileUri, langId);
        // LSP diagnostics are push-based (publishDiagnostics notification).
        // We approximate them via textDocument/diagnostic if the server supports it.
        try {
            const result = await server.request('textDocument/diagnostic', {
                textDocument: { uri: fileUri },
            });
            const report = result as { items?: DiagnosticInfo[] } | null;
            return report?.items ?? [];
        } catch {
            return [];
        }
    }

    /** Raw passthrough: route to server owning `lang`, forward method+params. */
    async raw(
        lang: string,
        method: string,
        params: Record<string, unknown>
    ): Promise<unknown> {
        const server = this.serverForLang(lang);
        if (!server) {
            throw new Error(`No server configured for language: ${lang}`);
        }
        await server.ensureRunning();
        return server.request(method, params);
    }

    // ---- Lifecycle ----------------------------------------------------------

    async shutdownAll(): Promise<void> {
        await Promise.allSettled(this._servers.map((s) => s.shutdown()));
    }

    // ---- Internals ----------------------------------------------------------

    private _serverForUri(uri: string): LspServer | undefined {
        const filePath = uri.startsWith('file://')
            ? decodeURIComponent(new URL(uri).pathname)
            : uri;
        return this.serverForFile(filePath);
    }

    private async _fileRequest<T>(
        fileUri: string,
        method: string,
        params: Record<string, unknown>,
        fallback: T
    ): Promise<T> {
        const server = this._serverForUri(fileUri);
        if (!server) return fallback;

        const langId = langIdFromUri(fileUri, server);
        await server.openDocument(fileUri, langId);
        await new Promise((r) => setTimeout(r, 100));

        try {
            const result = await server.request(method, params);
            return (result ?? fallback) as T;
        } catch {
            return fallback;
        }
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

function dedupeKey(loc: Location): string {
    return `${loc.uri}:${loc.range.start.line}:${loc.range.start.character}`;
}

function langIdFromUri(uri: string, server: LspServer): string {
    return server.manifest.langIds[0] ?? 'plaintext';
}
