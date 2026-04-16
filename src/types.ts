/**
 * Shared types for meta-LSP MCP server.
 */

// ---- Plugin manifest -------------------------------------------------------

export interface PluginManifest {
    /** Unique plugin name (e.g. "pyright", "zls") */
    name: string;
    version: string;
    /** LSP language IDs this plugin handles (e.g. ["python"]) */
    langIds: string[];
    /** Glob patterns that identify files owned by this plugin */
    fileGlobs: string[];
    /** File/dir names that mark a project root for this language */
    workspaceMarkers: string[];
    server: {
        /** Command array to spawn the LSP server; ${pluginDir} is expanded */
        cmd: string[];
        /** Optional shell script to run on first use to build the server */
        buildHook?: string;
        /** Passed as LSP initializationOptions */
        initOptions?: Record<string, unknown>;
    };
    capabilities: {
        workspaceSymbol?: { stringPrefilter: boolean; timeoutMs?: number };
        implementations?: { stringPrefilter: boolean };
        callHierarchy?: boolean;
        didOpenDelayMs?: number;
    };
    /** Paths to skill directories */
    skills?: string[];
    /** Paths to script directories */
    scripts?: string[];
}

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