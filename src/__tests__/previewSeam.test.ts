// The seam: a real server response → the cache the extension keys by source →
// the real markdown-it renderer → coloured spans.
//
// previewHighlight.test.ts already covers the renderer against hand-written
// token records, and liveRefresh.test.ts covers the cache and the request
// shapes. Neither notices if the two stop fitting together — and that is the
// whole of what the user sees. When `ipm.liveRefresh: false` blanked every
// fence, the request-shape assertion was green: a call WAS issued, it simply
// carried nothing the renderer could use.
//
// So this test asserts the thing itself. Its input is a captured
// `ipm.embedBuffer` response (`npm run gen-fixture`, see
// scripts/gen-embed-fixture.ts), not a hand-written one, because a
// hand-written token list would test the renderer against our idea of the
// server rather than against the server.
//
// It fails if: the server's token shape drifts, `normalizeSource` stops
// matching markdown-it's `tok.content`, the generation rotation drops tokens
// the render still needs, or the class names stop matching the stylesheet.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import MarkdownIt from 'markdown-it';
import Module from 'node:module';

import { registerFenceHighlight, setTokenLookup } from '../extension/previewHighlight';
import { MODIFIER_NAMES, PALETTE, cssClassFor } from '../palette';

// liveRefresh.ts imports `vscode`; stub it so the real LiveCache can load.
const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_seam__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_seam__';
    return origResolve.call(this, request, ...rest);
};
for (const [id, exports] of [
    ['__ipm_vscode_stub_seam__', {
        workspace: {
            getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
            onDidChangeTextDocument: () => ({ dispose() { /* noop */ } }),
            onDidOpenTextDocument: () => ({ dispose() { /* noop */ } }),
            onDidSaveTextDocument: () => ({ dispose() { /* noop */ } }),
            onDidCloseTextDocument: () => ({ dispose() { /* noop */ } }),
            textDocuments: [],
        },
        commands: { executeCommand: () => Promise.resolve() },
    }],
    ['__ipm_lc_stub_seam__', {}],
] as const) {
    (require as unknown as { cache: Record<string, unknown> }).cache[id] = {
        id, filename: id, loaded: true, exports, children: [], paths: [],
    };
}
test.after(() => { moduleAny._resolveFilename = origResolve; });

const { LiveCache } = require('../extension/liveRefresh') as typeof import('../extension/liveRefresh');

interface Fixture {
    markdown: string;
    blocks: Array<{ source: string; tokens: Array<{ line: number; col: number; len: number; type: string; mods?: number }> }>;
}
const fixture = JSON.parse(
    fs.readFileSync(path.join(__dirname, 'fixtures', 'embedBuffer.json'), 'utf8'),
) as Fixture;

const URI = 'file:///fixture.md';

/** Exactly what the extension does on an embedBuffer response, then a render. */
function renderThroughCache(): string {
    const cache = new LiveCache();
    cache.beginTokenGeneration(URI);
    for (const b of fixture.blocks) {
        cache.setTokensForSource(URI, b.source, b.tokens);
    }
    setTokenLookup((uri, source) => cache.getTokensForSource(uri, source));
    try {
        const md = new MarkdownIt({ html: false });
        registerFenceHighlight(md);
        return md.render(fixture.markdown, { documentUri: URI });
    } finally {
        setTokenLookup(undefined);
    }
}

function fenceBody(html: string): string {
    const m = /<pre class="ipmt-block"><code class="language-ipmt">([\s\S]*?)<\/code><\/pre>/.exec(html);
    assert.ok(m, 'the fence did not render through our renderer at all');
    return m[1];
}

test('a real server response colours the fence it describes', () => {
    const body = fenceBody(renderThroughCache());
    const classes = new Set([...body.matchAll(/class="([^"]+)"/g)].map((m) => m[1]));

    assert.ok(classes.size >= 3,
        `expected several distinct token classes, got ${[...classes].join(', ') || 'none'} — ` +
        'a fence rendering with no spans is the "black fence" bug, and it is what a ' +
        'request-shape assertion cannot see');

    // Every class the renderer emits must be one the stylesheet defines,
    // otherwise the spans are there and invisible — which looks identical.
    for (const cls of classes) {
        assert.match(cls, /^ipm-/, `unexpected class ${cls} inside an ipmt fence`);
    }
});

test('every kind of token the server sent is painted by something', () => {
    const body = fenceBody(renderThroughCache());
    const rendered = new Set([...body.matchAll(/class="([^"]+)"/g)].map((m) => m[1]));

    // A token carrying a modifier renders as that modifier's class, not the
    // base one (ipmEvent.alias → ipm-e-alias, ipmArrow.partOf → ipm-P), so the
    // check is "some class from this type's family appeared". Which modifier
    // maps where is previewHighlight.test.ts's job; this one only insists that
    // no whole KIND of token silently stops being painted.
    const familyOf = (type: string): string[] => {
        const classes = [cssClassFor(type, undefined)];
        for (const mod of MODIFIER_NAMES) {
            if (PALETTE[type]?.[mod]) classes.push(cssClassFor(type, mod));
        }
        return classes;
    };

    const sent = [...new Set(fixture.blocks[0].tokens.map((t) => t.type))];

    // Check this FIRST: renderFromLspTokens skips types the palette does not
    // know, so a server-side rename would otherwise sail through the assertion
    // below by simply not being counted. That is the silent half of a legend
    // drift — the fence keeps rendering, one colour poorer.
    const unknown = sent.filter((type) => !PALETTE[type]);
    assert.deepEqual(unknown, [],
        'the server sent token types this build has no palette entry for. Either the ' +
        'legend drifted (see serverLegend.test.ts) or the palette needs regenerating ' +
        'with `npm run gen-palette`.');

    const unpainted = sent.filter((type) => !familyOf(type).some((c) => rendered.has(c)));
    assert.deepEqual(unpainted, [],
        'the server sent tokens of these kinds and the rendered fence has no span for any of them');
});

test('the cache keys by exactly what markdown-it hands the renderer', () => {
    // The Go side stores block content LF-joined with no trailing newline;
    // markdown-it's tok.content always has one. normalizeSource bridges that,
    // and if it ever stops, every lookup misses and every fence goes black
    // while every other test stays green.
    const cache = new LiveCache();
    cache.setTokensForSource(URI, fixture.blocks[0].source, fixture.blocks[0].tokens);

    const md = new MarkdownIt({ html: false });
    let handed: string | undefined;
    const original = md.renderer.rules.fence;
    md.renderer.rules.fence = (tokens, idx, opts, env, slf) => {
        if ((tokens[idx].info || '').trim() === 'ipmt') handed = tokens[idx].content;
        return original ? original(tokens, idx, opts, env, slf) : '';
    };
    md.render(fixture.markdown, {});

    assert.ok(handed, 'no ipmt fence in the fixture markdown');
    assert.ok(cache.getTokensForSource(URI, handed),
        `the cache cannot find tokens for what markdown-it renders.\n` +
        `  server source: ${JSON.stringify(fixture.blocks[0].source)}\n` +
        `  markdown-it:   ${JSON.stringify(handed)}`);
});

test('a cache miss renders the fence unstyled rather than wrong', () => {
    setTokenLookup(() => undefined);
    try {
        const md = new MarkdownIt({ html: false });
        registerFenceHighlight(md);
        const body = fenceBody(md.render(fixture.markdown, { documentUri: URI }));
        assert.ok(!body.includes('<span'),
            'with no tokens the fence must be plain: "briefly uncoloured" is the ' +
            'documented failure mode, "subtly miscoloured" is not');
    } finally {
        setTokenLookup(undefined);
    }
});
