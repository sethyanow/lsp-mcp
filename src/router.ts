import { fileURLToPath } from 'url';
import type { LspServer } from './lsp-server.js';
import type { SourceKind } from './discover.js';
import type { DiagnosticInfo, Location, PluginManifest, SymbolInfo } from './types.js';

/**
 * A registered manifest paired with its backing LSP server. The Router's
 * public surface exposes these; LspServer instances are only reachable
 * through the entry they belong to.
 */
export interface ManifestEntry {
    manifest: PluginManifest;
    server: LspServer;
    sourceKind: SourceKind;
}

/**
 * Router: manages a set of ManifestEntries and dispatches requests to the
 * appropriate entry based on file path or language ID.
 *
 * Multi-candidate routing model:
 *   _entries  — canonical list (preserves registration order after dedupe)
 *   _byName   — O(1) lookup for `via` / `manifests` resolution
 *   _langMap  — { candidates[], primary } per langId; first-registered wins
 *
 * File-targeted requests (defs, refs, hover, etc.) route to the langId's
 * primary entry by default, or to a named manifest when `via` is supplied.
 * Workspace-scoped requests (symbol_search) fan across primaries by default;
 * an explicit `manifests` list overrides that to specific named entries.
 */
export class Router {
    private readonly _entries: ManifestEntry[];
    private readonly _byName: Map<string, ManifestEntry>;
    private readonly _langMap: Map<string, { candidates: ManifestEntry[]; primary: string }>;

    constructor(entries: ManifestEntry[]) {
        this._entries = Router._dedupeByName(entries);
        this._byName = new Map(this._entries.map((e) => [e.manifest.name, e]));
        this._langMap = Router._buildLangMap(this._entries);
    }

    // ---- Public accessors ---------------------------------------------------

    /** Flat list of LspServer instances, preserved for lifecycle + capability probes. */
    get servers(): LspServer[] {
        return this._entries.map((e) => e.server);
    }

    get entries(): ManifestEntry[] {
        return this._entries;
    }

    entry(name: string): ManifestEntry | undefined {
        return this._byName.get(name);
    }

    primaryForLang(langId: string): ManifestEntry | undefined {
        const slot = this._langMap.get(langId);
        return slot ? this._byName.get(slot.primary) : undefined;
    }

    candidatesForLang(langId: string): ManifestEntry[] {
        return this._langMap.get(langId)?.candidates ?? [];
    }

    /**
     * Return the primary entry whose server owns the file. Iterates
     * `_langMap` in insertion (registration) order; returns the first lang
     * whose primary's `ownsFile` is true. Deterministic across runs.
     */
    primaryForFile(filePath: string): ManifestEntry | undefined {
        for (const [, slot] of this._langMap) {
            const entry = this._byName.get(slot.primary);
            if (entry?.server.ownsFile(filePath)) return entry;
        }
        return undefined;
    }

    /** Return the server that owns the given file path. Preserved for back-compat. */
    serverForFile(filePath: string): LspServer | undefined {
        return this.primaryForFile(filePath)?.server;
    }

    /** Return the server that handles the given language ID. Preserved for back-compat. */
    serverForLang(langId: string): LspServer | undefined {
        return this.primaryForLang(langId)?.server;
    }

    // ---- Fan-out workspace-scoped requests ----------------------------------

