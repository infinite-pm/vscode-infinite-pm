// Live SVG refresh on edit (without saving the file).
//
// Strategy (Approach 2): on every
// debounced text change, call the LSP server's ipm.embedBuffer command
// to render every ipmt block in the *open buffer* (server reads its
// in-memory document state, not disk). The server returns base64 SVGs;
// we store them as data URLs in a per-URI LiveCache. The cachebust rule
// in cachebust.ts swaps the rendered <img>'s src for the data URL when
// a live entry exists, falling back to the on-disk path + `?v=<hash>`
// otherwise.
//
// Nothing here writes to disk. The .md and the committed SVG files
// stay frozen at their last-saved state until the user saves and the
// existing embed-on-save flow takes over. We evict the cache for a
// URI on save (the regular flow now owns the rendering) and on close
// (the user is done with that file).

import * as vscode from 'vscode';
import { LanguageClient, State } from 'vscode-languageclient/node';

// LSP-emitted semantic-token record for one block, block-relative.
// Matches the Go `bufferToken` struct in cmd/ipm-rpc/embed_buffer.go.
export interface BufferToken {
    line: number;
    col: number;
    len: number;
    type: string; // "ipmEvent", "ipmThing", … (one of semanticTokenTypes)
    mods?: number; // bitmask matching semanticTokenModifiers
}

export interface LiveEntry {
    hash: string;
    dataUrl: string;
    // Optional: cached semantic tokens for this block's ipmt source. The
    // preview tokenizer prefers these over its built-in regex tokenizer
    // so editor + preview stay color-aligned even when the heuristic
    // tokenizer would diverge.
    tokens?: BufferToken[];
}


// Module-level log handle used by debug breadcrumbs. Set during wireLiveRefresh.
let debugLog: ((line: string) => void) | undefined;

// LiveCache keys URI string → block id → LiveEntry. Size is bounded by
// soft limits; we evict the oldest URI when total bytes exceed the cap.
// In practice the cap is rarely approached (typical ipmt SVGs are 5-10 KB).
export class LiveCache {
    private cache = new Map<string, Map<string, LiveEntry>>();
    // Per-URI map from raw block source text → tokens. Looked up by the
    // fence renderer using the block's `tok.content` (which is the raw
    // ipmt source between fences). Source-string keying is robust to
    // re-orderings; identical blocks resolve to the same tokens.
    private tokensByUri = new Map<string, Map<string, BufferToken[]>>();
    private byteCount = 0;
    private static readonly SOFT_BYTE_CAP = 50 * 1024 * 1024; // 50 MB

    set(uri: string, blockId: string, entry: LiveEntry): void {
        let m = this.cache.get(uri);
        if (!m) {
            m = new Map();
            this.cache.set(uri, m);
        }
        const prev = m.get(blockId);
        if (prev) {
            this.byteCount -= prev.dataUrl.length;
        }
        m.set(blockId, entry);
        this.byteCount += entry.dataUrl.length;
        this.maybeEvict();
    }

    get(uri: string, blockId: string): LiveEntry | undefined {
        return this.cache.get(uri)?.get(blockId);
    }

    // setTokensForSource stores tokens for a block by URI + raw source.
    // Called by the live-refresh listener once per embedBuffer response,
    // alongside `set(uri, blockId, entry)`.
    //
    // Normalization: the Go side (mdembed) stores block content as
    // LF-joined lines with NO trailing newline, while markdown-it's
    // `tok.content` for a fenced block ALWAYS has a trailing newline.
    // Strip the trailing newline before keying so the two byte-match.
    setTokensForSource(uri: string, source: string, tokens: BufferToken[]): void {
        let m = this.tokensByUri.get(uri);
        if (!m) {
            m = new Map();
            this.tokensByUri.set(uri, m);
        }
        m.set(normalizeSource(source), tokens);
    }

    // getTokensForSource returns the tokens for a block whose raw text
    // matches `source`. If `uri` is provided, restricts the lookup to that
    // URI. Otherwise scans all URIs (used when the fence renderer can't
    // extract a URI from env).
    getTokensForSource(uri: string | undefined, source: string): BufferToken[] | undefined {
        const key = normalizeSource(source);
        if (uri) {
            return this.tokensByUri.get(uri)?.get(key);
        }
        for (const m of this.tokensByUri.values()) {
            const hit = m.get(key);
            if (hit) return hit;
        }
        return undefined;
    }

    delete(uri: string): void {
        const m = this.cache.get(uri);
        if (m) {
            for (const e of m.values()) {
                this.byteCount -= e.dataUrl.length;
            }
            this.cache.delete(uri);
        }
        this.tokensByUri.delete(uri);
    }

    clear(): void {
        this.cache.clear();
        this.tokensByUri.clear();
        this.byteCount = 0;
    }

    // Test introspection.
    size(): number {
        let n = 0;
        for (const m of this.cache.values()) n += m.size;
        return n;
    }
    bytes(): number { return this.byteCount; }

