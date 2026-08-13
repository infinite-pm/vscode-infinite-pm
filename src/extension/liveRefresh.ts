// Live SVG refresh on edit (without saving the file).
//
// Strategy: on every
// debounced text change, call the LSP server's ipm.embedBuffer command
// to render every ipmt block in the *open buffer* (server reads its
// in-memory document state, not disk). The server returns base64 SVGs;
// we store them as data URLs in a per-URI LiveCache. The cachebust rule
// in cachebust.ts swaps the rendered <img>'s src for the data URL when
// a live entry exists, falling back to the on-disk path + `?v=<hash>`
// otherwise.
//
// TWO CADENCES, because colors and diagrams need different freshness.
//
// The markdown preview looks tokens up by EXACT block source
// (previewHighlight.ts), and VS Code re-renders that preview on its own
// ~300 ms trailing throttle using the buffer text as of that moment. So a
// token set for any revision other than the one being rendered is not
// merely stale — it is unusable, and the block renders black. Waiting out
// an idle debounce therefore cannot work: during continuous typing the
// idle never arrives, and when it does the cache holds the text from the
// request instant, not the render instant.
//
// Tokens are consequently refreshed on EVERY change via a `tokensOnly`
// embedBuffer, which skips the SVG layout server-side (measured: 0.5-2 ms
// on a normal document, 35 ms vs 110 ms on a 3200-line/95-block one).
// A single-flight per URI keeps at most one call in the air, so the rate
// self-tunes to whatever the server can sustain instead of queueing.
// Diagrams keep the old idle debounce: an SVG that lags until you pause is
// fine, a black code fence is not.
//
// Nothing here writes to disk. The .md and the committed SVG files
// stay frozen at their last-saved state until the user saves and the
// existing embed-on-save flow takes over. We evict the cache for a
// URI on save (the regular flow now owns the rendering) and on close
// (the user is done with that file).
//
// Two resilience behaviours live here too: transient embed errors (the
// server not yet knowing a document) are retried briefly, and when the
// client returns to State.Running after a crash we re-fire embedBuffer
// for every open markdown document so the preview recovers on its own.

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

// Two rounds of source-keyed tokens for one URI. See LiveCache.tokensByUri.
interface TokenGenerations {
    current: Map<string, BufferToken[]>;
    previous: Map<string, BufferToken[]>;
}

export interface LiveEntry {
    hash: string;
    dataUrl: string;
    // Optional: cached semantic tokens for this block's ipmt source. The
    // preview tokenizer uses these so editor + preview stay color-aligned;
    // there is no client-side fallback tokenizer, so a cache miss renders the
    // block uncolored rather than subtly differently colored.
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
    //
    // Two generations, not one. `current` holds the newest response;
    // `previous` holds the one before it. Firing on every keystroke would
    // otherwise grow this map without bound (one new source per edit), and
    // the older generation earns its keep: when two edits land in quick
    // succession the preview can still be rendering the text of the
    // previous one, and that render finds its exact source here rather
    // than falling through to the uncolored branch. Both generations are
    // exact-match keys — nothing approximate is ever served.
    private tokensByUri = new Map<string, TokenGenerations>();
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

    // beginTokenGeneration rotates the token generations for a URI: the
    // current response's entries start empty, the entries from the previous
    // response are retained one more round. Called once per embedBuffer
    // response, before its setTokensForSource calls. Skipping it (as the
    // unit tests do) simply keeps writing into the current generation.
    beginTokenGeneration(uri: string): void {
        const g = this.tokensByUri.get(uri);
        if (!g) {
            this.tokensByUri.set(uri, { current: new Map(), previous: new Map() });
            return;
        }
        g.previous = g.current;
        g.current = new Map();
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
        let g = this.tokensByUri.get(uri);
        if (!g) {
            g = { current: new Map(), previous: new Map() };
            this.tokensByUri.set(uri, g);
        }
        g.current.set(normalizeSource(source), tokens);
    }

    // getTokensForSource returns the tokens for a block whose raw text
    // matches `source`. If `uri` is provided, restricts the lookup to that
    // URI. Otherwise scans all URIs (used when the fence renderer can't
    // extract a URI from env). The newest generation wins; the previous one
    // is consulted only on a miss.
    getTokensForSource(uri: string | undefined, source: string): BufferToken[] | undefined {
        const key = normalizeSource(source);
        if (uri) {
            const g = this.tokensByUri.get(uri);
            return g && (g.current.get(key) ?? g.previous.get(key));
        }
        for (const g of this.tokensByUri.values()) {
            const hit = g.current.get(key) ?? g.previous.get(key);
            if (hit) return hit;
        }
        return undefined;
    }

    delete(uri: string): void {
        this.deleteSvgs(uri);
        this.tokensByUri.delete(uri);
    }

