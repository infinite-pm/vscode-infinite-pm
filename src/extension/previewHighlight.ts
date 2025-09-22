// Syntax highlighting for ```ipmt``` code blocks in the VS Code markdown
// preview.
//
// SINGLE SOURCE OF TRUTH: the Go-side tokenizer in cmd/ipm-rpc/tokens.go.
// Every coloring decision (which identifier is an event, which arrow has
// PartOf modifier, where tooltips begin and end) comes from there.
//
// Flow:
//   1. The live-refresh listener (liveRefresh.ts) calls `ipm.embedBuffer`
//      on every debounced edit, on document open, and at activation for
//      already-open markdown files. The response includes block-relative
//      semantic tokens.
//   2. Tokens are cached in LiveCache keyed by URI + raw block source.
//   3. The markdown-it `fence` renderer override below looks up tokens
//      for the current block. On hit, it emits `<span class>` markup.
//      On miss (cold start, LSP not installed, block not yet processed),
//      it emits plain `<pre><code>` — no coloring. The eager-fire pipeline
//      populates the cache and calls `markdown.preview.refresh`, so the
//      preview re-renders with colors within a few hundred milliseconds.
//
// Why no regex fallback: every standalone heuristic eventually disagreed
// with the editor pane in one corner case or another (relation letter
// split, alias/hasAlias modifier flattening, edge-tooltip dash colors).
// "Briefly uncolored" is a clearer failure mode than "subtly wrong
// colors" — and the LSP path is normally warm within ~200ms of opening
// a file.

import { PALETTE, cssClassFor } from '../palette';

interface MdToken {
    type: string;
    info?: string;
    content: string;
    children?: MdToken[] | null;
}

type FenceRenderer = (
    tokens: MdToken[], idx: number, options: unknown, env: unknown, slf: unknown,
) => string;

// LSP token shape — matches `BufferToken` in liveRefresh.ts and the Go
// `bufferToken` struct in cmd/ipm-rpc/embed_buffer.go.
export interface PreviewToken {
    line: number;
    col: number;
    len: number;
    type: string;
    mods?: number;
}

// Bitmask modifiers, matching the Go `semanticTokenModifiers` order in
// cmd/ipm-rpc/tokens.go.
const MOD_ALIAS     = 1 << 0;
const MOD_LEADSTO   = 1 << 1;
const MOD_PARTOF    = 1 << 2;
const MOD_EXPRESSES = 1 << 3;
const MOD_NEARTO    = 1 << 4;
const MOD_HASALIAS  = 1 << 5;
const MOD_MARKER    = 1 << 6;

// modifierFor returns the palette modifier name encoded in a bitmask
// for a given semantic-token type. Only one modifier per token can win
// — alias / hasAlias / marker for kind tokens; relation modifier for
// arrows. Returns undefined to mean "base palette entry" (no modifier).
function modifierFor(type: string, mods: number): import('../palette').ModifierName | undefined {
    if (type === 'ipmArrow') {
        if (mods & MOD_LEADSTO) return 'leadsTo';
        if (mods & MOD_PARTOF) return 'partOf';
        if (mods & MOD_EXPRESSES) return 'expresses';
        if (mods & MOD_NEARTO) return 'nearTo';
        return undefined;
    }
    if (type === 'ipmEvent' || type === 'ipmThing' || type === 'ipmConcept') {
        // marker (the `::e` / `::t` / `::c` syntactic marker) wins over
        // alias / hasAlias since it's the most specific role. In
        // practice these modifier bits are mutually exclusive on a
        // given token, but we order them defensively.
        if (mods & MOD_MARKER) return 'marker';
        if (mods & MOD_HASALIAS) return 'hasAlias';
        if (mods & MOD_ALIAS) return 'alias';
        return undefined;
    }
    return undefined;
}

