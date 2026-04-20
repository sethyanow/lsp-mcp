import { fileURLToPath } from 'url';
import type { LspServer } from './lsp-server.js';
import type { SourceKind } from './discover.js';
import type { ProbeStatus } from './probe.js';
import type { DiagnosticInfo, Location, PluginManifest, SymbolInfo } from './types.js';

/**
 * A registered manifest paired with its backing LSP server. The Router's
 * public surface exposes these; LspServer instances are only reachable
 * through the entry they belong to.
 *
 * `status` reflects the PATH probe result at router construction time:
 * `'ok'` manifests contribute to routing; `'binary_not_found'` manifests
 * stay in `entries` / `entry(name)` for enumeration (e.g. `list_languages`)
 * but are excluded from the langId → primary map.
 */
export interface ManifestEntry {
    manifest: PluginManifest;
    server: LspServer;
    sourceKind: SourceKind;
    status: ProbeStatus;
}

/**
 * One (lang, manifest) row surfaced by `Router.listLanguages()` — and,
 * by extension, the `list_languages` MCP tool.
 *
 * Includes manifests whose binary was not found on PATH (status:
 * `'binary_not_found'`) so agents can diagnose missing LSPs without
 * reading stderr. `primary` is derived at query time from `_langMap`;
 * it is never stored on `ManifestEntry`.
 */
export interface LanguageInfo {
    lang: string;
    manifest: string;
    primary: boolean;
    status: ProbeStatus;
    capabilities: PluginManifest['capabilities'];
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
     * Enumerate every (lang, manifest) pair the router knows about, including
     * manifests whose binary was not found on PATH. Surfaces the input for
     * the `list_languages` MCP tool.
     *
     * Ordering: `_entries` insertion order × `manifest.langIds` declared order.
     * `primary` is derived from `_langMap`; it is `true` iff the entry is `ok`
     * AND its manifest is the `_langMap.primary` for that langId.
     *
     * This method is side-effect-free — it reads manifest metadata only and
     * never touches `entry.server`. Calling it must not wake any dormant LSP
     * process (see `lspm-rot` Failure catalog: Temporal Betrayal).
     */
    listLanguages(): LanguageInfo[] {
        const rows: LanguageInfo[] = [];
        for (const entry of this._entries) {
            for (const lang of entry.manifest.langIds) {
                const slot = this._langMap.get(lang);
                const primary =
                    entry.status === 'ok' && slot?.primary === entry.manifest.name;
                rows.push({
                    lang,
                    manifest: entry.manifest.name,
                    primary,
                    status: entry.status,
                    capabilities: entry.manifest.capabilities,
                });
            }
        }
        return rows;
    }

    /**
     * Swap which candidate manifest is primary for a langId.
     *
     * In-memory mutation only — resets to `_buildLangMap`'s first-registered
     * winner on server restart (parent epic R6 contract; no persistence in
     * Phase 1). The `primary` field on the `_langMap` slot is mutated in place;
     * the Map itself is not reallocated and `_entries` order is preserved.
     *
     * Validation order (fail fast):
     *   1. Unknown manifest name → throw with known alternatives.
     *   2. Unknown langId (no slot) → throw with active langs list.
     *   3. Manifest exists but isn't a candidate for this lang → throw with
     *      candidate names.
     *   4. Manifest is `binary_not_found` → refuse promotion (primary must be
     *      dispatchable; routing would otherwise skip it per R5 soft-skip and
     *      agents would see `primary:true` but queries return empty).
     *
     * Idempotent: if the requested manifest is already primary, returns the
     * current shape without writing or logging.
     *
     * On successful swap, mutation precedes the stderr log so a log failure
     * (EPIPE, closed pipe) cannot leave state un-applied.
     */
    setPrimary(
        lang: string,
        manifestName: string
    ): { lang: string; primary: string; previous: string } {
        // 1. Unknown manifest name.
        const entry = this._byName.get(manifestName);
        if (!entry) {
            const known = Array.from(this._byName.keys()).sort();
            throw new Error(
                `Unknown manifest: ${manifestName}. Known: ${known.join(', ')}`
            );
        }

        // 2. Unknown langId (no slot in _langMap).
        const slot = this._langMap.get(lang);
        if (!slot) {
            const activeLangs = Array.from(this._langMap.keys()).sort();
            throw new Error(
                `Unknown lang: ${lang}. Known: ${activeLangs.join(', ')}`
            );
        }

        // 3. Manifest must be author-declared for this lang. Uses
        // `manifest.langIds` rather than `slot.candidates` because _buildLangMap
        // filters non-ok entries out of candidates — so a binary_not_found
        // manifest that IS declared for this lang wouldn't reach step 4
        // otherwise. Author-intent is the right predicate here: "did the
        // manifest's author say this LSP handles this lang?"
        if (!entry.manifest.langIds.includes(lang)) {
            const candidateNames = slot.candidates
                .map((c) => c.manifest.name)
                .join(', ');
            throw new Error(
                `Manifest ${manifestName} is not a candidate for lang '${lang}'. Candidates: ${candidateNames}`
            );
        }

        // 4. binary_not_found: reuse the error formatter from _requireByName
        // for consistent surface across query (_requireByName) and mutation.
        if (entry.status !== 'ok') {
            throw Router._binaryNotFoundError(manifestName, entry.status);
        }

        const previous = slot.primary;
        if (previous === manifestName) {
            // Idempotent no-op. No write, no log.
            return { lang, primary: manifestName, previous };
        }

        // Mutate first, then log. Write-order invariant: log failure (EPIPE,
        // closed pipe) must not prevent the mutation from sticking.
        slot.primary = manifestName;
        process.stderr.write(
            `[lsp-mcp] set_primary: ${lang} ${previous} → ${manifestName}\n`
        );
        return { lang, primary: manifestName, previous };
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
            if (entry.status !== 'ok') continue;
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
        if (entry.status !== 'ok') {
            throw Router._binaryNotFoundError(name, entry.status);
        }
        return entry;
    }

    /**
     * Shared error formatter for "manifest exists but its binary isn't on
     * PATH." Used by `_requireByName` (query surface) and `setPrimary`
     * (mutation surface) to keep the error phrasing identical across both
     * paths. Name quoted for readability when the name contains punctuation.
     */
    private static _binaryNotFoundError(name: string, status: string): Error {
        return new Error(
            `Manifest "${name}" is ${status} — binary not found on PATH`
        );
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
                if (entry.status !== 'ok') {
                    process.stderr.write(
                        `[lsp-mcp] symbol_search: "${name}" is ${entry.status} — skipping\n`
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