    // deleteSvgs drops the rendered-SVG entries for a URI but KEEPS its
    // tokens. Used on save, where the on-disk SVGs become authoritative
    // again (cachebust falls back to the disk path + `?v=<hash>`) but the
    // buffer text — and therefore every token key — is unchanged. Evicting
    // tokens there used to blank every ipmt block in the preview until the
    // next keystroke, since nothing re-fires embedBuffer on save.
    deleteSvgs(uri: string): void {
        const m = this.cache.get(uri);
        if (m) {
            for (const e of m.values()) {
                this.byteCount -= e.dataUrl.length;
            }
            this.cache.delete(uri);
        }
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

// Upper bound on the self-imposed cooldown between token refreshes. Past
// this the colors would lag more than the preview's own ~300 ms render
// cadence, which is the point where a user notices staleness rather than
// cost.
const MAX_COOLDOWN_MS = 250;

// cooldownMs returns how long to wait after a task of `lastDurationMs`
// before starting the next one for the same key: as long as the last call
// took, capped. That holds the duty cycle at roughly 50% whatever the
// machine does, with no configuration to get wrong — a 1 ms round trip
// imposes a 1 ms gap (invisible), while a 200 ms one on a slow box or a
// remote filesystem stops the refreshes from running back to back.
//
// A fixed setting cannot do this: measured on a 3234-line, 95-block
// document, floors below ~150 ms changed neither the call rate nor the cost
// (the single-flight was already slower than that), and the first floor that
// did cut cost also halved the number of colored preview renders. The right
// bound is not a constant, it is the observed latency.
export function cooldownMs(lastDurationMs: number): number {
    if (!(lastDurationMs > 0)) return 0;
    return Math.min(lastDurationMs, MAX_COOLDOWN_MS);
}

// SingleFlight coalesces repeated work per key: at most one task runs at a
// time, and changes arriving mid-flight collapse into exactly one follow-up
// run with the latest state. Intermediate keystrokes are dropped on purpose
// — only the newest buffer text can produce a usable token set.
//
// This is what replaces a debounce on the token path. A debounce guesses a
// fixed idle period and never fires while you type; single-flight instead
// paces itself off the server's measured latency: ~1 ms round trips mean
// effectively per-keystroke refreshes, and a 35 ms document simply refreshes
// less often, without ever queueing calls behind each other.
export class SingleFlight {
    private inFlight = new Set<string>();
    private queued = new Map<string, () => Promise<void>>();
    private cooling = new Set<string>();
    private lastDuration = new Map<string, number>();

    constructor(private readonly now: () => number = Date.now) { }

    // run starts `task` for `key`, or — if one is already running or the key
    // is cooling down — parks it as the single follow-up, replacing any
    // previously parked task.
    run(key: string, task: () => Promise<void>): void {
        if (this.inFlight.has(key) || this.cooling.has(key)) {
            this.queued.set(key, task);
            return;
        }
        this.inFlight.add(key);
        const started = this.now();
        // The catch has to come BEFORE the finally: `finally` passes the
        // rejection through, so a failed task would surface as an unhandled
        // rejection in the extension host. Callers log their own failures;
        // this is the backstop that keeps the key from wedging.
        void task().catch(err => {
            debugLog?.(`[live-refresh] single-flight task failed for ${key}: ${err}`);
        }).finally(() => {
            this.inFlight.delete(key);
            const duration = this.now() - started;
            this.lastDuration.set(key, duration);
            // Cool down whether or not anything is waiting: the bound has to
            // hold for a typist who happens to land each keystroke right as
            // the previous call returns, not just for a full queue.
            const wait = cooldownMs(duration);
            if (wait <= 0) {
                this.drain(key);
                return;
            }
            this.cooling.add(key);
            setTimeout(() => {
                this.cooling.delete(key);
                this.drain(key);
            }, wait);
        });
    }

    // drain starts whatever was parked while this key was busy or cooling.
    private drain(key: string): void {
        const next = this.queued.get(key);
        if (!next) return;
        this.queued.delete(key);
        this.run(key, next);
    }

    // Test introspection.
    isRunning(key: string): boolean { return this.inFlight.has(key); }
    hasQueued(key: string): boolean { return this.queued.has(key); }
    isCooling(key: string): boolean { return this.cooling.has(key); }
}

// shouldApplyRender decides whether a just-arrived embedBuffer response may
// overwrite the cached SVGs for a URI.
//
// Tokens need no such guard — they are content-addressed, so an out-of-order
// response can only re-add tokens for the exact text it was computed from.
// SVGs are keyed by block id, so a slow response for an older revision would
// otherwise clobber a newer diagram and leave it wrong until the next edit.
// Responses for a revision older than what is already applied are discarded.
export function shouldApplyRender(applied: number | undefined, incoming: number): boolean {
    return applied === undefined || incoming >= applied;
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
    const tokenFlight = new SingleFlight();
    // Highest document version whose SVGs have been written to the cache,
    // per URI. Guards against out-of-order responses; see shouldApplyRender.
    const appliedRenderVersion = new Map<string, number>();

    // `fire` schedules a debounced embedBuffer; `fireNow` runs it
    // immediately. The immediate path is used for file open + extension
    // activation so the LSP token cache is populated before the user
    // sees the preview for the first time. Without this a cold-open file
    // shows its ipmt blocks uncolored until the first embedBuffer lands.
    const fireNow = async (doc: vscode.TextDocument) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('liveRefresh', true)) {
            return;
        }
        log.appendLine(`[live-refresh] eager fire for ${doc.uri.fsPath}`);
        await runEmbedBuffer(client, doc, cache, log, { appliedRenderVersion });
        try {
            await vscode.commands.executeCommand('markdown.preview.refresh');
        } catch (err) {
            log.appendLine(`[live-refresh] markdown.preview.refresh failed: ${err}`);
        }
    };