// renderFromLspTokens converts LSP-emitted block tokens into HTML with
// `<span class="ipm-…">` markers. Tokens are block-relative; we use a
// line-start index to map (line, col, len) to offsets in `src`.
//
// Overlap resolution: LAST WINS PER CHARACTER. The LSP emits
// overlapping tokens by design — an arrow span covers an embedded
// tooltip, and a relation marker (`::L`) sits inside the arrow span —
// so subsequent (later-emitted) tokens override earlier ones at
// overlapping positions. This matches VS Code's editor-pane resolution
// so the preview pane shows the same per-character class.
//
// The CSS class name is derived from the palette config (palette.ts),
// which is the single source of truth shared with gen-palette.ts. So
// the class names this function emits CANNOT diverge from the CSS
// classes defined in ipm-preview.css.
//
// LSP token columns are UTF-16 code units. The source string is JS's
// native UTF-16, so a (col, len) pair lines up with `.slice(col,
// col+len)` on the relevant line.
export function renderFromLspTokens(src: string, tokens: PreviewToken[]): string {
    const lineStarts: number[] = [0];
    for (let i = 0; i < src.length; i++) {
        if (src[i] === '\n') lineStarts.push(i + 1);
    }
    // Per-character winning class, indexed by absolute offset in `src`.
    // `undefined` means no token covers that character.
    const classAt: Array<string | undefined> = new Array(src.length);
    for (const t of tokens) {
        if (t.line >= lineStarts.length) continue;
        if (!PALETTE[t.type]) continue;
        const modifier = modifierFor(t.type, t.mods ?? 0);
        const cls = cssClassFor(t.type, modifier);
        const start = lineStarts[t.line] + t.col;
        const end = start + t.len;
        if (end <= start || end > src.length) continue;
        for (let i = start; i < end; i++) {
            classAt[i] = cls;
        }
    }
    // Walk the source emitting runs of consecutive same-class characters.
    let html = '';
    let runStart = 0;
    let runClass = classAt[0];
    for (let i = 1; i <= src.length; i++) {
        const cls = i < src.length ? classAt[i] : undefined;
        if (cls !== runClass) {
            const text = src.slice(runStart, i);
            if (runClass !== undefined) {
                html += `<span class="${runClass}">${escapeHtml(text)}</span>`;
            } else {
                html += escapeHtml(text);
            }
            runStart = i;
            runClass = cls;
        }
    }
    return html;
}

function escapeHtml(text: string): string {
    return text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#039;');
}

// Cache lookup hook — the extension wires it during activate() to read
// LSP-emitted tokens for the currently-rendering URI. Returns undefined
// when no cache is available or no entry matches; the fence renderer
// then emits plain text (no spans).
type TokenLookup = (uri: string | undefined, source: string) => PreviewToken[] | undefined;
let tokenLookup: TokenLookup | undefined;
export function setTokenLookup(fn: TokenLookup | undefined): void {
    tokenLookup = fn;
}

// Debug log sink — the extension wires this during activate() so the
// fence renderer's hit/miss decisions land in the same output channel
// as the cachebust logs.
let debugLog: ((line: string) => void) | undefined;
export function setHighlightDebugLog(fn: ((line: string) => void) | undefined): void {
    debugLog = fn;
}

// extractEnvUri mirrors the URI probe in cachebust.ts. We keep a local
// copy here so previewHighlight has no extension-runtime dependency.
function extractEnvUri(env: unknown): string | undefined {
    if (!env || typeof env !== 'object') return undefined;
    const e = env as Record<string, unknown>;
    if (typeof e.documentUri === 'string') return e.documentUri;
    const cd = e.currentDocument;
    if (typeof cd === 'string') return cd;
    if (cd && typeof cd === 'object') {
        const obj = cd as { scheme?: unknown; toString?: () => string; uri?: unknown };
        if (obj.scheme !== undefined && typeof obj.toString === 'function') {
            try {
                const s = obj.toString();
                if (s && s !== '[object Object]') return s;
            } catch { /* ignore */ }
        }
        if (typeof obj.uri === 'string') return obj.uri;
    }
    return undefined;
}

// inlineIpmtMarkerRE matches the two inline marker forms — bare
// `<!--ipmt-->` and `<!--ipmt:as-token:NAME-->`. Mirrors the Go-side
// regex in pkg/markdown/inlineipmt.go: case-insensitive on the keywords,
// whitespace tolerant. The old `cut=`/`as=` attribute forms do NOT match
// (no backward compatibility).
//
// The token colors are computed server-side (the LSP resolves the marker
// and ships tokens keyed by the visible source string), so the preview
// only needs to RECOGNIZE the marker here and look up by source.
const inlineIpmtMarkerRE = /^\s*<!--\s*ipmt(?::as-token:[A-Za-z0-9-]+)?\s*-->\s*$/i;