    private maybeEvict(): void {
        // Drop oldest URIs (insertion-order is preserved by Map) until under cap.
        while (this.byteCount > LiveCache.SOFT_BYTE_CAP && this.cache.size > 0) {
            const oldest = this.cache.keys().next().value;
            if (oldest === undefined) break;
            this.delete(oldest);
        }
    }
}

// normalizeSource canonicalizes a block source string for cache keying.
// Strips trailing `\r?\n` and normalizes CRLF → LF in the body so the
// markdown-it side (always-trailing-newline) and the Go side
// (no-trailing-newline, LF-joined) hash to the same key.
function normalizeSource(s: string): string {
    let out = s.replace(/\r\n/g, '\n');
    while (out.endsWith('\n')) out = out.slice(0, -1);
    return out;
}

interface EmbedBufferBlock {
    index: number;
    id: string;
    hash: string;
    source?: string;
    svgBase64?: string;
    outcome: string;
    error?: string;
    tokens?: BufferToken[];
}

interface InlineIpmtFragment {
    source: string;
    tokens?: BufferToken[];
}

interface EmbedBufferResult {
    uri: string;
    blocks: EmbedBufferBlock[];
    inlineIpmt?: InlineIpmtFragment[];
    warnings?: unknown[];
}

// wireLiveRefresh subscribes to text-change / save / close events for
// markdown documents and keeps the LiveCache in sync with the buffer
// contents. Gated by the `ipm.liveRefresh` setting (default true).
export function wireLiveRefresh(
    ctx: vscode.ExtensionContext,
    client: LanguageClient,
    cache: LiveCache,
    log: vscode.OutputChannel,
    disposables?: vscode.Disposable[],
): void {
    debugLog = (s: string) => log.appendLine(s);

    const debouncers = new Map<string, NodeJS.Timeout>();

    // `fire` schedules a debounced embedBuffer; `fireNow` runs it
    // immediately. The immediate path is used for file open + extension
    // activation so the LSP token cache is populated before the user
    // sees the preview for the first time. Without this the preview
    // falls back to the regex tokenizer for cold-open files, producing
    // visibly different colors from the editor pane.
    const fireNow = async (doc: vscode.TextDocument) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('liveRefresh', true)) {
            return;
        }
        log.appendLine(`[live-refresh] eager fire for ${doc.uri.fsPath}`);
        await runEmbedBuffer(client, doc, cache, log);
        try {
            await vscode.commands.executeCommand('markdown.preview.refresh');
        } catch (err) {
            log.appendLine(`[live-refresh] markdown.preview.refresh failed: ${err}`);
        }
    };

    const fire = async (doc: vscode.TextDocument) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('liveRefresh', true)) {
            log.appendLine('[live-refresh] disabled by ipm.liveRefresh=false; skipping');
            return;
        }
        const delay = Math.max(0, cfg.get<number>('liveRefreshDebounceMs', 300));
        const key = doc.uri.toString();
        const existing = debouncers.get(key);
        if (existing) clearTimeout(existing);
        log.appendLine(`[live-refresh] change observed for ${doc.uri.fsPath}; debouncing ${delay}ms`);
        debouncers.set(key, setTimeout(async () => {
            debouncers.delete(key);
            await runEmbedBuffer(client, doc, cache, log);
            // Nudge the preview so the new data URLs land in the rendered DOM.
            log.appendLine('[live-refresh] calling markdown.preview.refresh');
            try {
                await vscode.commands.executeCommand('markdown.preview.refresh');
            } catch (err) {
                log.appendLine(`[live-refresh] markdown.preview.refresh failed: ${err}`);
            }
        }, delay));
    };

    const subChange = vscode.workspace.onDidChangeTextDocument(e => {
        if (e.document.languageId !== 'markdown') return;
        void fire(e.document);
    });
    const subOpen = vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        void fireNow(doc);
    });
    const subSave = vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        cache.delete(doc.uri.toString());
    });
    const subClose = vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        cache.delete(doc.uri.toString());
    });
    // Server-crash recovery. vscode-languageclient auto-respawns a crashed
    // server process ("Connection to server got closed. Server will
    // restart.") — but every embedBuffer that was in flight when it died
    // was rejected, so the LiveCache keeps whatever the PREVIOUS server
    // rendered and the preview shows stale SVGs until the user closes and
    // reopens the file. Seen 2026-07-08: all six eager fires after a
    // binary-change restart died with "Pending response rejected since
    // connection got disposed" when the new server crashed mid-batch.
    // When the client transitions back to Running, re-fire an eager
    // embedBuffer for every open markdown document so the preview
    // converges on the live server's output.
    const subState = client.onDidChangeState(e => {
        if (e.newState !== State.Running) return;
        log.appendLine('[live-refresh] client back to Running; re-firing embedBuffer for open markdown docs');
        for (const doc of vscode.workspace.textDocuments) {
            if (doc.languageId === 'markdown') void fireNow(doc);
        }
    });
    ctx.subscriptions.push(subChange, subOpen, subSave, subClose, subState);
    disposables?.push(subChange, subOpen, subSave, subClose, subState);

    // Catch up on any markdown documents that were already open when
    // the extension activated. Without this, files visible at startup
    // never trigger an embedBuffer until the first edit — so the
    // preview falls back to the regex tokenizer with visibly different
    // colors from the editor pane.
    for (const doc of vscode.workspace.textDocuments) {
        if (doc.languageId === 'markdown') {
            void fireNow(doc);
        }
    }
}

