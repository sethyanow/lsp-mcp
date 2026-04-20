import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LspServer } from '../lsp-server';
import { Router, type ManifestEntry } from '../router';
import { createMcpServer } from '../mcp-server';
import { PluginManifestSchema } from '../types';
import { discoverBuiltinManifests } from '../discover';
import { probeAll } from '../probe';

const STUB = path.resolve(__dirname, 'fixtures/stub-lsp.js');

// Test-fixture convention (lspm-h1n): see comment in router.test.ts.
function entriesFrom(servers: LspServer[]): ManifestEntry[] {
    return servers.map((s) => ({
        manifest: s.manifest,
        server: s,
        sourceKind: 'config-file' as const,
        status: 'ok' as const,
    }));
}

function makeServer(extraArgs: string[] = []): LspServer {
    const manifest = PluginManifestSchema.parse({
        name: 'stub',
        version: '0.1.0',
        langIds: ['python'],
        fileGlobs: ['**/*.py'],
        workspaceMarkers: [],
        server: { cmd: ['node', STUB, ...extraArgs] },
        capabilities: { workspaceSymbol: { stringPrefilter: true, timeoutMs: 5000 } },
    });
    return new LspServer(manifest, process.cwd(), '/unused');
}

async function buildClient(router: Router): Promise<{
    client: Client;
    teardown: () => Promise<void>;
}> {
    const mcpServer = createMcpServer(router);
    const [a, b] = InMemoryTransport.createLinkedPair();
    await mcpServer.connect(b);
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(a);
    return {
        client,
        teardown: async () => {
            await client.close();
            await router.shutdownAll();
        },
    };
}

describe('e2e: MCP client ↔ Router ↔ stub LSP', () => {
    it('symbol_search returns results from a real LSP round-trip', async () => {
        const router = new Router(entriesFrom([makeServer()]));
        const { client, teardown } = await buildClient(router);
        try {
            const result = await client.callTool({
                name: 'symbol_search',
                arguments: { name: 'Widget' },
            });
            expect(result.isError).toBeFalsy();
            const content = result.content as Array<{ type: string; text: string }>;
            const syms = JSON.parse(content[0].text);
            expect(syms).toHaveLength(1);
            expect(syms[0].name).toBe('Widget');
            expect(syms[0].kind).toBe('class');
        } finally {
            await teardown();
        }
    });

    it('survives cold-cache: server returns [] twice before real results', async () => {
        const router = new Router(entriesFrom([makeServer(['--symbol-empty-for=2'])]));
        const { client, teardown } = await buildClient(router);
        try {
            const result = await client.callTool({
                name: 'symbol_search',
                arguments: { name: 'Widget' },
            });
            const content = result.content as Array<{ type: string; text: string }>;
            const syms = JSON.parse(content[0].text);
            expect(syms.length).toBeGreaterThan(0);
        } finally {
            await teardown();
        }
    });

    it('normalizes WorkspaceSymbol-shape responses (no range) end-to-end', async () => {
        const router = new Router(entriesFrom([makeServer(['--symbol-shape=ws'])]));
        const { client, teardown } = await buildClient(router);
        try {
            const result = await client.callTool({
                name: 'symbol_search',
                arguments: { name: 'Widget' },
            });
            const content = result.content as Array<{ type: string; text: string }>;
            const syms = JSON.parse(content[0].text);
            expect(syms).toHaveLength(1);
            expect(syms[0].location.range).toEqual({
                start: { line: 0, character: 0 },
                end: { line: 0, character: 0 },
            });
        } finally {
            await teardown();
        }
    });

    it('defs routes through the real stub and returns its locations', async () => {
        const router = new Router(entriesFrom([makeServer()]));
        const { client, teardown } = await buildClient(router);
        try {
            // Path doesn't need to exist — openDocument tolerates missing files
            // and the stub's definition handler returns a hardcoded location.
            const result = await client.callTool({
                name: 'defs',
                arguments: { file: 'file:///no/such/file.py', pos: { line: 0, character: 0 } },
            });
            expect(result.isError).toBeFalsy();
            const content = result.content as Array<{ type: string; text: string }>;
            const locs = JSON.parse(content[0].text);
            expect(locs).toHaveLength(1);
            expect(locs[0].uri).toBe('file:///def.py');
        } finally {
            await teardown();
        }
    });
});

// ---- Smoke: list_languages over the real built-in manifest pipeline ------
//
// Exercises the full R6 discovery → probe → Router → MCP tool → client path
// against the shipped default manifests in `manifests/`. No LSP subprocess is
// spawned (listLanguages is spawn-safe); we only verify routing metadata and
// probe results flow through the tool surface correctly.

describe('e2e: list_languages over real built-in manifests', () => {
    it('returns one row per (builtin, langId) with consistent primary/status invariants', async () => {
        const discovered = discoverBuiltinManifests();
        const probed = probeAll(discovered);
        expect(discovered.length).toBeGreaterThanOrEqual(12); // sanity: all shipped defaults loaded

        const entries: ManifestEntry[] = probed.map((p) => ({
            manifest: p.manifest,
            server: new LspServer(p.manifest, process.cwd(), '/unused'),
            sourceKind: p.sourceKind,
            status: p.status,
        }));
        const router = new Router(entries);
        const { client, teardown } = await buildClient(router);
        try {
            const result = await client.callTool({ name: 'list_languages', arguments: {} });
            expect(result.isError).toBeFalsy();

            const rows = JSON.parse(
                (result.content as Array<{ type: string; text: string }>)[0].text
            );

            // Total row count equals sum of langIds across all builtins.
            const expectedRowCount = discovered.reduce(
                (n, d) => n + d.manifest.langIds.length,
                0
            );
            expect(rows).toHaveLength(expectedRowCount);

            // Every builtin manifest name appears in the output at least once.
            const seenManifests = new Set(rows.map((r: { manifest: string }) => r.manifest));
            for (const d of discovered) {
                expect(seenManifests.has(d.manifest.name)).toBe(true);
            }

            // Invariant: every binary_not_found manifest's rows are all primary:false.
            for (const row of rows) {
                if (row.status === 'binary_not_found') {
                    expect(row.primary).toBe(false);
                }
            }

            // Invariant: for each unique langId, at most one manifest has primary:true.
            const primaryByLang = new Map<string, number>();
            for (const row of rows) {
                if (row.primary) primaryByLang.set(row.lang, (primaryByLang.get(row.lang) ?? 0) + 1);
            }
            for (const count of primaryByLang.values()) {
                expect(count).toBe(1);
            }

            // Invariant: every 'ok' manifest has at least one primary:true row
            // (uncontested-candidate case; builtins don't ship two manifests for the
            // same langId today). Guards against _buildLangMap filter regressions.
            for (const d of probed.filter((p) => p.status === 'ok')) {
                const manifestRows = rows.filter(
                    (r: { manifest: string }) => r.manifest === d.manifest.name
                );
                const primaries = manifestRows.filter((r: { primary: boolean }) => r.primary);
                expect(primaries.length).toBeGreaterThanOrEqual(1);
            }
        } finally {
            await teardown();
        }
    });
});
