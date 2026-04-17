"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.SymbolKind = exports.PluginManifestSchema = void 0;
exports.normalizeSymbol = normalizeSymbol;
/**
 * Shared types for meta-LSP MCP server.
 */
const zod_1 = require("zod");
// ---- Plugin manifest -------------------------------------------------------
const CapabilityFlagSchema = zod_1.z.object({
    stringPrefilter: zod_1.z.boolean().optional(),
    timeoutMs: zod_1.z.number().int().positive().optional(),
});
exports.PluginManifestSchema = zod_1.z.object({
    name: zod_1.z.string().min(1),
    version: zod_1.z.string(),
    langIds: zod_1.z.array(zod_1.z.string()).min(1),
    fileGlobs: zod_1.z.array(zod_1.z.string()).min(1),
    workspaceMarkers: zod_1.z.array(zod_1.z.string()).default([]),
    server: zod_1.z.object({
        cmd: zod_1.z.array(zod_1.z.string()).min(1),
        buildHook: zod_1.z.string().optional(),
        initOptions: zod_1.z.record(zod_1.z.unknown()).optional(),
    }),
    capabilities: zod_1.z.object({
        workspaceSymbol: CapabilityFlagSchema.optional(),
        implementations: CapabilityFlagSchema.optional(),
        callHierarchy: zod_1.z.boolean().optional(),
        didOpenDelayMs: zod_1.z.number().int().nonnegative().optional(),
    }).default({}),
    skills: zod_1.z.array(zod_1.z.string()).optional(),
    scripts: zod_1.z.array(zod_1.z.string()).optional(),
});
/** Normalized SymbolKind values (mirrors LSP spec). */
var SymbolKind;
(function (SymbolKind) {
    SymbolKind[SymbolKind["File"] = 1] = "File";
    SymbolKind[SymbolKind["Module"] = 2] = "Module";
    SymbolKind[SymbolKind["Namespace"] = 3] = "Namespace";
    SymbolKind[SymbolKind["Package"] = 4] = "Package";
    SymbolKind[SymbolKind["Class"] = 5] = "Class";
    SymbolKind[SymbolKind["Method"] = 6] = "Method";
    SymbolKind[SymbolKind["Property"] = 7] = "Property";
    SymbolKind[SymbolKind["Field"] = 8] = "Field";
    SymbolKind[SymbolKind["Constructor"] = 9] = "Constructor";
    SymbolKind[SymbolKind["Enum"] = 10] = "Enum";
    SymbolKind[SymbolKind["Interface"] = 11] = "Interface";
    SymbolKind[SymbolKind["Function"] = 12] = "Function";
    SymbolKind[SymbolKind["Variable"] = 13] = "Variable";
    SymbolKind[SymbolKind["Constant"] = 14] = "Constant";
    SymbolKind[SymbolKind["String"] = 15] = "String";
    SymbolKind[SymbolKind["Number"] = 16] = "Number";
    SymbolKind[SymbolKind["Boolean"] = 17] = "Boolean";
    SymbolKind[SymbolKind["Array"] = 18] = "Array";
    SymbolKind[SymbolKind["Object"] = 19] = "Object";
    SymbolKind[SymbolKind["Key"] = 20] = "Key";
    SymbolKind[SymbolKind["Null"] = 21] = "Null";
    SymbolKind[SymbolKind["EnumMember"] = 22] = "EnumMember";
    SymbolKind[SymbolKind["Struct"] = 23] = "Struct";
    SymbolKind[SymbolKind["Event"] = 24] = "Event";
    SymbolKind[SymbolKind["Operator"] = 25] = "Operator";
    SymbolKind[SymbolKind["TypeParameter"] = 26] = "TypeParameter";
})(SymbolKind || (exports.SymbolKind = SymbolKind = {}));
// ---- Shape normalization ---------------------------------------------------
const ZERO_RANGE = {
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
function normalizeSymbol(raw) {
    if (!raw || typeof raw !== 'object')
        return null;
    const r = raw;
    if (typeof r.name !== 'string' || typeof r.kind !== 'number')
        return null;
    const loc = r.location;
    if (!loc || typeof loc.uri !== 'string')
        return null;
    const range = isRange(loc.range) ? loc.range : ZERO_RANGE;
    const out = {
        name: r.name,
        kind: r.kind,
        location: { uri: loc.uri, range },
    };
    if (typeof r.containerName === 'string')
        out.containerName = r.containerName;
    return out;
}
function isPosition(val) {
    if (!val || typeof val !== 'object')
        return false;
    const p = val;
    return typeof p.line === 'number' && typeof p.character === 'number';
}
function isRange(val) {
    if (!val || typeof val !== 'object')
        return false;
    const r = val;
    return isPosition(r.start) && isPosition(r.end);
}
//# sourceMappingURL=types.js.map