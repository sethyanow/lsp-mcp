"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.LspServer = void 0;
exports.findRoot = findRoot;
const child_process_1 = require("child_process");
const fs_1 = require("fs");
const path_1 = __importDefault(require("path"));
const url_1 = require("url");
const node_1 = require("vscode-jsonrpc/node");
const minimatch_1 = require("minimatch");
const types_js_1 = require("./types.js");
/**
 * Persistent JSON-RPC bridge for a single LSP server process.
 * Spawns the server, runs LSP initialize, and keeps the connection alive
 * across many requests (warm-cache after first query).
 */
class LspServer {
    constructor(manifest, workspaceRoot, pluginsDir) {
        this._process = null;
        this._connection = null;
        this._initDone = false;
        this._initPromise = null;
        this._openedUris = new Set();
        this._builtOnce = false;
        this._warmupAttempted = false;
        this._resolvedRootUri = null;
        this.manifest = manifest;
        this._workspaceRoot = workspaceRoot;
        this._pluginsDir = pluginsDir;
    }
    // ---- Lifecycle ----------------------------------------------------------
    /** Ensure the server process is running and initialized. Idempotent.
     *  If a previous start attempt failed, calling this again will retry. */
    async ensureRunning() {
        if (this._initDone)
            return;
        if (this._initPromise)
            return this._initPromise;
        this._initPromise = this._start().catch((err) => {
            this._initPromise = null;
            this._connection?.dispose();
            this._connection = null;
            this._process?.kill();
            this._process = null;
            throw err;
        });
        return this._initPromise;
    }
    async _start() {
        if (this.manifest.server.buildHook && !this._builtOnce) {
            this._runBuildHook();
            this._builtOnce = true;
        }
        const [cmd, ...args] = this._resolveCmd();
        const proc = (0, child_process_1.spawn)(cmd, args, {
            cwd: this._workspaceRoot,
            stdio: ['pipe', 'pipe', 'pipe'],
        });
        proc.stdin.on('error', () => { });
        proc.stdout.on('error', () => { });
        proc.stderr.on('error', () => { });
        this._pipeStderr(proc);
        this._process = proc;
        const conn = (0, node_1.createMessageConnection)(new node_1.StreamMessageReader(proc.stdout), new node_1.StreamMessageWriter(proc.stdin));
        conn.listen();
        this._connection = conn;
        const rootDir = findRoot(this._workspaceRoot, this.manifest.workspaceMarkers ?? []);
        const rootUri = (0, url_1.pathToFileURL)(rootDir).toString();
        this._resolvedRootUri = rootUri;
        const workspaceName = path_1.default.basename(rootDir) || 'workspace';
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
        const onExit = (code, signal) => exitReject(new Error(`LSP server "${this.manifest.name}" exited before initialize ` +
            `(code=${code}, signal=${signal})`));
        const onSpawnError = (err) => exitReject(new Error(`failed to spawn "${this.manifest.name}": ${err.message}`));
        let exitReject = () => { };
        const exitPromise = new Promise((_, reject) => {
            exitReject = reject;
        });
        proc.once('exit', onExit);
        proc.once('error', onSpawnError);
        try {
            await Promise.race([conn.sendRequest('initialize', initParams), exitPromise]);
        }
        finally {
            proc.removeListener('exit', onExit);
            proc.removeListener('error', onSpawnError);
        }
        conn.sendNotification('initialized', {});
        this._initDone = true;
    }
    /** Gracefully shut down the LSP server. */
    async shutdown() {
        if (!this._connection)
            return;
        try {
            await this._connection.sendRequest('shutdown');
            this._connection.sendNotification('exit');
        }
        catch {
            // ignore
        }
        this._connection.dispose();
        this._connection = null;
        await new Promise((r) => setImmediate(r));
        this._process?.kill();
        this._process = null;
        this._initDone = false;
        this._initPromise = null;
        this._openedUris.clear();
        this._warmupAttempted = false;
    }
    /** Force-kill the child process without waiting for a graceful LSP exit. */
    forceKill() {
        try {
            this._connection?.dispose();
        }
        catch {
            // ignore
        }
        this._connection = null;
        this._process?.kill('SIGKILL');
        this._process = null;
        this._initDone = false;
        this._initPromise = null;
        this._openedUris.clear();
        this._warmupAttempted = false;
    }
    // ---- Request forwarding -------------------------------------------------
    /**
     * Send a raw LSP request. Ensures the server is running first.
     * @param timeoutMs Maximum time to wait (default: 30 000 ms).
     */
    async request(method, params, timeoutMs = 30000) {
        await this.ensureRunning();
        const conn = this._connection;
        const requestType = new node_1.RequestType(method);
        let timerId;
        try {
            return await Promise.race([
                conn.sendRequest(requestType, params).finally(() => clearTimeout(timerId)),
                new Promise((_, reject) => {
                    timerId = setTimeout(() => reject(new Error(`LSP request timed out after ${timeoutMs}ms: ${method}`)), timeoutMs);
                }),
            ]);
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            throw new Error(`[${this.manifest.name}] ${msg}`);
        }
    }
    /**
     * Send textDocument/didOpen if the URI hasn't been opened yet.
     * This triggers full type-checking in servers that need it.
     * Returns true if the document was newly opened, false if it was already open.
     */
    async openDocument(uri, languageId) {
        if (this._openedUris.has(uri))
            return false;
        await this.ensureRunning();
        const conn = this._connection;
        if (uri.startsWith('file://')) {
            let filePath;
            try {
                filePath = (0, url_1.fileURLToPath)(uri);
            }
            catch {
                return false;
            }
            let text;
            try {
                text = (0, fs_1.readFileSync)(filePath, 'utf-8');
            }
            catch {
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
    async waitForAnalysis(retries = 50, intervalMs = 200, probeTimeoutMs = 2000, deadlineMs = Infinity) {
        await this.ensureRunning();
        try {
            for (let i = 0; i < retries; i++) {
                const now = Date.now();
                if (now >= deadlineMs)
                    return false;
                const probeBudget = Math.min(probeTimeoutMs, deadlineMs - now);
                try {
                    const probe = await this.request('workspace/symbol', { query: '' }, probeBudget);
                    if (Array.isArray(probe) && probe.length > 0)
                        return true;
                }
                catch {
                    // Probe timed out or errored — keep polling until the
                    // retry budget or deadline is exhausted.
                }
                const sleepBudget = Math.min(intervalMs, deadlineMs - Date.now());
                if (sleepBudget <= 0)
                    return false;
                await new Promise((r) => setTimeout(r, sleepBudget));
            }
            return false;
        }
        finally {
            // Flip regardless of outcome. An empty workspace or a server
            // that never responds to query: '' should not pay the full
            // warm-up budget on every subsequent call.
            this._warmupAttempted = true;
        }
    }
    /**
     * workspace/symbol with cold-cache discipline.
     *
     * If this server hasn't been warmed yet, first polls with an empty query
     * until results appear (indicating the background index has produced
     * symbols), then issues the real query. Once warm, subsequent calls skip
     * the warm-up.
     */
    async workspaceSymbol(query, timeoutMs) {
        await this.ensureRunning();
        const manifestTimeout = this.manifest.capabilities.workspaceSymbol?.timeoutMs ?? 10000;
        const effectiveTimeout = timeoutMs ?? manifestTimeout;
        const deadline = Date.now() + effectiveTimeout;
        if (!this._warmupAttempted) {
            // Reserve a minimum slice of the budget for the real query so
            // warm-up can't consume the entire timeout on a stalled server.
            const reserved = Math.min(1000, Math.floor(effectiveTimeout / 4));
            const warmupDeadline = deadline - reserved;
            const retries = Math.max(1, Math.floor(effectiveTimeout / 200));
            const probeCap = Math.min(1000, effectiveTimeout);
            await this.waitForAnalysis(retries, 200, probeCap, warmupDeadline);
            // Fall through even if warm-up didn't find anything — the caller's
            // query might still return results, and we don't want to hang past
            // the deadline.
        }
        const remaining = Math.max(200, deadline - Date.now());
        const raw = await this.request('workspace/symbol', { query }, remaining);
        if (!Array.isArray(raw))
            return [];
        const out = [];
        for (const entry of raw) {
            const sym = (0, types_js_1.normalizeSymbol)(entry);
            if (sym)
                out.push(sym);
        }
        return out;
    }
    // ---- Helpers ------------------------------------------------------------
    get defaultLangId() {
        return this.manifest.langIds[0] ?? 'plaintext';
    }
    get resolvedRootUri() {
        return this._resolvedRootUri;
    }
    /** Substitute `${pluginDir}` in each cmd part with the absolute plugin path. */
    _resolveCmd() {
        return this.manifest.server.cmd.map((part) => this._expandPluginDir(part));
    }
    _expandPluginDir(s) {
        const pluginDir = path_1.default.join(this._pluginsDir, this.manifest.name);
        return s.replace(/\$\{pluginDir\}/g, pluginDir);
    }
    _runBuildHook() {
        const hook = this.manifest.server.buildHook;
        if (!hook)
            return;
        const resolved = this._expandPluginDir(hook);
        const pluginDir = path_1.default.join(this._pluginsDir, this.manifest.name);
        // shell: true runs the command via the platform's default shell
        // (/bin/sh on POSIX, cmd.exe on Windows), keeping plugins portable.
        const result = (0, child_process_1.spawnSync)(resolved, {
            shell: true,
            cwd: (0, fs_1.existsSync)(pluginDir) ? pluginDir : this._workspaceRoot,
            env: { ...process.env, LSP_MCP_PLUGIN_DIR: pluginDir },
            // Redirect stdout to stderr so hook output (e.g. `npm install`
            // progress) can never interleave with JSON-RPC frames on the
            // parent's stdout — that's the MCP transport.
            stdio: ['ignore', 2, 2],
        });
        if (result.error) {
            throw new Error(`buildHook for plugin "${this.manifest.name}" failed to launch: ${result.error.message}`);
        }
        if (result.status !== 0) {
            const detail = result.status === null ? `signal ${result.signal}` : `status ${result.status}`;
            throw new Error(`buildHook for plugin "${this.manifest.name}" exited with ${detail}`);
        }
    }
    _pipeStderr(proc) {
        const prefix = `[${this.manifest.name}] `;
        let buf = '';
        proc.stderr.setEncoding('utf-8');
        proc.stderr.on('data', (chunk) => {
            buf += chunk;
            let idx;
            while ((idx = buf.indexOf('\n')) !== -1) {
                const line = buf.slice(0, idx);
                buf = buf.slice(idx + 1);
                if (line.length > 0)
                    process.stderr.write(prefix + line + '\n');
            }
        });
        proc.stderr.on('end', () => {
            if (buf.length > 0)
                process.stderr.write(prefix + buf + '\n');
        });
    }
    /** Returns true if this plugin handles the given file path. */
    ownsFile(filePath) {
        return this.manifest.fileGlobs.some((glob) => (0, minimatch_1.minimatch)(filePath, glob, { nocase: true, dot: true }));
    }
    ownsLang(langId) {
        return this.manifest.langIds.includes(langId);
    }
}
exports.LspServer = LspServer;
// ---- Helpers ---------------------------------------------------------------
/**
 * Walk up from `startDir` looking for any entry in `markers`. Returns the
 * first directory that contains a marker, or `startDir` if none is found.
 */
function findRoot(startDir, markers) {
    if (markers.length === 0)
        return startDir;
    let dir = path_1.default.resolve(startDir);
    const { root } = path_1.default.parse(dir);
    while (true) {
        for (const m of markers) {
            if ((0, fs_1.existsSync)(path_1.default.join(dir, m)))
                return dir;
        }
        if (dir === root)
            return startDir;
        dir = path_1.default.dirname(dir);
    }
}
//# sourceMappingURL=lsp-server.js.map