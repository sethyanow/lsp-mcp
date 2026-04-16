/**
 * Shared types for meta-LSP MCP server.
 */
import { z } from 'zod';

// ---- Plugin manifest -------------------------------------------------------

const CapabilityFlagSchema = z.object({
    stringPrefilter: z.boolean(),
    timeoutMs: z.number().int().positive().optional(),
});

export const PluginManifestSchema = z.object({
    name: z.string().min(1),
    version: z.string(),
    langIds: z.array(z.string()).min(1),
    fileGlobs: z.array(z.string()).min(1),
    workspaceMarkers: z.array(z.string()).default([]),
    server: z.object({
        cmd: z.array(z.string()).min(1),
        buildHook: z.string().optional(),
        initOptions: z.record(z.unknown()).optional(),
    }),
    capabilities: z.object({
        workspaceSymbol: CapabilityFlagSchema.optional(),
        implementations: CapabilityFlagSchema.optional(),
        callHierarchy: z.boolean().optional(),
        didOpenDelayMs: z.number().int().nonnegative().optional(),
    }).default({}),
    skills: z.array(z.string()).optional(),
    scripts: z.array(z.string()).optional(),
});

export type PluginManifest = z.infer<typeof PluginManifestSchema>;

// ---- LSP primitive types ---------------------------------------------------

export interface Position {
    line: number;
    character: number;
}

export interface Range {
    start: Position;
    end: Position;
}

export interface Location {
    uri: string;
    range: Range;
}

/** Normalized SymbolKind values (mirrors LSP spec). */
export enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
}

export interface SymbolInfo {
    name: string;
    kind: SymbolKind;
    location: Location;
    containerName?: string;
}

export interface DiagnosticInfo {
    range: Range;
    severity?: number;
    code?: string | number;
    source?: string;
    message: string;
}

// ---- Shape normalization ---------------------------------------------------

const ZERO_RANGE: Range = {
    start: { line: 0, character: 0 },
    end: { line: 0, character: 0 },
};

/**
 * Normalize a raw entry from `workspace/symbol` into `SymbolInfo`.
 *
 * Handles both LSP response shapes:
 *   - `SymbolInformation`: flat, with required `location.range`.
 *   - `WorkspaceSymbol`: newer, with `location.range` optional.
 *
 * Returns null for entries that fail the basic shape check so callers can
 * skip them without crashing on `dedupeKey`.
 */
export function normalizeSymbol(raw: unknown): SymbolInfo | null {
    if (!raw || typeof raw !== 'object') return null;
    const r = raw as Record<string, unknown>;
    if (typeof r.name !== 'string' || typeof r.kind !== 'number') return null;
    const loc = r.location as Record<string, unknown> | undefined;
    if (!loc || typeof loc.uri !== 'string') return null;
    const range = (loc.range as Range | undefined) ?? ZERO_RANGE;
    const out: SymbolInfo = {
        name: r.name,
        kind: r.kind as SymbolKind,
        location: { uri: loc.uri, range },
    };
    if (typeof r.containerName === 'string') out.containerName = r.containerName;
    return out;
}
