// Cache-bust ipm-svg image URLs in the VS Code markdown preview.
//
// Two paths feed into the same markdown-it rule:
//
//   1. Live (unsaved) — when the LiveCache holds a fresh data: URL for
//      the current document's block, the rule replaces the image's `src`
//      with that data URL. This is how preview reflects edits the user
//      hasn't saved yet (see liveRefresh.ts).
//
//   2. On-disk — fallback for blocks with no live entry. The marker's
//      `hash=<sha>` is appended to the image URL as `?v=<hash>`. The hash
//      changes whenever the saved source changes, so the URL changes,
//      VS Code's image cache misses, the new bytes are fetched.
//
// Both keep the original `![](path)` link intact in the .md — only the
// rendered `<img src=…>` is rewritten in-memory per render.
//
// The rule runs after `inline` parsing so the inline pass has already
// turned the `![](…)` syntax into image tokens with parsed attrs.

import type { LiveCache } from './liveRefresh';

const MARKER_LINE_RE = /<!--\s+ipm-svg(?:\s+([^>]*?))?\s+-->/;
const HASH_ATTR_RE = /\bhash=([^\s]+)/;
const ID_ATTR_RE = /\bid=([^\s]+)/;

interface MdToken {
    type: string;
    content: string;
    info?: string;
    children?: MdToken[] | null;
    attrIndex?: (name: string) => number;
    attrGet?: (name: string) => string | null;
    attrSet?: (name: string, value: string) => void;
    meta?: Record<string, unknown> | null;
}

interface MdState {
    tokens: MdToken[];
    env?: Record<string, unknown> | null;
}

interface MarkerAttrs {
    id: string | null;
    hash: string;
}

// Module-level live cache pointer. The runtime extension sets this once
// during activate(); tests can inject a fake. When undefined (e.g. unit
// tests of cachebust.ts in isolation) the rule falls back to the on-disk
// cache-buster path only — keeping the previous behavior.
let liveCache: LiveCache | undefined;

// Optional diagnostic log sink. The extension wires the output channel in
// during activate; tests leave it undefined.
let debugLog: ((line: string) => void) | undefined;

export function setLiveCache(cache: LiveCache | undefined): void {
    liveCache = cache;
}

export function setDebugLog(fn: ((line: string) => void) | undefined): void {
    debugLog = fn;
}

function extractMarker(commentContent: string): MarkerAttrs | null {
    if (!MARKER_LINE_RE.test(commentContent)) {
        return null;
    }
    const hashMatch = commentContent.match(HASH_ATTR_RE);
    if (!hashMatch) return null;
    const idMatch = commentContent.match(ID_ATTR_RE);
    return { hash: hashMatch[1], id: idMatch ? idMatch[1] : null };
}

function appendCacheBuster(src: string, hash: string): string {
    // Strip any prior `v=…` we might have written on a previous render;
    // a token might be re-rendered if the preview re-runs without a
    // fresh parse (rare but cheap to handle).
    // When the prior `v=` sits between other params we must put a
    // separator back so we don't merge the neighbours: `a=1&v=old&b=2`
    // must become `a=1&b=2`, not `a=1b=2`. Keep the leading `?` when the
    // match started the query; otherwise keep the trailing `&` (if any).
    const cleaned = src
        .replace(/([?&])v=[^&]*(&|$)/, (_m, lead, trail) => (lead === '?' ? '?' : trail))
        .replace(/[?&]$/, '');
    const sep = cleaned.includes('?') ? '&' : '?';
    return `${cleaned}${sep}v=${hash}`;
}

// extractEnvUri tries to pull a URI string out of the markdown-it `env`
// object that VS Code's preview passes through. The shape isn't formally
// part of the public API; we probe a few likely keys defensively. Returns
// undefined when nothing useful is present (tests, third-party renderers).
function extractEnvUri(env: Record<string, unknown> | null | undefined): string | undefined {
    if (!env) return undefined;
    // Test harness shortcut: pass `documentUri` as a plain string.
    if (typeof env.documentUri === 'string') return env.documentUri;

    // VS Code's markdown preview puts the source document's URI on
    // `env.currentDocument` *directly* (as a vscode.Uri). Older / forked
    // engines sometimes wrap it in a SkinnyTextDocument with `.uri`
    // instead. We try both shapes plus a few synthetic fallbacks.
    //
    // Verified against vscode-src/extensions/markdown-language-features/
    // src/markdownEngine.ts:88 (`readonly currentDocument: vscode.Uri |
    // undefined`) and line 218 (`currentDocument: input.uri`).
    const cd = env.currentDocument;
    if (typeof cd === 'string') return cd;
    if (cd && typeof cd === 'object') {
        const obj = cd as Record<string, unknown>;
        // Shape #1 (current VS Code): currentDocument IS a vscode.Uri.
        // Distinguishing fingerprint: an own/proto `scheme` field plus a
        // toString() that returns the URI string. Try that first.
        const cdAsUri = obj as { scheme?: unknown; toString?: () => string };
        if (cdAsUri.scheme !== undefined && typeof cdAsUri.toString === 'function') {
            try {
                const s = cdAsUri.toString();
                if (s && s !== '[object Object]') return s;
            } catch { /* getter threw; fall through */ }
        }
        // Shape #2: currentDocument is a document-like object wrapping
        // the Uri at `.uri`.
        const uri = obj.uri;
        if (typeof uri === 'string') return uri;
        if (uri && typeof uri === 'object') {
            const u = uri as { scheme?: unknown; toString?: () => string };
            if (typeof u.toString === 'function') {
                try {
                    const s = u.toString();
                    if (s && s !== '[object Object]') return s;
                } catch { /* */ }
            }
        }
        // Synthetic fallbacks.
        if (typeof obj.fileName === 'string') return 'file://' + (obj.fileName as string);
        if (typeof obj.path === 'string') return 'file://' + (obj.path as string);
        if (typeof obj.fsPath === 'string') return 'file://' + (obj.fsPath as string);
    }
    // Some engines pass a top-level URI string under a different key.
    if (typeof env.uri === 'string') return env.uri as string;
    return undefined;
}

