import { existsSync, readdirSync, readFileSync, statSync } from 'fs';
import type { Dirent } from 'fs';
import path from 'path';
import { z } from 'zod';
import { PluginManifest, PluginManifestSchema } from './types';

export type SourceKind = 'builtin' | 'plugin-tree' | 'config-file' | 'manifests-dir';

export interface DiscoveredManifest {
    manifest: PluginManifest;
    sourceKind: SourceKind;
    sourcePath?: string;
}

const BUILTIN_DIR = path.resolve(__dirname, '../manifests');

/**
 * Read + JSON.parse + schema-validate a single manifest file. Returns the
 * DiscoveredManifest on success, or null on any failure (soft-skip with
 * stderr notice). Shared between `discoverFromJsonDir` (builtin,
 * manifests-dir) and `discoverPluginTreeManifests` (plugin-tree walker) so
 * error wording and schema semantics stay consistent across sources.
 */
function parseManifestFile(
    full: string,
    sourceKind: SourceKind
): DiscoveredManifest | null {
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(full, 'utf-8'));
    } catch (err) {
        process.stderr.write(
            `[lsp-mcp] failed to parse ${sourceKind} manifest ${full}: ${(err as Error).message} — skipping\n`
        );
        return null;
    }
    const parsed = PluginManifestSchema.safeParse(raw);
    if (!parsed.success) {
        process.stderr.write(
            `[lsp-mcp] ${sourceKind} manifest ${full} failed schema validation — skipping\n`
        );
        return null;
    }
    return {
        manifest: parsed.data,
        sourceKind,
        sourcePath: full,
    };
}

/**
 * Shared loader for JSON-manifest directories. Backs both the built-in
 * defaults and user-supplied `LSP_MCP_MANIFESTS_DIR`.
 *
 * Soft-skip policy (never throw from startup):
 *   - dir absent → stderr notice, return []
 *   - dir is a file, not a directory → stderr notice, return []
 *   - listing fails (EACCES on parent, FS error) → stderr notice, return []
 *
 * The statSync + readdirSync calls share a single try/catch. `statSync` can
 * throw EACCES independently of `existsSync` (overlay FS layers, parent dir
 * with `-x` stripped), so scoping the catch to `readdirSync` alone would miss
 * that failure mode.
 */
function discoverFromJsonDir(dir: string, sourceKind: SourceKind): DiscoveredManifest[] {
    if (!existsSync(dir)) {
        process.stderr.write(
            `[lsp-mcp] ${sourceKind} source: dir missing at ${dir} — skipping\n`
        );
        return [];
    }

    let entries: Dirent[];
    try {
        const st = statSync(dir);
        if (!st.isDirectory()) {
            process.stderr.write(
                `[lsp-mcp] ${sourceKind} source: path ${dir} is not a directory — skipping\n`
            );
            return [];
        }
        entries = readdirSync(dir, { withFileTypes: true });
    } catch (err) {
        process.stderr.write(
            `[lsp-mcp] ${sourceKind} source: could not read ${dir}: ${(err as Error).message} — skipping\n`
        );
        return [];
    }

    const files = entries
        .filter((e) => e.isFile() && e.name.endsWith('.json'))
        .map((e) => e.name)
        .sort();

    const out: DiscoveredManifest[] = [];
    for (const name of files) {
        const full = path.join(dir, name);
        const entry = parseManifestFile(full, sourceKind);
        if (entry) out.push(entry);
    }
    return out;
}

export function discoverBuiltinManifests(): DiscoveredManifest[] {
    return discoverFromJsonDir(BUILTIN_DIR, 'builtin');
}

export function discoverManifestsDir(dir: string): DiscoveredManifest[] {
    return discoverFromJsonDir(dir, 'manifests-dir');
}

interface VersionDir {
    name: string;
    fullPath: string;
    mtimeMs: number;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)/;