// Number of times we retry an embedBuffer call that fails because the
// server hasn't yet received textDocument/didOpen for the URI. The
// vscode-languageclient sends didOpen for already-open docs at startup
// asynchronously and our activation-time eager-fire can race with it.
const EMBED_NOT_OPEN_RETRIES = 6;
const EMBED_NOT_OPEN_RETRY_DELAY_MS = 200;

// isTransientEmbedError decides whether a failed embedBuffer call is worth
// retrying. Two transient shapes:
//   - "document not open in server": didOpen hasn't reached the server yet
//     (startup / restart race).
//   - connection died mid-request: the server process crashed and
//     vscode-languageclient is auto-respawning it. The retry lands on the
//     fresh connection (didOpen is re-sent on restart).
// Anything else (parse errors, bad args) won't fix itself by waiting.
// Exported for tests.
export function isTransientEmbedError(err: unknown): boolean {
    const msg = String(err).toLowerCase();
    return msg.includes('document not open in server')
        || msg.includes('connection got disposed')
        || msg.includes('connection is disposed')
        || msg.includes('connection got closed')
        || msg.includes('client is not running');
}

async function runEmbedBuffer(
    client: LanguageClient,
    doc: vscode.TextDocument,
    cache: LiveCache,
    log: vscode.OutputChannel,
): Promise<void> {
    const uriStr = doc.uri.toString();
    log.appendLine(`[live-refresh] -> ipm.embedBuffer ${uriStr}`);
    let res: EmbedBufferResult | null = null;
    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= EMBED_NOT_OPEN_RETRIES; attempt++) {
        try {
            res = await client.sendRequest<EmbedBufferResult | null>(
                'workspace/executeCommand',
                {
                    command: 'ipm.embedBuffer',
                    arguments: [{ uri: uriStr }],
                },
            );
            lastErr = undefined;
            break;
        } catch (err) {
            lastErr = err;
            if (!isTransientEmbedError(err)) {
                // Non-transient error (parse, bad args, etc.): stop retrying
                // and let the post-loop `if (lastErr) throw lastErr` (inside
                // the outer try) route it to the catch/log below, instead of
                // escaping runEmbedBuffer as an unhandled rejection.
                break;
            }
            if (attempt < EMBED_NOT_OPEN_RETRIES) {
                log.appendLine(`[live-refresh] transient failure on attempt ${attempt + 1} (${String(err).slice(0, 120)}); retrying after ${EMBED_NOT_OPEN_RETRY_DELAY_MS}ms`);
                await new Promise(resolve => setTimeout(resolve, EMBED_NOT_OPEN_RETRY_DELAY_MS));
            }
        }
    }
    try {
        if (lastErr) {
            throw lastErr;
        }
        if (!res) {
            log.appendLine('[live-refresh] <- (null response)');
            return;
        }
        if (!res.blocks) {
            log.appendLine('[live-refresh] <- res has no .blocks field; got: ' + JSON.stringify(res).slice(0, 200));
            return;
        }
        let stored = 0;
        let skipped = 0;
        let tokensStored = 0;
        for (const b of res.blocks) {
            // Tokens are independent of SVG — even when rendering failed
            // (parse error etc.) the LSP may still emit partial tokens.
            // Store them whenever both source + tokens are present.
            if (b.source && b.tokens && b.tokens.length > 0) {
                cache.setTokensForSource(uriStr, b.source, b.tokens);
                tokensStored++;
            }
            if (!b.svgBase64) {
                // Parse error / unterminated / malformed this run. Leave any
                // previously-cached entry for this block in place so the
                // preview doesn't flicker back to the disk SVG mid-edit.
                skipped++;
                continue;
            }
            cache.set(uriStr, b.id, {
                hash: b.hash,
                dataUrl: `data:image/svg+xml;base64,${b.svgBase64}`,
                tokens: b.tokens,
            });
            stored++;
        }
        let inlineStored = 0;
        if (res.inlineIpmt) {
            for (const f of res.inlineIpmt) {
                if (f.source && f.tokens && f.tokens.length > 0) {
                    cache.setTokensForSource(uriStr, f.source, f.tokens);
                    inlineStored++;
                }
            }
        }
        log.appendLine(`[live-refresh] <- ${res.blocks.length} blocks, stored=${stored}, skipped=${skipped}, tokens-stored=${tokensStored}, inline-tokens-stored=${inlineStored}, cache.size=${cache.size()}, bytes=${cache.bytes()}`);
    } catch (err) {
        log.appendLine(`[live-refresh] ipm.embedBuffer failed for ${doc.uri.fsPath}: ${err}`);
    }
}