// rewriteIpmSvgImages runs as a markdown-it CORE rule (after inline parsing).
// VS Code's markdown preview hits the parse pass with `env.currentDocument
// = undefined` (see vscode-src markdownEngine.ts:198–204) — only the
// later render pass carries the actual document URI. So we DON'T do the
// URI lookup here; we just tag each marker-following image token with
// `{id, hash}` via token.meta. The render-time image renderer
// (registerImageRender below) does the actual src substitution against
// the real env.
export function rewriteIpmSvgImages(state: MdState): void {
    const tokens = state.tokens;
    let markersSeen = 0;
    let taggedImages = 0;
    for (let i = 0; i < tokens.length; i++) {
        const tok = tokens[i];
        if (tok.type !== 'html_block') continue;
        const marker = extractMarker(tok.content);
        if (!marker) continue;
        markersSeen++;

        // Walk forward to the next paragraph's inline token.
        for (let j = i + 1; j < tokens.length; j++) {
            const t = tokens[j];
            if (t.type === 'paragraph_open') continue;
            if (t.type === 'paragraph_close') break;
            if (t.type !== 'inline') break;
            const children = t.children;
            if (!children) break;
            for (const child of children) {
                if (child.type !== 'image') continue;
                if (!child.attrGet || !child.attrSet) continue;
                const src = child.attrGet('src');
                if (!src) continue;
                child.meta = {
                    ...(child.meta ?? {}),
                    ipmMarker: { id: marker.id, hash: marker.hash },
                };
                taggedImages++;
            }
            break;
        }
    }
    if (debugLog && markersSeen > 0) {
        debugLog(`[cachebust] parse: markers=${markersSeen} tagged-images=${taggedImages}`);
    }
}

interface ImageMeta {
    // `id` mirrors MarkerAttrs.id, which is null when the marker comment
    // carries no `id=` attribute (extractMarker above). Keep it nullable
    // so consumers handle the no-id case explicitly.
    ipmMarker?: { id: string | null; hash: string };
}

// renderTagged is the image-token render override. By the time this runs,
// `env.currentDocument` IS the Uri the markdown preview is rendering for
// (markdownEngine.ts:217). For each image our parse-time rule tagged with
// an ipm marker, swap src to the data URL when the live cache has a fresh
// entry; otherwise apply `?v=<hash>` on the disk URL.
type RenderRule = (
    tokens: MdToken[], idx: number, options: unknown, env: Record<string, unknown> | undefined, slf: unknown,
) => string;

function renderTagged(
    defaultImage: RenderRule,
    tokens: MdToken[],
    idx: number,
    options: unknown,
    env: Record<string, unknown> | undefined,
    slf: unknown,
): string {
    const tok = tokens[idx];
    const meta = (tok.meta ?? {}) as ImageMeta;
    if (!meta.ipmMarker) {
        return defaultImage(tokens, idx, options, env, slf);
    }
    const m = meta.ipmMarker;
    const docUri = extractEnvUri(env);
    if (debugLog) {
        debugLog(`[cachebust] render-image: uri=${docUri ?? '(none)'} marker.id=${m.id} hash=${m.hash} live-cache=${liveCache ? 'present' : 'absent'}`);
    }
    if (tok.attrGet && tok.attrSet) {
        const src = tok.attrGet('src');
        if (src) {
            if (liveCache && docUri && m.id) {
                const live = liveCache.get(docUri, m.id);
                if (live) {
                    tok.attrSet('src', live.dataUrl);
                    if (debugLog) debugLog(`[cachebust] render-image: -> data URL (live hit, ${live.dataUrl.length}B)`);
                    return defaultImage(tokens, idx, options, env, slf);
                }
            }
            tok.attrSet('src', appendCacheBuster(src, m.hash));
            if (debugLog) debugLog(`[cachebust] render-image: -> disk + ?v=${m.hash}`);
        }
    }
    return defaultImage(tokens, idx, options, env, slf);
}

export function registerCacheBust(md: {
    core: { ruler: { after: (anchor: string, name: string, fn: (state: MdState) => void) => void } };
    renderer: { rules: Record<string, RenderRule | undefined> };
}): void {
    md.core.ruler.after('inline', 'ipm-cache-bust', rewriteIpmSvgImages);
    const originalImage = md.renderer.rules['image'] ||
        ((tokens: MdToken[], idx: number, options: unknown, env: Record<string, unknown> | undefined, slf: { renderToken: (t: MdToken[], i: number, o: unknown) => string }) =>
            slf.renderToken(tokens, idx, options));
    md.renderer.rules['image'] = function (tokens, idx, options, env, slf) {
        return renderTagged(originalImage as RenderRule, tokens, idx, options, env, slf);
    };
}
