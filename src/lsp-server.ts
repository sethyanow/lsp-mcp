import { spawn, ChildProcess } from 'child_process';
import { readFileSync } from 'fs';
import {
    createMessageConnection,
    MessageConnection,
    RequestType,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import type { PluginManifest, SymbolInfo } from './types.js';

/**
 * Persistent JSON-RPC bridge for a single LSP server process.
 * Spawns the server, runs LSP initialize, and keeps the connection alive
 * across many requests (warm-cache after first query).
 */
export class LspServer {
    readonly manifest: PluginManifest;

    private _process: ChildProcess | null = null;
    private _connection: MessageConnection | null = null;
    private _initDone = false;
    private _initPromise: Promise<void> | null = null;
    private readonly _openedUris = new Set<string>();
    private _workspaceRoot: string;

    constructor(manifest: PluginManifest, workspaceRoot: string) {
        this.manifest = manifest;
        this._workspaceRoot = workspaceRoot;
    }

    // ---- Lifecycle ----------------------------------------------------------

    /** Ensure the server process is running and initialized. Idempotent.
     *  If a previous start attempt failed, calling this again will retry. */
    async ensureRunning(): Promise<void> {
        if (this._initDone) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._start().catch((err: unknown) => {
            // Clear promise so the next call can retry from scratch
            this._initPromise = null;
            this._connection?.dispose();
            this._connection = null;
            this._process?.kill();
            this._process = null;
            throw err;
        });
        return this._initPromise;
    }

    private async _start(): Promise<void> {
        const [cmd, ...args] = this._resolveCmd();

        const proc = spawn(cmd, args, {
            cwd: this._workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stdin!.on('error', () => {});
        proc.stdout!.on('error', () => {});
        proc.stderr!.on('error', () => {});
        proc.stderr!.resume();

        this._process = proc;

        const conn = createMessageConnection(
            new StreamMessageReader(proc.stdout!),
            new StreamMessageWriter(proc.stdin!)
        );
        conn.listen();
        this._connection = conn;

        const rootUri = `file://${this._workspaceRoot}`;
        const workspaceName = this._workspaceRoot.split('/').pop() || 'workspace';

        await conn.sendRequest('initialize', {
            processId: process.pid,
            rootUri,
            rootPath: this._workspaceRoot,
            workspaceFolders: [{ uri: rootUri, name: workspaceName }],
            capabilities: {
                textDocument: {
                    implementation: { dynamicRegistration: false },
                    inlayHint: { dynamicRegistration: false },
                    codeLens: { dynamicRegistration: false },
                },
                workspace: {
                    symbol: { dynamicRegistration: false },
                    workspaceFolders: true,
                },
            },
            initializationOptions: this.manifest.server.initOptions ?? {},
        });

        conn.sendNotification('initialized', {});
        this._initDone = true;
    }

    /** Gracefully shut down the LSP server. */
    async shutdown(): Promise<void> {
        if (!this._connection) return;
        try {
            await this._connection.sendRequest('shutdown');
            this._connection.sendNotification('exit');
        } catch {
            // ignore
        }
        this._connection.dispose();
        this._connection = null;

        await new Promise<void>((r) => setImmediate(r));
        this._process?.kill();
        this._process = null;
        this._initDone = false;
        this._initPromise = null;
    }

    // ---- Request forwarding -------------------------------------------------

    /**
     * Send a raw LSP request. Ensures the server is running first.
     * @param timeoutMs Maximum time to wait (default: 30 000 ms).
     */
    async request(
        method: string,
        params: Record<string, unknown>,
        timeoutMs = 30_000
    ): Promise<unknown> {
        await this.ensureRunning();
        const conn = this._connection!;

        const requestType = new RequestType<Record<string, unknown>, unknown, void>(method);
        return Promise.race([
            conn.sendRequest(requestType, params),
            new Promise<never>((_, reject) =>
                setTimeout(
                    () => reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`)),
                    timeoutMs
                )
            ),
        ]);
    }

    /**
     * Send textDocument/didOpen if the URI hasn't been opened yet.
     * This triggers full type-checking in servers that need it.
     * Returns true if the document was newly opened, false if it was already open.
     */
    async openDocument(uri: string, languageId: string): Promise<boolean> {
        if (this._openedUris.has(uri)) return false;
        await this.ensureRunning();
        const conn = this._connection!;

        if (uri.startsWith('file://')) {
            const filePath = decodeURIComponent(new URL(uri).pathname);
            let text: string;
            try {
                text = readFileSync(filePath, 'utf-8');
            } catch {
                return false;
            }
            conn.sendNotification('textDocument/didOpen', {
                textDocument: { uri, languageId, version: 1, text },
            });
            this._openedUris.add(uri);
            return true;
        }
        return false;
    }

    /**
     * Poll workspace/symbol until the server has finished its background pass
     * and returns at least one result (or the given number of retries is exhausted).
     */
    async waitForAnalysis(retries = 50, intervalMs = 200): Promise<void> {
        await this.ensureRunning();
        for (let i = 0; i < retries; i++) {
            const probe = await this._connection!.sendRequest('workspace/symbol', { query: '' });
            if (Array.isArray(probe) && probe.length > 0) return;
            await new Promise((r) => setTimeout(r, intervalMs));
        }
    }

    /**
     * workspace/symbol with poll-until-results semantics.
     * Returns all symbols whose name matches `query`.
     */
    async workspaceSymbol(
        query: string,
        timeoutMs?: number
    ): Promise<SymbolInfo[]> {
        await this.ensureRunning();
        const manifestTimeout =
            this.manifest.capabilities.workspaceSymbol?.timeoutMs ?? 10_000;
        const effectiveTimeout = timeoutMs ?? manifestTimeout;

        // Poll until results appear or timeout
        const deadline = Date.now() + effectiveTimeout;
        while (Date.now() < deadline) {
            const result = await this._connection!.sendRequest('workspace/symbol', { query });
            if (Array.isArray(result) && result.length > 0) {
                return result as SymbolInfo[];
            }
            if (query === '') {
                // Empty query with no results means analysis is still running
                await new Promise((r) => setTimeout(r, 200));
            } else {
                // Non-empty query with no results → genuinely empty
                return [];
            }
        }
        return [];
    }

    // ---- Helpers ------------------------------------------------------------

    private _resolveCmd(): string[] {
        return this.manifest.server.cmd.map((part) =>
            part.replace('${pluginDir}', this.manifest.name)
        );
    }

    /** Returns true if this plugin handles the given file extension / language ID. */
    ownsFile(filePath: string): boolean {
        const lower = filePath.toLowerCase();
        return this.manifest.fileGlobs.some((glob) => {
            // Simple extension matching (e.g. "**/*.py" → ".py")
            const ext = glob.replace(/\*\*\/\*/, '');
            return lower.endsWith(ext);
        });
    }

    ownsLang(langId: string): boolean {
        return this.manifest.langIds.includes(langId);
    }
}
