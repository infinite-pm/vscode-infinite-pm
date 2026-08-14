// Capture a real `ipm.embedBuffer` response for the preview render tests.
//
//   npm run gen-fixture          # rewrites src/__tests__/fixtures/embedBuffer.json
//
// Why a captured fixture rather than a hand-written one: the preview's colours
// come from the server and from nowhere else, so a hand-written token list
// tests the renderer against our idea of the server instead of the server. This
// drives the real ipm-rpc over stdio — the same LSP conversation the extension
// has — and writes what came back.
//
// The fixture is committed. Regenerate it when the tokenizer changes; the
// legend drift test (src/__tests__/serverLegend.test.ts) is what tells you the
// day that has happened, by reading ../ipm-tools directly.

import { spawn } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const OUT = path.join(ROOT, 'src', '__tests__', 'fixtures', 'embedBuffer.json');

// The document the fixture describes. Small, but it covers every colour the
// preview can paint: both node kinds, a concept, an alias, a relation marker
// inside an arrow, a quoted string and a comment.
const MARKDOWN = `# fixture

Prose before the block.

\`\`\`ipmt
# a comment
"Life, the Universe and Everything" ::e lue::a
humans / AI / machines ::t --::P--> lue
lue --> Complex process ::c
\`\`\`
`;

function serverPath(): string {
    const fromEnv = process.env.IPM_RPC;
    if (fromEnv) return fromEnv;
    const sibling = path.resolve(ROOT, '..', 'ipm-tools', 'bin', 'ipm-rpc');
    if (fs.existsSync(sibling)) return sibling;
    throw new Error(
        'no ipm-rpc found. Build it in the sibling clone (cd ../ipm-tools && make build-rpc) ' +
        'or point IPM_RPC at one.',
    );
}

/** Minimal LSP client: enough to open a document and run one command. */
class Rpc {
    private readonly proc = spawn(serverPath(), [], { stdio: ['pipe', 'pipe', 'ignore'] });
    private buf = Buffer.alloc(0);
    private id = 0;
    private pending = new Map<number, (msg: Record<string, unknown>) => void>();

    constructor() {
        this.proc.stdout.on('data', (chunk: Buffer) => {
            this.buf = Buffer.concat([this.buf, chunk]);
            for (;;) {
                const split = this.buf.indexOf('\r\n\r\n');
                if (split < 0) return;
                const header = this.buf.subarray(0, split).toString();
                const len = Number(/content-length:\s*(\d+)/i.exec(header)?.[1]);
                const start = split + 4;
                if (!len || this.buf.length < start + len) return;
                const msg = JSON.parse(this.buf.subarray(start, start + len).toString());
                this.buf = this.buf.subarray(start + len);
                const resolve = this.pending.get(msg.id);
                if (resolve) { this.pending.delete(msg.id); resolve(msg); }
            }
        });
    }

    private write(msg: Record<string, unknown>): void {
        const raw = Buffer.from(JSON.stringify(msg));
        this.proc.stdin.write(`Content-Length: ${raw.length}\r\n\r\n`);
        this.proc.stdin.write(raw);
    }

    notify(method: string, params: unknown): void {
        this.write({ jsonrpc: '2.0', method, params });
    }

    request(method: string, params: unknown): Promise<Record<string, unknown>> {
        const id = ++this.id;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.write({ jsonrpc: '2.0', id, method, params });
        });
    }

    // SIGKILL, not the default SIGTERM: ipm-rpc installs no handler for it, and
    // a surviving child keeps this script's event loop alive indefinitely.
    kill(): void { this.proc.stdin.end(); this.proc.kill('SIGKILL'); }
}

async function main(): Promise<void> {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-fixture-'));
    const file = path.join(dir, 'fixture.md');
    fs.writeFileSync(file, MARKDOWN);
    const uri = `file://${file}`;

    const rpc = new Rpc();
    await rpc.request('initialize', { processId: null, rootUri: null, capabilities: {} });
    rpc.notify('initialized', {});
    rpc.notify('textDocument/didOpen', {
        textDocument: { uri, languageId: 'markdown', version: 1, text: MARKDOWN },
    });

    const res = await rpc.request('workspace/executeCommand', {
        command: 'ipm.embedBuffer',
        arguments: [{ uri, tokensOnly: true }],
    });
    rpc.kill();
    fs.rmSync(dir, { recursive: true, force: true });

    const result = (res.result ?? {}) as { blocks?: Array<Record<string, unknown>> };
    const blocks = result.blocks ?? [];
    if (blocks.length !== 1) {
        throw new Error(`expected 1 block from the server, got ${blocks.length}`);
    }
    if (!Array.isArray(blocks[0].tokens) || (blocks[0].tokens as unknown[]).length === 0) {
        throw new Error('the server returned no tokens — did the fixture markdown stop parsing?');
    }

    // Only what the preview consumes: the source it keys by, and the tokens.
    const fixture = {
        // Regenerate with `npm run gen-fixture`; see scripts/gen-embed-fixture.ts.
        markdown: MARKDOWN,
        blocks: blocks.map((b) => ({ source: b.source, tokens: b.tokens })),
    };
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, JSON.stringify(fixture, null, 2) + '\n');
    const tokens = (fixture.blocks[0].tokens as unknown[]).length;
    console.log(`wrote ${path.relative(ROOT, OUT)} — 1 block, ${tokens} tokens`);
    process.exit(0);
}

main().catch((err) => {
    console.error(`gen-embed-fixture: ${err instanceof Error ? err.message : err}`);
    process.exit(1);
});
