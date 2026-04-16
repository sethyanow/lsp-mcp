import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Router } from './router.js';

const PositionSchema = z.object({
    line: z.number().int().min(0).describe('0-based line number'),
    character: z.number().int().min(0).describe('0-based character offset'),
});

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
                const filtered =
                    kind
                        ? symbols.filter(
                              (s) =>
                                  symbolKindName(s.kind)
                                      .toLowerCase()
                                      .includes(kind.toLowerCase())
                          )
                        : symbols;

                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(filtered, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: `symbol_search error: ${(err as Error).message}`,
                        },
                    ],
                    isError: true,
                };
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
            inputSchema: {
                file: z.string().describe('File URI (e.g. "file:///abs/path/to/file.py")'),
                pos: PositionSchema,
            },
        },
        async ({ file, pos }) => {
            try {
                const locations = await router.definitions(file, pos);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(locations, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`defs error: ${(err as Error).message}`);
            }
        }
    );

    // ---- refs ----------------------------------------------------------------

    server.registerTool(
        'refs',
        {
            description: 'Find all references to the symbol at the given position.',
            inputSchema: {
                file: z.string().describe('File URI'),
                pos: PositionSchema,
            },
        },
        async ({ file, pos }) => {
            try {
                const locations = await router.references(file, pos);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(locations, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`refs error: ${(err as Error).message}`);
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
            inputSchema: {
                file: z.string().describe('File URI'),
                pos: PositionSchema,
            },
        },
        async ({ file, pos }) => {
            try {
                const locations = await router.implementations(file, pos);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(locations, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`impls error: ${(err as Error).message}`);
            }
        }
    );

    // ---- hover ---------------------------------------------------------------

    server.registerTool(
        'hover',
        {
            description: 'Return type information and documentation for the symbol at the given position.',
            inputSchema: {
                file: z.string().describe('File URI'),
                pos: PositionSchema,
            },
        },
        async ({ file, pos }) => {
            try {
                const info = await router.hover(file, pos);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(info, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`hover error: ${(err as Error).message}`);
            }
        }
    );

    // ---- outline -------------------------------------------------------------

    server.registerTool(
        'outline',
        {
            description: 'List all symbols defined in a file (document symbol outline).',
            inputSchema: {
                file: z.string().describe('File URI'),
            },
        },
        async ({ file }) => {
            try {
                const symbols = await router.documentSymbols(file);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(symbols, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`outline error: ${(err as Error).message}`);
            }
        }
    );

    // ---- diagnostics ---------------------------------------------------------

    server.registerTool(
        'diagnostics',
        {
            description: 'Return errors and warnings for a file.',
            inputSchema: {
                file: z.string().describe('File URI'),
            },
        },
        async ({ file }) => {
            try {
                const diags = await router.diagnostics(file);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(diags, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`diagnostics error: ${(err as Error).message}`);
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
                params: z
                    .record(z.string(), z.any())
                    .describe('LSP request parameters as a JSON object'),
            },
        },
        async ({ lang, method, params }) => {
            try {
                const result = await router.raw(lang, method, params as Record<string, unknown>);
                return {
                    content: [
                        {
                            type: 'text' as const,
                            text: JSON.stringify(result, null, 2),
                        },
                    ],
                };
            } catch (err) {
                return errorResult(`lsp error: ${(err as Error).message}`);
            }
        }
    );

    return server;
}

// ---- Helpers ---------------------------------------------------------------

function errorResult(message: string) {
    return {
        content: [{ type: 'text' as const, text: message }],
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