function parseSemverPrefix(name: string): [number, number, number] | null {
    const m = name.match(SEMVER_RE);
    return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/**
 * Given a plugin's version-dir entries, return the newest: semver-desc (when
 * parseable) beats hash; hash-only falls back to mtime-desc. Ties on the
 * chosen comparator break on name ascending so a second run is deterministic
 * even when filesystem mtime granularity collapses two hashes.
 */
function pickLatestVersion(versions: VersionDir[]): VersionDir | null {
    if (versions.length === 0) return null;
    const sorted = versions.slice().sort((a, b) => {
        const sa = parseSemverPrefix(a.name);
        const sb = parseSemverPrefix(b.name);
        if (sa && sb) {
            for (let i = 0; i < 3; i++) {
                if (sa[i] !== sb[i]) return sb[i] - sa[i];
            }
            return a.name.localeCompare(b.name);
        }
        if (sa) return -1;
        if (sb) return 1;
        if (b.mtimeMs !== a.mtimeMs) return b.mtimeMs - a.mtimeMs;
        return a.name.localeCompare(b.name);
    });
    return sorted[0];
}

/**
 * Discover sibling-plugin `lsp-manifest.json` files under Claude Code's
 * plugin cache. `cacheRoot` is expected to be the cache root —
 * `$CLAUDE_PLUGIN_ROOT/../../..` after resolve — so the layout inside is
 * `<mkt>/<plug>/<ver>/<contents>`.
 *
 * For each plugin (one per `<mkt>/<plug>` pair), the newest version dir is
 * picked (`pickLatestVersion`), then that version's contents are recursively
 * scanned for files named exactly `lsp-manifest.json`. Stale installs never
 * contribute.
 *
 * Per-layer try/catch: a broken marketplace/plugin/version dir (EACCES,
 * ENOENT mid-walk) soft-skips that subtree with a stderr notice and
 * continues. A single outer try/catch would drop every sibling on one bad
 * subdir — unacceptable.
 */
export function discoverPluginTreeManifests(cacheRoot: string): DiscoveredManifest[] {
    if (!existsSync(cacheRoot)) {
        process.stderr.write(
            `[lsp-mcp] plugin-tree source: cache root missing at ${cacheRoot} — skipping\n`
        );
        return [];
    }

    try {
        if (!statSync(cacheRoot).isDirectory()) {
            process.stderr.write(
                `[lsp-mcp] plugin-tree source: cache root ${cacheRoot} is not a directory — skipping\n`
            );
            return [];
        }
    } catch (err) {
        process.stderr.write(
            `[lsp-mcp] plugin-tree: cache root at ${cacheRoot} unreadable: ${(err as Error).message} — skipping\n`
        );
        return [];
    }

    let marketplaces: Dirent[];
    try {
        marketplaces = readdirSync(cacheRoot, { withFileTypes: true });
    } catch (err) {
        process.stderr.write(
            `[lsp-mcp] plugin-tree: cache root at ${cacheRoot} unreadable: ${(err as Error).message} — skipping\n`
        );
        return [];
    }

    const out: DiscoveredManifest[] = [];

    for (const mkt of marketplaces) {
        if (!mkt.isDirectory()) continue;
        const mktDir = path.join(cacheRoot, mkt.name);

        let plugins: Dirent[];
        try {
            plugins = readdirSync(mktDir, { withFileTypes: true });
        } catch (err) {
            process.stderr.write(
                `[lsp-mcp] plugin-tree: marketplace at ${mktDir} unreadable: ${(err as Error).message} — skipping\n`
            );
            continue;
        }

        for (const plug of plugins) {
            if (!plug.isDirectory()) continue;
            const plugDir = path.join(mktDir, plug.name);

            let versionEnts: Dirent[];
            try {
                versionEnts = readdirSync(plugDir, { withFileTypes: true });
            } catch (err) {
                process.stderr.write(
                    `[lsp-mcp] plugin-tree: plugin at ${plugDir} unreadable: ${(err as Error).message} — skipping\n`
                );
                continue;
            }

            const versions: VersionDir[] = [];
            for (const ve of versionEnts) {
                if (!ve.isDirectory()) continue;
                const full = path.join(plugDir, ve.name);
                try {
                    versions.push({
                        name: ve.name,
                        fullPath: full,
                        mtimeMs: statSync(full).mtimeMs,
                    });
                } catch {
                    // version dir vanished between listing and stat — skip.
                }
            }

            const winner = pickLatestVersion(versions);
            if (!winner) continue;

            let contents: Dirent[];
            try {
                contents = readdirSync(winner.fullPath, {
                    recursive: true,
                    withFileTypes: true,
                });
            } catch (err) {
                process.stderr.write(
                    `[lsp-mcp] plugin-tree: version scan at ${winner.fullPath} unreadable: ${(err as Error).message} — skipping\n`
                );
                continue;
            }

            const manifestPaths: string[] = [];
            for (const f of contents) {
                if (!f.isFile() || f.name !== 'lsp-manifest.json') continue;
                manifestPaths.push(path.join(f.parentPath, f.name));
            }
            manifestPaths.sort();

            for (const full of manifestPaths) {
                const entry = parseManifestFile(full, 'plugin-tree');
                if (entry) out.push(entry);
            }
        }
    }

    out.sort((a, b) => (a.sourcePath ?? '').localeCompare(b.sourcePath ?? ''));
    return out;
}

export function discoverConfigFileManifests(configPath: string): DiscoveredManifest[] {
    if (!existsSync(configPath)) {
        process.stderr.write(
            `lsp-mcp: no config file at ${configPath}; starting with zero config-file manifests. ` +
                `Set LSP_MCP_CONFIG to provide plugins.\n`
        );
        return [];
    }

    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(configPath, 'utf-8'));
    } catch (err) {
        process.stderr.write(`lsp-mcp: failed to parse config: ${(err as Error).message}\n`);
        process.exit(1);
    }

    if (!Array.isArray(raw)) {
        process.stderr.write(
            `lsp-mcp: config ${configPath} must be a JSON array of PluginManifest objects\n`
        );
        process.exit(1);
    }

    const parsed = z.array(PluginManifestSchema).safeParse(raw);
    if (!parsed.success) {
        process.stderr.write(
            `lsp-mcp: invalid config ${configPath}:\n${formatZodError(parsed.error)}\n`
        );
        process.exit(1);
    }

    return parsed.data.map((manifest) => ({
        manifest,
        sourceKind: 'config-file' as const,
        sourcePath: configPath,
    }));
}

