import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Router } from './router.js';

const PositionSchema = z.object({
    line: z.number().int().min(0).describe('0-based line number'),
    character: z.number().int().min(0).describe('0-based character offset'),
});

const FileUriSchema = z
    .string()
    .regex(/^file:\/\//, 'must be a file:// URI (e.g. "file:///abs/path/to/file.py")')
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
                langs: z
                    .array(z.string())
                    .optional()
                    .describe(
                        'Restrict search to specific language IDs (e.g. ["python", "typescript"]). ' +
                            'Omit to search all configured languages.'
                    ),
            },
        },
        async ({ name, kind, langs }) => {
            try {
                const symbols = await router.symbolSearch(name, langs);
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

    // ---- defs ----------------------------------------------------------------

    server.registerTool(
        'defs',
        {
            description:
                'Go-to-definition: returns the location(s) where the symbol at the given ' +
                'position is defined.',
            inputSchema: { file: FileUriSchema, pos: PositionSchema },
        },
        async ({ file, pos }) => {
            try {
                return jsonResult(await router.definitions(file, pos));
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
            inputSchema: { file: FileUriSchema, pos: PositionSchema },
        },
        async ({ file, pos }) => {
            try {
                return jsonResult(await router.references(file, pos));
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
            inputSchema: { file: FileUriSchema, pos: PositionSchema },
        },
        async ({ file, pos }) => {
            try {
                return jsonResult(await router.implementations(file, pos));
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
            inputSchema: { file: FileUriSchema, pos: PositionSchema },
        },
        async ({ file, pos }) => {
            try {
                return jsonResult(await router.hover(file, pos));
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
            inputSchema: { file: FileUriSchema },
        },
        async ({ file }) => {
            try {
                return jsonResult(await router.documentSymbols(file));
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
            inputSchema: { file: FileUriSchema },
        },
        async ({ file }) => {
            try {
                return jsonResult(await router.diagnostics(file));
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
                lang: z
                    .string()
                    .describe('Language ID of the target server (e.g. "python", "typescript")'),
                method: z.string().describe('LSP method name (e.g. "textDocument/codeLens")'),
                params: LspParamsSchema,
            },
        },
        async ({ lang, method, params }) => {
            try {
                return jsonResult(await router.raw(lang, method, params));
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
                inputSchema: { file: FileUriSchema, pos: PositionSchema },
            },
            async ({ file, pos }) => {
                try {
                    return jsonResult(await router.prepareCallHierarchy(file, pos));
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
                },
            },
            async ({ item }) => {
                try {
                    return jsonResult(await router.incomingCalls(item));
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
                },
            },
            async ({ item }) => {
                try {
                    return jsonResult(await router.outgoingCalls(item));
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