    // fireTokens refreshes ONLY the semantic tokens, on every change. No
    // debounce and no preview nudge: VS Code re-renders the preview on its
    // own ~300 ms throttle after any edit, and by then the tokens for the
    // text it renders are already cached. Forcing `markdown.preview.refresh`
    // here would instead rebuild the whole webview on every keystroke.
    const fireTokens = (doc: vscode.TextDocument) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('liveRefresh', true)) {
            return;
        }
        tokenFlight.run(doc.uri.toString(), () =>
            runEmbedBuffer(client, doc, cache, log, { tokensOnly: true }));
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
            await runEmbedBuffer(client, doc, cache, log, { appliedRenderVersion });
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
        fireTokens(e.document);
        void fire(e.document);
    });
    const subOpen = vscode.workspace.onDidOpenTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        void fireNow(doc);
    });
    const subSave = vscode.workspace.onDidSaveTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        // SVGs only: on save the on-disk renders become authoritative
        // again, but the text — and so every token key — is unchanged, and
        // nothing re-fires embedBuffer on this path. Dropping the tokens
        // here left every ipmt block black until the next keystroke.
        cache.deleteSvgs(doc.uri.toString());
    });
    const subClose = vscode.workspace.onDidCloseTextDocument(doc => {
        if (doc.languageId !== 'markdown') return;
        cache.delete(doc.uri.toString());
        // VS Code restarts document versions at 1 on reopen, so a stale
        // high-water mark here would discard every subsequent render.
        appliedRenderVersion.delete(doc.uri.toString());
    });
    // Server-crash recovery. vscode-languageclient auto-respawns a crashed
    // server process ("Connection to server got closed. Server will
    // restart.") — but every embedBuffer that was in flight when it died
    // was rejected, so the LiveCache keeps whatever the PREVIOUS server
    // rendered and the preview shows stale SVGs until the user closes and
    // reopens the file. A crash mid-batch (e.g. right after a binary-change
    // restart) rejects EVERY in-flight eager fire at once ("Pending response
    // rejected since connection got disposed"), so whole documents go stale
    // in one stroke — not just a single block.
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
    // never trigger an embedBuffer until the first edit — so already-open
    // files would render uncolored until the user types.
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

interface EmbedBufferOptions {
    // Ask the server to skip the SVG layout and return source + tokens
    // only. Used by the per-keystroke color path.
    tokensOnly?: boolean;
    // High-water mark of applied document versions, per URI. Required for
    // calls that write SVGs; omitted (with tokensOnly) for token refreshes,
    // which cannot go out of order in a harmful way.
    appliedRenderVersion?: Map<string, number>;
}

async function runEmbedBuffer(
    client: LanguageClient,
    doc: vscode.TextDocument,
    cache: LiveCache,
    log: vscode.OutputChannel,
    opts: EmbedBufferOptions = {},
): Promise<void> {
    const uriStr = doc.uri.toString();
    // Snapshot the revision this request will describe. The buffer keeps
    // moving while the round trip is in flight.
    const requestVersion = doc.version;
    log.appendLine(`[live-refresh] -> ipm.embedBuffer ${uriStr}${opts.tokensOnly ? ' (tokensOnly)' : ''} v${requestVersion}`);
    let res: EmbedBufferResult | null = null;
    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= EMBED_NOT_OPEN_RETRIES; attempt++) {
        try {
            res = await client.sendRequest<EmbedBufferResult | null>(
                'workspace/executeCommand',
                {
                    command: 'ipm.embedBuffer',
                    arguments: [{ uri: uriStr, tokensOnly: opts.tokensOnly === true }],
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
        // Every response describes one whole revision of the document, so
        // its tokens form one generation. Rotating here (rather than per
        // block) keeps the map bounded at two responses' worth of entries
        // no matter how fast the user types.
        cache.beginTokenGeneration(uriStr);

        // An older response must not overwrite newer SVGs. Tokens are
        // exempt: keyed by their own source text, they can only ever be
        // served to a render of exactly that text.
        const applyRender = !opts.tokensOnly && shouldApplyRender(
            opts.appliedRenderVersion?.get(uriStr), requestVersion);
        if (applyRender) {
            opts.appliedRenderVersion?.set(uriStr, requestVersion);
        } else if (!opts.tokensOnly) {
            log.appendLine(`[live-refresh] discarding SVGs from superseded v${requestVersion}`);
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
            if (!applyRender || !b.svgBase64) {
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