function formatZodError(err: z.ZodError): string {
    return err.issues
        .map((i) => `  - ${i.path.join('.') || '<root>'}: ${i.message}`)
        .join('\n');
}

/**
 * Merge sources in priority order (low → high). Later sources override prior
 * entries of the same manifest name; each override emits a stderr log naming
 * both sources + paths. Map insertion order is preserved on `set`, so an
 * override keeps the original entry's registration slot — Router's
 * first-registered-wins primary selection stays stable across collisions.
 */
export function mergeDiscoveryPipeline(
    sources: DiscoveredManifest[][]
): DiscoveredManifest[] {
    const byName = new Map<string, DiscoveredManifest>();
    for (const batch of sources) {
        for (const discovered of batch) {
            const prior = byName.get(discovered.manifest.name);
            if (prior) {
                process.stderr.write(
                    `[lsp-mcp] manifest "${discovered.manifest.name}" from ${discovered.sourceKind} ` +
                        `(${discovered.sourcePath ?? '?'}) overrides prior ${prior.sourceKind} ` +
                        `(${prior.sourcePath ?? '?'}).\n`
                );
            }
            byName.set(discovered.manifest.name, discovered);
        }
    }
    return Array.from(byName.values());
}

/**
 * Normalize the raw `LSP_MCP_MANIFESTS_DIR` env value into an absolute path
 * or `undefined`. Empty strings are treated as unset — some shells set env
 * vars to `""` with `export LSP_MCP_MANIFESTS_DIR=`, and `path.resolve('')`
 * would return `process.cwd()`, scanning the working directory for JSON.
 * Relative paths are normalized against cwd; absolute paths pass through.
 */
export function resolveManifestsDirEnv(raw: string | undefined): string | undefined {
    return raw && raw.length > 0 ? path.resolve(raw) : undefined;
}

/**
 * Normalize the raw `CLAUDE_PLUGIN_ROOT` env value into the plugin cache
 * root, or `undefined` when unset. `$CLAUDE_PLUGIN_ROOT` resolves to
 * `<cache>/<marketplace>/<plugin>/<version>/` under CC's observed layout;
 * the 3-level walk (`../../..`) targets `<cache>/` so the plugin-tree walker
 * can see siblings from every marketplace, not just the current plugin's
 * own versions.
 *
 * The layout is undocumented by Anthropic (confirmed via `claude-code-guide`
 * on 2026-04-19). Accepted MVP coupling — if CC reshuffles the cache shape,
 * the walker emits a stderr notice and finds zero plugin-tree manifests
 * until a patch lands.
 *
 * Empty strings are treated as unset to avoid `path.resolve('', '../../..')`
 * landing at `cwd/../../..`.
 */
export function resolvePluginTreeEnv(raw: string | undefined): string | undefined {
    return raw && raw.length > 0 ? path.resolve(raw, '../../..') : undefined;
}

export function discoverManifests(opts: {
    configPath: string;
    pluginTreeRoot?: string;
    manifestsDir?: string;
}): DiscoveredManifest[] {
    const builtins = discoverBuiltinManifests();
    const pluginTree = opts.pluginTreeRoot
        ? discoverPluginTreeManifests(opts.pluginTreeRoot)
        : [];
    const configFile = discoverConfigFileManifests(opts.configPath);
    const manifestsDir = opts.manifestsDir ? discoverManifestsDir(opts.manifestsDir) : [];
    return mergeDiscoveryPipeline([builtins, pluginTree, configFile, manifestsDir]);
}
