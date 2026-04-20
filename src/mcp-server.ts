import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Router } from './router.js';

/**
 * Either a `z.enum([...])` over the given values, or a plain `z.string()`
 * when the list is empty (zod's `z.enum([])` throws). Empty-list fallback
 * preserves callability of the tool but drops the enum hint.
 */
function enumOrString(
    values: string[]
): z.ZodString | z.ZodEnum<[string, ...string[]]> {
    return values.length > 0
        ? z.enum(values as [string, ...string[]])
        : z.string();
}

/**
 * Build per-router schemas whose enum values reflect the router's currently
 * active manifest set. Called once at `createMcpServer` time; the resulting
 * schemas are wired into `registerTool` calls. Schemas are STABLE across
 * `set_primary` swaps — the swap mutates which candidate is primary, not
 * the membership of active langs / ok manifests.
 *
 * Empty-list fallback: zod's `z.enum([])` throws, so when the router has
 * zero active langs (or zero ok manifests), the corresponding schema falls
 * back to plain `z.string()`. Tools remain callable; clients just don't see
 * the enum hint and the runtime router validation (R5/R7) still rejects
 * unknown names.
 */
function buildDynamicSchemas(router: Router): {
    LangEnum: z.ZodString | z.ZodEnum<[string, ...string[]]>;
    LangsSchema: z.ZodOptional<z.ZodArray<z.ZodString | z.ZodEnum<[string, ...string[]]>>>;
    ManifestEnum: z.ZodString | z.ZodEnum<[string, ...string[]]>;
    ManifestsSchema: z.ZodOptional<z.ZodArray<z.ZodString | z.ZodEnum<[string, ...string[]]>>>;
    ViaSchema: z.ZodOptional<z.ZodString | z.ZodEnum<[string, ...string[]]>>;
} {
    const okLangs = Array.from(
        new Set(
            router
                .listLanguages()
                .filter((row) => row.status === 'ok')
                .map((row) => row.lang)
        )
    );
    const okManifestNames = router.entries
        .filter((e) => e.status === 'ok')
        .map((e) => e.manifest.name);
    const langItem = enumOrString(okLangs);
    const manifestItem = enumOrString(okManifestNames);

    return {
        LangEnum: langItem,
        LangsSchema: z.array(langItem).optional(),
        ManifestEnum: manifestItem,
        ManifestsSchema: z.array(manifestItem).optional(),
        ViaSchema: manifestItem
            .describe('Manifest name to target (overrides primary routing).')
            .optional(),
    };
}

const PositionSchema = z.object({
    line: z.number().int().min(0).describe('0-based line number'),
    character: z.number().int().min(0).describe('0-based character offset'),
});

const FileUriSchema = z
    .string()
    .refine(
        (s) => {
            try {
                const u = new URL(s);
                return (
                    u.protocol === 'file:' &&
                    (u.hostname === '' || u.hostname === 'localhost')
                );
            } catch {
                return false;
            }
        },
        { message: 'must be a local file:// URI (e.g. "file:///abs/path/to/file.py")' },
    )
    .describe('File URI (e.g. "file:///abs/path/to/file.py")');

const LspParamsSchema = z
    .union([z.record(z.any()), z.array(z.any()), z.null()])
    .describe('JSON-RPC params (object, array, or null)');

/**
 * Create the meta-LSP MCP server.
 * All tools delegate to the router which fans requests to the appropriate
 * configured LSP server(s).
 *
 * Tool surface:
 *   symbol_search — fans workspace/symbol across all (or selected) servers
 *   defs          — go-to-definition
 *   refs          — find references
 *   impls         — find implementations
 *   hover         — type info / signature
 *   outline       — document symbols
 *   diagnostics   — errors / warnings for a file
 *   lsp           — raw passthrough (escape hatch)
 *
 * Tools gated on at least one manifest declaring `capabilities.callHierarchy`:
 *   call_hierarchy_prepare, incoming_calls, outgoing_calls
 */
