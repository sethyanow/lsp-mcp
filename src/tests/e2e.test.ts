import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { LspServer } from '../lsp-server';
import { Router, type ManifestEntry } from '../router';
import { createMcpServer } from '../mcp-server';
import { PluginManifestSchema } from '../types';

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