    /**
     * workspace/symbol fanned across a selected target set.
     *
     * Target selection:
     *   - `manifests` non-empty → resolve each name via `_byName`; unknown names
     *     are skipped with a stderr log. Deduped by manifest name.
     *   - Otherwise → each langId's primary entry, optionally restricted by
     *     `langIds`. Deduped by manifest name.
     *   - `manifests: []` behaves identically to `manifests: undefined`
     *     (documented here for callers that pass `[]` to mean "no override").
     *
     * Results are merged and deduped by (uri, range, kind, name, containerName).
     */
    async symbolSearch(
        query: string,
        langIds?: string[],
        manifests?: string[]
    ): Promise<SymbolInfo[]> {
        const targets = this._selectSymbolSearchTargets(langIds, manifests);

        const settled = await Promise.allSettled(
            targets.map((e) => e.server.workspaceSymbol(query))
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
    // All positional methods accept optional `via?: string` to override the
    // default primary routing. An unknown `via` throws; empty string is treated
    // as unknown (presence check uses `via !== undefined`, not truthy).

    async definitions(
        fileUri: string,
        position: LspPosition,
        via?: string
    ): Promise<Location[]> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return [];
        return this._requestOnServer<Location[]>(
            server,
            fileUri,
            'textDocument/definition',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async references(
        fileUri: string,
        position: LspPosition,
        includeDeclaration = true,
        via?: string
    ): Promise<Location[]> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return [];
        return this._requestOnServer<Location[]>(
            server,
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

    async implementations(
        fileUri: string,
        position: LspPosition,
        via?: string
    ): Promise<Location[]> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return [];
        return this._requestOnServer<Location[]>(
            server,
            fileUri,
            'textDocument/implementation',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async hover(
        fileUri: string,
        position: LspPosition,
        via?: string
    ): Promise<Record<string, unknown> | null> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return null;
        return this._requestOnServer<Record<string, unknown> | null>(
            server,
            fileUri,
            'textDocument/hover',
            buildTextDocParams(fileUri, position),
            null
        );
    }

    async documentSymbols(
        fileUri: string,
        via?: string
    ): Promise<SymbolInfo[]> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return [];
        return this._requestOnServer<SymbolInfo[]>(
            server,
            fileUri,
            'textDocument/documentSymbol',
            { textDocument: { uri: fileUri } },
            []
        );
    }

    async diagnostics(fileUri: string, via?: string): Promise<DiagnosticInfo[]> {
        const server = this._routeFileRequest(fileUri, via);
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
        position: LspPosition,
        via?: string
    ): Promise<unknown[]> {
        const server = this._routeFileRequest(fileUri, via);
        if (!server) return [];
        return this._requestOnServer<unknown[]>(
            server,
            fileUri,
            'textDocument/prepareCallHierarchy',
            buildTextDocParams(fileUri, position),
            []
        );
    }

    async incomingCalls(item: unknown, via?: string): Promise<unknown[]> {
        const server = this._routeCallHierarchy(item, via);
        if (!server) return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/incomingCalls', { item });
        return Array.isArray(result) ? result : [];
    }

    async outgoingCalls(item: unknown, via?: string): Promise<unknown[]> {
        const server = this._routeCallHierarchy(item, via);
        if (!server) return [];
        await server.ensureRunning();
        const result = await server.request('callHierarchy/outgoingCalls', { item });
        return Array.isArray(result) ? result : [];
    }

    /** Raw passthrough: route to server owning `lang`, forward method+params. */
    async raw(
        lang: string,
        method: string,
        params: unknown,
        via?: string
    ): Promise<unknown> {
        const server = via !== undefined
            ? this._requireByName(via).server
            : this.serverForLang(lang);
        if (!server) {
            throw new Error(`No server configured for language: ${lang}`);
        }
        return server.request(method, params);
    }

    // ---- Lifecycle ----------------------------------------------------------

    async shutdownAll(): Promise<void> {
        await Promise.allSettled(this._entries.map((e) => e.server.shutdown()));
    }

    forceKillAll(): void {
        for (const e of this._entries) e.server.forceKill();
    }

    // ---- Internals ----------------------------------------------------------

    /**
     * Remove entries whose `manifest.name` duplicates an earlier entry
     * (first-wins). Each dropped entry emits a stderr log so user-visible
     * misconfig does not silently mis-route.
     */
    private static _dedupeByName(entries: ManifestEntry[]): ManifestEntry[] {
        const seen = new Set<string>();
        const result: ManifestEntry[] = [];
        for (const entry of entries) {
            const name = entry.manifest.name;
            if (seen.has(name)) {
                process.stderr.write(
                    `[lsp-mcp] duplicate manifest name "${name}" — dropping later entry\n`
                );
                continue;
            }
            seen.add(name);
            result.push(entry);
        }
        return result;
    }

    /**
     * Build `langId → { candidates[], primary }`. The first entry declaring a
     * langId wins the primary slot; subsequent entries declaring the same
     * langId append to the candidate list.
     */
    private static _buildLangMap(
        entries: ManifestEntry[]
    ): Map<string, { candidates: ManifestEntry[]; primary: string }> {
        const map = new Map<string, { candidates: ManifestEntry[]; primary: string }>();
        for (const entry of entries) {
            for (const langId of entry.manifest.langIds) {
                const slot = map.get(langId);
                if (slot) {
                    if (!slot.candidates.some((c) => c.manifest.name === entry.manifest.name)) {
                        slot.candidates.push(entry);
                    }
                } else {
                    map.set(langId, {
                        candidates: [entry],
                        primary: entry.manifest.name,
                    });
                }
            }
        }
        return map;
    }

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

    /**
     * Resolve the server to use for a file-URI method. Uses explicit-presence
     * semantics (`via !== undefined`) so empty string routes through the
     * unknown-name error path consistent with any other non-resolving name.
     */
    private _routeFileRequest(fileUri: string, via?: string): LspServer | undefined {
        if (via !== undefined) return this._requireByName(via).server;
        return this._serverForUri(fileUri);
    }

    /**
     * Resolve the server for call-hierarchy methods. With `via`, bypass the
     * item's uri and use the named manifest; without, fall through to
     * item.uri → file resolution (legacy behavior).
     */
    private _routeCallHierarchy(item: unknown, via?: string): LspServer | undefined {
        if (via !== undefined) return this._requireByName(via).server;
        const uri = (item as { uri?: string } | null)?.uri;
        if (typeof uri !== 'string') return undefined;
        return this._serverForUri(uri);
    }

    private _requireByName(name: string): ManifestEntry {
        const entry = this._byName.get(name);
        if (!entry) {
            throw new Error(`No manifest named "${name}"`);
        }
        return entry;
    }

    private async _openWithPause(server: LspServer, fileUri: string): Promise<void> {
        const justOpened = await server.openDocument(fileUri, server.defaultLangId);
        if (justOpened) {
            const delay = Number(server.manifest.capabilities?.didOpenDelayMs) || 100;
            await new Promise((r) => setTimeout(r, delay));
        }
    }

    private async _requestOnServer<T>(
        server: LspServer,
        fileUri: string,
        method: string,
        params: Record<string, unknown>,
        fallback: T
    ): Promise<T> {
        await this._openWithPause(server, fileUri);
        const result = await server.request(method, params);
        return (result ?? fallback) as T;
    }

    /**
     * Choose the target entries for `symbolSearch`. Explicit-manifests mode
     * dedupes by resolved entry's manifest name so duplicate-input names fan
     * exactly once; default mode fans each langId's primary deduped by the
     * same key.
     */
    private _selectSymbolSearchTargets(
        langIds: string[] | undefined,
        manifests: string[] | undefined
    ): ManifestEntry[] {
        const seen = new Set<string>();
        const result: ManifestEntry[] = [];

        if (manifests !== undefined && manifests.length > 0) {
            for (const name of manifests) {
                const entry = this._byName.get(name);
                if (!entry) {
                    process.stderr.write(
                        `[lsp-mcp] symbol_search: no manifest named "${name}"\n`
                    );
                    continue;
                }
                if (!seen.has(entry.manifest.name)) {
                    seen.add(entry.manifest.name);
                    result.push(entry);
                }
            }
            return result;
        }

        for (const [langId, slot] of this._langMap) {
            if (langIds && !langIds.includes(langId)) continue;
            const entry = this._byName.get(slot.primary);
            if (!entry) continue;
            if (!seen.has(entry.manifest.name)) {
                seen.add(entry.manifest.name);
                result.push(entry);
            }
        }
        return result;
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