// registerInlineIpmtHighlight overrides the markdown-it `code_inline`
// and `html_inline` renderers to handle the inline ipmt convention:
//
//   `<!--ipmt-->` followed (optionally with whitespace) by a backtick
//   code span — the marker is consumed, the code span renders as
//   `<code class="language-ipmt">…</code>` with per-token spans, just
//   like a fenced ```ipmt``` block.
//
// Tokens are looked up via the LiveCache by the inline code's source
// string. On a miss we emit the plain content with the language class;
// the live-refresh pipeline will populate the cache and trigger a
// preview re-render shortly after.
export function registerInlineIpmtHighlight(md: {
    renderer: { rules: Record<string, FenceRenderer | undefined> };
}): void {
    const originalCodeInline = md.renderer.rules['code_inline'];
    const originalHtmlInline = md.renderer.rules['html_inline'];

    md.renderer.rules['code_inline'] = function (tokens, idx, options, env, slf) {
        const prev = idx > 0 ? tokens[idx - 1] : undefined;
        if (prev && prev.type === 'html_inline' && inlineIpmtMarkerRE.test(prev.content)) {
            const tok = tokens[idx];
            const uri = tokenLookup ? extractEnvUri(env) : undefined;
            const cached = tokenLookup ? tokenLookup(uri, tok.content) : undefined;
            if (debugLog) {
                const head = tok.content.slice(0, 40);
                debugLog(`[highlight] inline: uri=${uri ?? '(none)'} tokens=${cached ? cached.length : 0} src=${head}`);
            }
            if (cached && cached.length > 0) {
                return `<code class="language-ipmt">${renderFromLspTokens(tok.content, cached)}</code>`;
            }
            return `<code class="language-ipmt">${escapeHtml(tok.content)}</code>`;
        }
        if (originalCodeInline) return originalCodeInline(tokens, idx, options, env, slf);
        return `<code>${escapeHtml(tokens[idx].content)}</code>`;
    };

    md.renderer.rules['html_inline'] = function (tokens, idx, options, env, slf) {
        const tok = tokens[idx];
        if (inlineIpmtMarkerRE.test(tok.content)) {
            return '';
        }
        if (originalHtmlInline) return originalHtmlInline(tokens, idx, options, env, slf);
        return tok.content;
    };
}

export function registerFenceHighlight(md: {
    renderer: { rules: Record<string, FenceRenderer | undefined> };
}): void {
    const original = md.renderer.rules['fence'];
    md.renderer.rules['fence'] = function (tokens, idx, options, env, slf) {
        const tok = tokens[idx];
        const lang = (tok.info || '').trim().split(/\s+/)[0];
        if (lang !== 'ipmt') {
            if (original) return original(tokens, idx, options, env, slf);
            return `<pre><code>${escapeHtml(tok.content)}</code></pre>`;
        }
        const uri = tokenLookup ? extractEnvUri(env) : undefined;
        const cached = tokenLookup ? tokenLookup(uri, tok.content) : undefined;
        if (debugLog) {
            const head = tok.content.slice(0, 40).replace(/\n/g, '\\n');
            debugLog(`[highlight] fence: uri=${uri ?? '(none)'} lookup=${tokenLookup ? 'present' : 'absent'} tokens=${cached ? cached.length : 0} src.len=${tok.content.length} src.head=${head}`);
        }
        // Both paths emit `<pre class="ipmt-block">` so the preview CSS can
        // pull `--vscode-editor-background` for the block, matching the
        // editor pane's background and eliminating simultaneous-contrast
        // differences in the colored tokens.
        if (cached && cached.length > 0) {
            return `<pre class="ipmt-block"><code class="language-ipmt">${renderFromLspTokens(tok.content, cached)}</code></pre>\n`;
        }
        // Cache miss — emit plain text. The live-refresh pipeline will
        // populate the cache shortly and trigger a preview re-render.
        return `<pre class="ipmt-block"><code class="language-ipmt">${escapeHtml(tok.content)}</code></pre>\n`;
    };
}