export function createMcpServer(router: Router): McpServer {
    const server = new McpServer({
        name: 'lsp-mcp',
        version: '0.1.0',
    });

    const schemas = buildDynamicSchemas(router);

    // ---- symbol_search -------------------------------------------------------

    server.registerTool(
        'symbol_search',
        {
            description:
                'Search for symbols (classes, functions, variables, etc.) across all configured ' +
                'language servers. Fans workspace/symbol across servers, merges and dedupes ' +
                'results. This is the primary entry point for cross-language code navigation.',
            inputSchema: {
                name: z.string().describe('Symbol name to search for (supports partial matches)'),
                kind: z
                    .string()
                    .optional()
                    .describe(
                        'Filter by symbol kind (e.g. "class", "function", "variable"). Optional.'
                    ),
                langs: schemas.LangsSchema.describe(
                    'Restrict search to specific language IDs (e.g. ["python", "typescript"]). ' +
                        'Omit to search all configured languages.'
                ),
                manifests: schemas.ManifestsSchema.describe(
                    'Restrict search to specific manifest names (overrides primary-only fan-out).'
                ),
            },
        },
        async ({ name, kind, langs, manifests }) => {
            try {
                const symbols = await router.symbolSearch(name, langs, manifests);
                const normalized = symbols.map((s) => ({
                    ...s,
                    kind: symbolKindName(s.kind),
                }));
                const filtered = kind
                    ? normalized.filter(
                          (s) =>
                              typeof s.kind === 'string' &&
                              s.kind.toLowerCase() === kind.toLowerCase()
                      )
                    : normalized;

                return jsonResult(filtered);
            } catch (err) {
                return toolError('symbol_search', err);
            }
        }
    );

    // ---- list_languages ------------------------------------------------------

    server.registerTool(
        'list_languages',
        {
            description:
                'Enumerate every (lang, manifest) pair the router knows about, including ' +
                'manifests whose binary was not found on PATH. Each entry reports which ' +
                'manifest is the primary for a given lang, the PATH probe status, and the ' +
                'manifest-declared LSP capabilities. No arguments.',
            inputSchema: {},
        },
        async () => {
            try {
                return jsonResult(router.listLanguages());
            } catch (err) {
                return toolError('list_languages', err);
            }
        }
    );

    // ---- set_primary ---------------------------------------------------------

    server.registerTool(
        'set_primary',
        {
            description:
                'Swap which candidate manifest is primary for a given lang. Takes effect ' +
                'immediately for subsequent defs/refs/hover calls; no restart. Resets to ' +
                'first-registered on server restart (in-memory only, not persisted). ' +
                'Throws if the lang or manifest is unknown, if the manifest is not a ' +
                "candidate for the lang, or if the manifest's binary is not on PATH.",
            inputSchema: {
                lang: schemas.LangEnum.describe(
                    'langId whose primary to swap (e.g. "python", "bazel").'
                ),
                manifest: schemas.ManifestEnum.describe(
                    'Name of the candidate manifest to promote to primary.'
                ),
            },
        },
        async ({ lang, manifest }) => {
            try {
                return jsonResult(router.setPrimary(lang, manifest));
            } catch (err) {
                return toolError('set_primary', err);
            }
        }
    );

    // ---- defs ----------------------------------------------------------------

    server.registerTool(
        'defs',
        {
            description:
                'Go-to-definition: returns the location(s) where the symbol at the given ' +
                'position is defined.',
            inputSchema: { file: FileUriSchema, pos: PositionSchema, via: schemas.ViaSchema },
        },
        async ({ file, pos, via }) => {
            try {
                return jsonResult(await router.definitions(file, pos, via));
            } catch (err) {
                return toolError('defs', err);
            }
        }
    );

    // ---- refs ----------------------------------------------------------------

    server.registerTool(
        'refs',
        {
            description: 'Find all references to the symbol at the given position.',
            inputSchema: { file: FileUriSchema, pos: PositionSchema, via: schemas.ViaSchema },
        },
        async ({ file, pos, via }) => {
            try {
                // `references` positional signature: (fileUri, position, includeDeclaration=true, via?).
                // Pass `true` explicitly so the via slot resolves correctly.
                return jsonResult(await router.references(file, pos, true, via));
            } catch (err) {
                return toolError('refs', err);
            }
        }
    );

    // ---- impls ---------------------------------------------------------------

    server.registerTool(
        'impls',
        {
            description:
                'Find implementations (concrete subclasses / interface implementations) of ' +
                'the symbol at the given position.',
            inputSchema: { file: FileUriSchema, pos: PositionSchema, via: schemas.ViaSchema },
        },
        async ({ file, pos, via }) => {
            try {
                return jsonResult(await router.implementations(file, pos, via));
            } catch (err) {
                return toolError('impls', err);
            }
        }
    );

    // ---- hover ---------------------------------------------------------------

    server.registerTool(
        'hover',
        {
            description: 'Return type information and documentation for the symbol at the given position.',
            inputSchema: { file: FileUriSchema, pos: PositionSchema, via: schemas.ViaSchema },
        },
        async ({ file, pos, via }) => {
            try {
                return jsonResult(await router.hover(file, pos, via));
            } catch (err) {
                return toolError('hover', err);
            }
        }
    );

    // ---- outline -------------------------------------------------------------

    server.registerTool(
        'outline',
        {
            description: 'List all symbols defined in a file (document symbol outline).',
            inputSchema: { file: FileUriSchema, via: schemas.ViaSchema },
        },
        async ({ file, via }) => {
            try {
                return jsonResult(await router.documentSymbols(file, via));
            } catch (err) {
                return toolError('outline', err);
            }
        }
    );

    // ---- diagnostics ---------------------------------------------------------

    server.registerTool(
        'diagnostics',
        {
            description: 'Return errors and warnings for a file.',
            inputSchema: { file: FileUriSchema, via: schemas.ViaSchema },
        },
        async ({ file, via }) => {
            try {
                return jsonResult(await router.diagnostics(file, via));
            } catch (err) {
                return toolError('diagnostics', err);
            }
        }
    );

    // ---- lsp (escape hatch) -------------------------------------------------

    server.registerTool(
        'lsp',
        {
            description:
                'Raw LSP passthrough. Send any LSP method directly to the server configured ' +
                'for the given language. Use for methods not covered by the canonical verbs.',
            inputSchema: {
                lang: schemas.LangEnum.describe(
                    'Language ID of the target server (e.g. "python", "typescript")'
                ),
                method: z.string().describe('LSP method name (e.g. "textDocument/codeLens")'),
                params: LspParamsSchema,
                via: schemas.ViaSchema,
            },
        },
        async ({ lang, method, params, via }) => {
            try {
                return jsonResult(await router.raw(lang, method, params, via));
            } catch (err) {
                return toolError('lsp', err);
            }
        }
    );

    // ---- call hierarchy (gated) ---------------------------------------------

    const hasCallHierarchy = router.servers.some(
        (s) => s.manifest.capabilities?.callHierarchy === true
    );
    if (hasCallHierarchy) {
        server.registerTool(
            'call_hierarchy_prepare',
            {
                description:
                    'Prepare call-hierarchy items at the given position. Pass a returned item to ' +
                    'incoming_calls or outgoing_calls to explore the graph.',
                inputSchema: { file: FileUriSchema, pos: PositionSchema, via: schemas.ViaSchema },
            },
            async ({ file, pos, via }) => {
                try {
                    return jsonResult(await router.prepareCallHierarchy(file, pos, via));
                } catch (err) {
                    return toolError('call_hierarchy_prepare', err);
                }
            }
        );

        server.registerTool(
            'incoming_calls',
            {
                description: 'Return all callers of the given call-hierarchy item.',
                inputSchema: {
                    item: z
                        .record(z.any())
                        .describe('A CallHierarchyItem from call_hierarchy_prepare'),
                    via: schemas.ViaSchema,
                },
            },
            async ({ item, via }) => {
                try {
                    return jsonResult(await router.incomingCalls(item, via));
                } catch (err) {
                    return toolError('incoming_calls', err);
                }
            }
        );

        server.registerTool(
            'outgoing_calls',
            {
                description: 'Return all callees of the given call-hierarchy item.',
                inputSchema: {
                    item: z
                        .record(z.any())
                        .describe('A CallHierarchyItem from call_hierarchy_prepare'),
                    via: schemas.ViaSchema,
                },
            },
            async ({ item, via }) => {
                try {
                    return jsonResult(await router.outgoingCalls(item, via));
                } catch (err) {
                    return toolError('outgoing_calls', err);
                }
            }
        );
    }

    return server;
}

// ---- Helpers ---------------------------------------------------------------

function jsonResult(value: unknown) {
    return {
        content: [
            {
                type: 'text' as const,
                text: JSON.stringify(value, null, 2),
            },
        ],
    };
}

function toolError(tool: string, err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`[lsp-mcp] ${tool} error: ${message}\n`);
    return {
        content: [{ type: 'text' as const, text: `${tool} error: ${message}` }],
        isError: true as const,
    };
}

/**
 * Convert a numeric LSP SymbolKind to a human-readable name for filtering.
 * Falls back to the raw number string for unknown kinds.
 */
function symbolKindName(kind: number): string {
    const names: Record<number, string> = {
        1: 'file', 2: 'module', 3: 'namespace', 4: 'package',
        5: 'class', 6: 'method', 7: 'property', 8: 'field',
        9: 'constructor', 10: 'enum', 11: 'interface', 12: 'function',
        13: 'variable', 14: 'constant', 15: 'string', 16: 'number',
        17: 'boolean', 18: 'array', 19: 'object', 20: 'key',
        21: 'null', 22: 'enummember', 23: 'struct', 24: 'event',
        25: 'operator', 26: 'typeparameter',
    };
    return names[kind] ?? String(kind);
}
