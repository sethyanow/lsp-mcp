import { accessSync, constants, statSync } from 'fs';
import * as path from 'path';

import type { DiscoveredManifest } from './discover.js';

/**
 * Result of probing a binary against PATH or checking an absolute path directly.
 */
export type ProbeStatus = 'ok' | 'binary_not_found';

/**
 * Discovered manifest paired with the PATH-probe result for its `cmd[0]`.
 * `probeAll` returns this shape; `formatMissingBinarySummary` consumes it.
 */
export type ProbedManifest = DiscoveredManifest & { status: ProbeStatus };

/**
 * Resolve `cmd` against PATH. Returns 'ok' if a matching executable file
 * exists (and is not a directory), 'binary_not_found' otherwise.
 *
 * - Absolute paths are checked directly via `accessSync(X_OK)` and must be
 *   regular files (`statSync.isFile()` — POSIX `X_OK` on a directory means
 *   traversable, so without this gate dirs would pass).
 * - Bare names are resolved by walking `process.env.PATH`, with Windows
 *   PATHEXT (`.EXE .CMD .BAT .COM` by default) supplying candidate
 *   extensions. POSIX uses the bare name (empty-string extension).
 * - Empty `cmd` short-circuits to `binary_not_found`; it otherwise falls
 *   through the bare-name branch and joins with every PATH directory,
 *   potentially matching directories as "executables".
 *
 * Pure filesystem probe — no process spawn.
 */
export function probeBinaryOnPath(cmd: string): ProbeStatus {
    if (!cmd) return 'binary_not_found';

    if (path.isAbsolute(cmd)) {
        return checkExecutableFile(cmd);
    }

    const pathEntries = (process.env.PATH ?? '')
        .split(path.delimiter)
        .filter((segment) => segment.length > 0);
    const extensions = getPathExtensions();

    for (const dir of pathEntries) {
        for (const ext of extensions) {
            const candidate = path.join(dir, cmd + ext);
            if (checkExecutableFile(candidate) === 'ok') return 'ok';
        }
    }
    return 'binary_not_found';
}

/**
 * Succeeds only when `p` exists, is accessible with `X_OK`, and is a regular
 * file. On POSIX, `X_OK` on a directory tests the traversal bit and returns
 * true — this gate rejects that. On Windows, Node maps `X_OK` to `R_OK`,
 * which directories also satisfy; same gate applies. `statSync` is wrapped
 * in its own try/catch so an unlink race between `accessSync` and `statSync`
 * reports `binary_not_found` rather than throwing.
 */
function checkExecutableFile(p: string): ProbeStatus {
    try {
        accessSync(p, constants.X_OK);
    } catch {
        return 'binary_not_found';
    }
    try {
        if (!statSync(p).isFile()) return 'binary_not_found';
    } catch {
        return 'binary_not_found';
    }
    return 'ok';
}

function getPathExtensions(): readonly string[] {
    if (process.platform !== 'win32') return [''];
    const raw = process.env.PATHEXT ?? '.EXE;.CMD;.BAT;.COM';
    return raw.split(';').filter((ext) => ext.length > 0);
}

/**
 * Attach a `status` field to each discovered manifest by probing its
 * `cmd[0]` against PATH. Does not spawn processes; pure filesystem check.
 */
export function probeAll(discovered: DiscoveredManifest[]): ProbedManifest[] {
    return discovered.map((d) => ({
        ...d,
        status: probeBinaryOnPath(d.manifest.server.cmd[0]),
    }));
}

/**
 * Build the observability stderr line describing which manifests failed the
 * PATH probe. Returns `undefined` when every entry is `ok`. Names are
 * alphabetically sorted for deterministic output. Uses singular ("1 manifest
 * has") when exactly one is missing, plural otherwise.
 */
export function formatMissingBinarySummary(probed: ProbedManifest[]): string | undefined {
    const missing = probed
        .filter((p) => p.status === 'binary_not_found')
        .map((p) => p.manifest.name)
        .sort();
    if (missing.length === 0) return undefined;
    const verb = missing.length === 1 ? 'manifest has' : 'manifests have';
    return `[lsp-mcp] ${missing.length} ${verb} binary_not_found: ${missing.join(', ')}`;
}

