import { spawn, spawnSync, ChildProcess } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import {
    createMessageConnection,
    MessageConnection,
    RequestType,
    StreamMessageReader,
    StreamMessageWriter,
} from 'vscode-jsonrpc/node';
import { minimatch } from 'minimatch';
import { normalizeSymbol } from './types.js';
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
    private _pluginsDir: string;
    private _builtOnce = false;
    private _warm = false;
    private _resolvedRootUri: string | null = null;

    constructor(manifest: PluginManifest, workspaceRoot: string, pluginsDir: string) {
        this.manifest = manifest;
        this._workspaceRoot = workspaceRoot;
        this._pluginsDir = pluginsDir;
    }

    // ---- Lifecycle ----------------------------------------------------------

    /** Ensure the server process is running and initialized. Idempotent.
     *  If a previous start attempt failed, calling this again will retry. */
    async ensureRunning(): Promise<void> {
        if (this._initDone) return;
        if (this._initPromise) return this._initPromise;

        this._initPromise = this._start().catch((err: unknown) => {
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
        if (this.manifest.server.buildHook && !this._builtOnce) {
            this._runBuildHook();
            this._builtOnce = true;
        }

        const [cmd, ...args] = this._resolveCmd();

        const proc = spawn(cmd, args, {
            cwd: this._workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
        });

        proc.stdin!.on('error', () => {});
        proc.stdout!.on('error', () => {});
        proc.stderr!.on('error', () => {});
        this._pipeStderr(proc);

        this._process = proc;

        const conn = createMessageConnection(
            new StreamMessageReader(proc.stdout!),
            new StreamMessageWriter(proc.stdin!)
        );
        conn.listen();
        this._connection = conn;

        const rootDir = findRoot(this._workspaceRoot, this.manifest.workspaceMarkers ?? []);
        const rootUri = pathToFileURL(rootDir).toString();
        this._resolvedRootUri = rootUri;
        const workspaceName = path.basename(rootDir) || 'workspace';

        const initParams = {
            processId: process.pid,
            rootUri,
            rootPath: rootDir,
            workspaceFolders: [{ uri: rootUri, name: workspaceName }],
            capabilities: {
                textDocument: {
                    implementation: { dynamicRegistration: false },
                    inlayHint: { dynamicRegistration: false },
                    codeLens: { dynamicRegistration: false },
                    callHierarchy: { dynamicRegistration: false },
                },
                workspace: {
                    symbol: { dynamicRegistration: false },
                    workspaceFolders: true,
                },
            },
            initializationOptions: this.manifest.server.initOptions ?? {},
        };

        // Guard initialize against premature child exit and spawn errors,
        // both of which leave sendRequest hanging forever.
        const onExit = (code: number | null, signal: NodeJS.Signals | null) =>
            exitReject(
                new Error(
                    `LSP server "${this.manifest.name}" exited before initialize ` +
                        `(code=${code}, signal=${signal})`
                )
            );
        const onSpawnError = (err: Error) =>
            exitReject(new Error(`failed to spawn "${this.manifest.name}": ${err.message}`));
        let exitReject: (err: Error) => void = () => {};
        const exitPromise = new Promise<never>((_, reject) => {
            exitReject = reject;
        });
        proc.once('exit', onExit);
        proc.once('error', onSpawnError);

        try {
            await Promise.race([conn.sendRequest('initialize', initParams), exitPromise]);
        } finally {
            proc.removeListener('exit', onExit);
            proc.removeListener('error', onSpawnError);
        }

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
        this._openedUris.clear();
        this._warm = false;
    }

    /** Force-kill the child process without waiting for a graceful LSP exit. */
    forceKill(): void {
        try {
            this._connection?.dispose();
        } catch {
            // ignore
        }
        this._connection = null;
        this._process?.kill('SIGKILL');
        this._process = null;
        this._initDone = false;
        this._initPromise = null;
        this._openedUris.clear();
        this._warm = false;
    }

    // ---- Request forwarding -------------------------------------------------

    /**
     * Send a raw LSP request. Ensures the server is running first.
     * @param timeoutMs Maximum time to wait (default: 30 000 ms).
     */
    async request(
        method: string,
        params: unknown,
        timeoutMs = 30_000
    ): Promise<unknown> {
        await this.ensureRunning();
        const conn = this._connection!;

        const requestType = new RequestType<unknown, unknown, void>(method);
        let timerId: NodeJS.Timeout;
        return Promise.race([
            conn.sendRequest(requestType, params).finally(() => clearTimeout(timerId)),
            new Promise<never>((_, reject) => {
                timerId = setTimeout(
                    () => reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`)),
                    timeoutMs
                );
            }),
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
            let filePath: string;
            try {
                filePath = fileURLToPath(uri);
            } catch {
                return false;
            }
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
     * Poll workspace/symbol with an empty query until the server returns at
     * least one result (or `retries` is exhausted). Used as a warm-up signal:
     * once any symbols come back, the background index has advanced enough
     * that a real query won't give a cold-cache false-negative.
     */
    async waitForAnalysis(retries = 50, intervalMs = 200): Promise<boolean> {
        await this.ensureRunning();
        for (let i = 0; i < retries; i++) {
            const probe = await this._connection!.sendRequest('workspace/symbol', { query: '' });
            if (Array.isArray(probe) && probe.length > 0) {
                this._warm = true;
                return true;
            }
            await new Promise((r) => setTimeout(r, intervalMs));
        }
        return false;
    }

    /**
     * workspace/symbol with cold-cache discipline.
     *
     * If this server hasn't been warmed yet, first polls with an empty query
     * until results appear (indicating the background index has produced
     * symbols), then issues the real query. Once warm, subsequent calls skip
     * the warm-up.
     */
    async workspaceSymbol(
        query: string,
        timeoutMs?: number
    ): Promise<SymbolInfo[]> {
        await this.ensureRunning();
        const manifestTimeout =
            this.manifest.capabilities.workspaceSymbol?.timeoutMs ?? 10_000;
        const effectiveTimeout = timeoutMs ?? manifestTimeout;
        const deadline = Date.now() + effectiveTimeout;

        if (!this._warm) {
            const retries = Math.max(1, Math.floor(effectiveTimeout / 200));
            await this.waitForAnalysis(retries, 200);
            // Fall through even if warm-up didn't find anything — the caller's
            // query might still return results, and we don't want to hang past
            // the deadline.
        }

        const remaining = Math.max(200, deadline - Date.now());
        const raw = await this.request('workspace/symbol', { query }, remaining);
        if (!Array.isArray(raw)) return [];
        const out: SymbolInfo[] = [];
        for (const entry of raw) {
            const sym = normalizeSymbol(entry);
            if (sym) out.push(sym);
        }
        if (out.length > 0) this._warm = true;
        return out;
    }

    // ---- Helpers ------------------------------------------------------------

    get defaultLangId(): string {
        return this.manifest.langIds[0] ?? 'plaintext';
    }

    get resolvedRootUri(): string | null {
        return this._resolvedRootUri;
    }

    /** Substitute `${pluginDir}` in each cmd part with the absolute plugin path. */
    private _resolveCmd(): string[] {
        return this.manifest.server.cmd.map((part) => this._expandPluginDir(part));
    }

    private _expandPluginDir(s: string): string {
        const pluginDir = path.join(this._pluginsDir, this.manifest.name);
        return s.replace(/\$\{pluginDir\}/g, pluginDir);
    }

    private _runBuildHook(): void {
        const hook = this.manifest.server.buildHook;
        if (!hook) return;
        const resolved = this._expandPluginDir(hook);
        const pluginDir = path.join(this._pluginsDir, this.manifest.name);
        const result = spawnSync('sh', ['-c', resolved], {
            cwd: existsSync(pluginDir) ? pluginDir : this._workspaceRoot,
            env: { ...process.env, LSP_MCP_PLUGIN_DIR: pluginDir },
            stdio: 'inherit',
        });
        if (result.status !== 0) {
            throw new Error(
                `buildHook for plugin "${this.manifest.name}" exited with status ${result.status}`
            );
        }
    }

    private _pipeStderr(proc: ChildProcess): void {
        const prefix = `[${this.manifest.name}] `;
        let buf = '';
        proc.stderr!.setEncoding('utf-8');
        proc.stderr!.on('data', (chunk: string) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.length > 0) process.stderr.write(prefix + line + '\n');
            }
        });
        proc.stderr!.on('end', () => {
            if (buf.length > 0) process.stderr.write(prefix + buf + '\n');
        });
    }

    /** Returns true if this plugin handles the given file path. */
    ownsFile(filePath: string): boolean {
        return this.manifest.fileGlobs.some((glob) =>
            minimatch(filePath, glob, { nocase: true, dot: true })
        );
    }

    ownsLang(langId: string): boolean {
        return this.manifest.langIds.includes(langId);
    }
}

// ---- Helpers ---------------------------------------------------------------

/**
 * Walk up from `startDir` looking for any entry in `markers`. Returns the
 * first directory that contains a marker, or `startDir` if none is found.
 */
export function findRoot(startDir: string, markers: string[]): string {
    if (markers.length === 0) return startDir;
    let dir = path.resolve(startDir);
    const { root } = path.parse(dir);
    while (true) {
        for (const m of markers) {
            if (existsSync(path.join(dir, m))) return dir;
        }
        if (dir === root) return startDir;
        dir = path.dirname(dir);
    }
}
