// Tests for the fence renderer's ipmt syntax highlighting.
//
// The renderer is LSP-only: tokens come from the Go-side
// `ipm.embedBuffer` pipeline and feed into the fence renderer via the
// `setTokenLookup` hook. On cache miss the fence renderer emits plain
// text (no spans). These tests exercise that contract.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import MarkdownIt from 'markdown-it';
import { renderFromLspTokens, registerFenceHighlight, registerInlineIpmtHighlight, setTokenLookup } from '../extension/previewHighlight';

function makeMd(): MarkdownIt {
    const md = new MarkdownIt({ html: false });
    registerFenceHighlight(md);
    return md;
}

// makeMdWithInline matches VS Code's markdown preview config more
// closely: html: true so `<!--ipmt-->` comments parse as html_inline
// tokens. The inline ipmt rule needs that to find the marker.
function makeMdWithInline(): MarkdownIt {
    const md = new MarkdownIt({ html: true });
    registerFenceHighlight(md);
    registerInlineIpmtHighlight(md);
    return md;
}

test('renderFromLspTokens converts (line,col,len) records into ipm-* spans', () => {
    const src = 'wearB ::e --> swapT ::e\n';
    const tokens = [
        { line: 0, col: 0,  len: 5, type: 'ipmEvent' },                       // wearB
        { line: 0, col: 6,  len: 3, type: 'ipmEvent' },                       // ::e
        { line: 0, col: 10, len: 3, type: 'ipmArrow', mods: 1 << 1 },         // --> (leadsTo)
        { line: 0, col: 14, len: 5, type: 'ipmEvent' },                       // swapT
        { line: 0, col: 20, len: 3, type: 'ipmEvent' },                       // ::e
    ];
    const out = renderFromLspTokens(src, tokens);
    assert.ok(out.includes('<span class="ipm-e-title">wearB</span>'),
        `wearB not rendered as event; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-e-title">::e</span>'),
        `::e not rendered as event; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-L">--&gt;</span>'),
        `--> not rendered as arrow-leadsTo; got:\n${out}`);
});

test('renderFromLspTokens maps each ipmArrow modifier to its relation class', () => {
    const cases: Array<[number, string]> = [
        [1 << 1, 'L'],
        [1 << 2, 'P'],
        [1 << 3, 'X'],
        [1 << 4, 'N'],
    ];
    for (const [mod, cls] of cases) {
        const out = renderFromLspTokens('--\n', [
            { line: 0, col: 0, len: 2, type: 'ipmArrow', mods: mod },
        ]);
        assert.ok(out.includes(`<span class="ipm-${cls}">--</span>`),
            `mod ${mod} should map to ipm-${cls}; got:\n${out}`);
    }
});

test('renderFromLspTokens emits alias / hasAlias suffix per modifier', () => {
    // shortP::a long piece ::t
    //   shortP    → ipmThing with alias modifier      → ipm-t-alias
    //   long      → ipmThing with hasAlias modifier   → ipm-t-title-aliased
    //   piece     → ipmThing with hasAlias modifier   → ipm-t-title-aliased
    //   ::t       → ipmThing (no modifier)            → ipm-t-title
    const src = 'shortP::a long piece ::t\n';
    const MOD_ALIAS = 1 << 0;
    const MOD_HASALIAS = 1 << 5;
    const tokens = [
        { line: 0, col: 0,  len: 6, type: 'ipmThing', mods: MOD_ALIAS },     // shortP
        { line: 0, col: 10, len: 4, type: 'ipmThing', mods: MOD_HASALIAS },  // long
        { line: 0, col: 15, len: 5, type: 'ipmThing', mods: MOD_HASALIAS },  // piece
        { line: 0, col: 21, len: 3, type: 'ipmThing' },                      // ::t
    ];
    const out = renderFromLspTokens(src, tokens);
    assert.ok(out.includes('<span class="ipm-t-alias">shortP</span>'),
        `alias suffix missing; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-t-title-aliased">long</span>'),
        `hasAlias suffix missing for "long"; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-t-title-aliased">piece</span>'),
        `hasAlias suffix missing for "piece"; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-t-title">::t</span>'),
        `bare kind class missing for ::t; got:\n${out}`);
});

test('overlapping tokens — later wins per character (tooltip inside arrow)', () => {
    // `--"causes"-->` — arrow span covers the whole thing, tooltip
    // span covers `"causes"`. The later-emitted tooltip token must
    // win on its 8 characters; the surrounding dashes stay arrow.
    const src = '--"causes"-->';
    const tokens = [
        { line: 0, col: 0, len: 13, type: 'ipmArrow', mods: 1 << 1 },  // arrow leadsTo
        { line: 0, col: 2, len: 8,  type: 'ipmTooltip' },              // "causes"
    ];
    const out = renderFromLspTokens(src, tokens);
    assert.ok(out.includes('<span class="ipm-L">--</span>'),
        `leading dashes should be arrow-leadsTo; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-tooltip">&quot;causes&quot;</span>'),
        `tooltip text should be ipm-tooltip; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-L">--&gt;</span>'),
        `trailing arrow should be arrow-leadsTo; got:\n${out}`);
});

test('kind marker token gets the .marker class (bold) — identifier stays unmarked', () => {
    // `Alice ::e` — `Alice` is the identifier (ipmEvent, no modifier),
    // `::e` is the marker (ipmEvent, modMarker). Both end up
    // ipm-e-title-colored but only the marker is bold.
    const src = 'Alice ::e\n';
    const MOD_MARKER = 1 << 6;
    const tokens = [
        { line: 0, col: 0, len: 5, type: 'ipmEvent' },                   // Alice
        { line: 0, col: 6, len: 3, type: 'ipmEvent', mods: MOD_MARKER }, // ::e
    ];
    const out = renderFromLspTokens(src, tokens);
    assert.ok(out.includes('<span class="ipm-e-title">Alice</span>'),
        `identifier should be unmarked ipm-e-title; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-e-marker">::e</span>'),
        `::e should be ipm-e-marker (bold variant); got:\n${out}`);
});

test('overlapping tokens — relation marker punches through bold arrow', () => {
    // `--::L-->` — arrow span covers all 8 chars; ipmRelation overlays
    // `::L` (3 chars). Per-character last-wins gives us 3 runs:
    // `--` arrow, `::L` relation, `-->` arrow.
    const src = '--::L-->';
    const tokens = [
        { line: 0, col: 0, len: 8, type: 'ipmArrow', mods: 1 << 1 },
        { line: 0, col: 2, len: 3, type: 'ipmRelation' },
    ];
    const out = renderFromLspTokens(src, tokens);
    assert.ok(out.includes('<span class="ipm-L">--</span>'),
        `leading -- should be arrow-leadsTo; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-relation">::L</span>'),
        `::L should be ipm-relation; got:\n${out}`);
    assert.ok(out.includes('<span class="ipm-L">--&gt;</span>'),
        `trailing --> should be arrow-leadsTo; got:\n${out}`);
});

test('renderFromLspTokens covers the full token type table', () => {
    // One synthetic token per LSP type. We just want to confirm the
    // type → suffix mapping; positions are bogus but unambiguous.
    const cases: Array<[string, string]> = [
        ['ipmEvent', 'e-title'],
        ['ipmThing', 't-title'],
        ['ipmConcept', 'c-title'],
        ['ipmRelation', 'relation'],
        ['ipmArrow', 'arrow'],
        ['ipmTypeMarker', 'type-marker'],
        ['ipmComment', 'comment'],
        ['ipmString', 'string'],
        ['ipmTooltip', 'tooltip'],
    ];
    for (const [type, suffix] of cases) {
        const out = renderFromLspTokens('xx\n', [
            { line: 0, col: 0, len: 2, type },
        ]);
        assert.ok(out.includes(`<span class="ipm-${suffix}">xx</span>`),
            `${type} should map to ipm-${suffix}; got:\n${out}`);
    }
});

test('fence renderer emits spans when the LSP token cache has tokens', () => {
    setTokenLookup(() => [
        { line: 0, col: 0, len: 5, type: 'ipmEvent' },
        { line: 0, col: 6, len: 2, type: 'ipmArrow', mods: 1 << 1 },
    ]);
    try {
        const out = makeMd().render('```ipmt\nwearB --\n```\n');
        assert.ok(out.includes('<span class="ipm-e-title">wearB</span>'),
            `cached token path didn't fire; got:\n${out}`);
        assert.ok(out.includes('<span class="ipm-L">--</span>'),
            `cached arrow mod didn't apply; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('fence renderer emits PLAIN text (no spans) when the cache misses', () => {
    setTokenLookup(() => undefined);
    try {
        const out = makeMd().render('```ipmt\nA ::e --> B ::e\n```\n');
        // No ipm-* spans should appear on a cache miss.
        assert.ok(!/<span class="ipm-/.test(out),
            `cache-miss path emitted spans; got:\n${out}`);
        // The wrapping <pre class="ipmt-block"><code class="language-ipmt">
        // is still there (so the CSS background match applies) and the
        // raw text is HTML-escaped inside.
        assert.ok(out.includes('<pre class="ipmt-block"><code class="language-ipmt">'),
            `pre/code wrapper missing; got:\n${out}`);
        assert.ok(out.includes('A ::e --&gt; B ::e'),
            `escaped text body missing; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('fence renderer also emits plain text when no lookup hook is registered', () => {
    setTokenLookup(undefined);
    const out = makeMd().render('```ipmt\nA ::e --> B ::e\n```\n');
    assert.ok(!/<span class="ipm-/.test(out),
        `should not emit spans without a lookup hook; got:\n${out}`);
    assert.ok(out.includes('<pre class="ipmt-block"><code class="language-ipmt">'),
        `pre/code wrapper missing; got:\n${out}`);
});

test('cache hit path also emits the ipmt-block wrapper', () => {
    setTokenLookup(() => [{ line: 0, col: 0, len: 1, type: 'ipmEvent' }]);
    try {
        const out = makeMd().render('```ipmt\nA\n```\n');
        assert.ok(out.includes('<pre class="ipmt-block"><code class="language-ipmt">'),
            `cache-hit path missing ipmt-block wrapper; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('non-ipmt fence is left to the default markdown-it renderer', () => {
    const out = makeMd().render('```js\nconst x = 1;\n```\n');
    assert.ok(!out.includes('ipm-'), `js block should not get ipm-* spans; got:\n${out}`);
    assert.ok(out.includes('const x = 1'), `code body lost; got:\n${out}`);
});

test('html escaping survives — `<`, `>`, `&` inside cache-miss text', () => {
    setTokenLookup(undefined);
    const out = makeMd().render('```ipmt\nplain & < > text\n```\n');
    assert.ok(out.includes('plain &amp; &lt; &gt; text'),
        `html-escape broken; got:\n${out}`);
});

// ─── Inline ipmt (`<!--ipmt-->`code`` in prose) ──────────────────────

test('inline ipmt: marker + code emits language-ipmt with cached tokens', () => {
    setTokenLookup((_uri, src) => {
        if (src === 't-shirt ::c') {
            return [
                { line: 0, col: 0, len: 7, type: 'ipmConcept' },                  // t-shirt
                { line: 0, col: 8, len: 3, type: 'ipmConcept', mods: 1 << 6 },    // ::c (marker)
            ];
        }
        return undefined;
    });
    try {
        const out = makeMdWithInline().render('A taxonomy of <!--ipmt-->`t-shirt ::c`.\n');
        assert.ok(out.includes('<code class="language-ipmt">'),
            `language-ipmt class missing; got:\n${out}`);
        assert.ok(out.includes('<span class="ipm-c-title">t-shirt</span>'),
            `t-shirt span missing; got:\n${out}`);
        assert.ok(out.includes('<span class="ipm-c-marker">::c</span>'),
            `::c marker span missing; got:\n${out}`);
        // Marker comment MUST be consumed (the comment is invisible in
        // any renderer, but we still don't want it cluttering the DOM).
        assert.ok(!out.includes('<!--ipmt-->'),
            `marker comment leaked; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: cache miss emits language-ipmt with plain (escaped) content', () => {
    setTokenLookup(() => undefined);
    try {
        const out = makeMdWithInline().render('See <!--ipmt-->`a < b` here.\n');
        assert.ok(out.includes('<code class="language-ipmt">'),
            `language-ipmt missing on cache miss; got:\n${out}`);
        assert.ok(out.includes('a &lt; b'),
            `body should be html-escaped; got:\n${out}`);
        assert.ok(!/<span class="ipm-/.test(out),
            `cache miss should not emit spans; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: marker comment without code passes through (still suppressed)', () => {
    // A stray `<!--ipmt-->` with no following code: the marker
    // renderer suppresses it (it's an invisible comment anyway).
    const out = makeMdWithInline().render('Stray <!--ipmt--> marker.\n');
    assert.ok(!out.includes('<!--ipmt-->'),
        `stray marker should be suppressed; got:\n${out}`);
});

test('inline code without marker uses the default code_inline renderer', () => {
    setTokenLookup(() => [{ line: 0, col: 0, len: 1, type: 'ipmConcept' }]);
    try {
        const out = makeMdWithInline().render('Plain `not ipmt` code.\n');
        // No language-ipmt class — falls through to the default.
        assert.ok(!out.includes('language-ipmt'),
            `non-marker code should NOT get language-ipmt; got:\n${out}`);
        assert.ok(out.includes('<code>not ipmt</code>'),
            `default code_inline rendering broke; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: case-insensitive + whitespace-tolerant marker', () => {
    setTokenLookup((_uri, _src) => [
        { line: 0, col: 0, len: 1, type: 'ipmConcept' },
    ]);
    try {
        // Prefix with prose so markdown-it parses the comment as inline
        // HTML rather than a block-level HTML comment.
        const variants = [
            'See <!--ipmt-->`x` here.',
            'See <!-- ipmt -->`x` here.',
            'See <!--IPMT-->`x` here.',
            'See <!--   Ipmt   -->`x` here.',
        ];
        for (const v of variants) {
            const out = makeMdWithInline().render(v + '\n');
            assert.ok(out.includes('language-ipmt'),
                `variant ${JSON.stringify(v)} missed; got:\n${out}`);
        }
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: as-token marker is recognized; lookup stays by visible source', () => {
    // The server resolves the as-token NAME to a synthetic token and ships
    // it keyed by the visible source ("(orange)"). The preview only needs
    // to RECOGNIZE the marker and look up by tok.content — no NAME parsing.
    let lookedUpFor: string | undefined;
    setTokenLookup((_uri, src) => {
        lookedUpFor = src;
        if (src === '(orange)') {
            return [{ line: 0, col: 0, len: 8, type: 'ipmEvent', mods: 1 << 6 }];
        }
        return undefined;
    });
    try {
        const out = makeMdWithInline().render('Color is <!--ipmt:as-token:e-marker-->`(orange)` here.\n');
        assert.equal(lookedUpFor, '(orange)',
            `lookup must use the visible code; looked up ${JSON.stringify(lookedUpFor)}`);
        assert.ok(out.includes('<code class="language-ipmt"><span class="ipm-e-marker">(orange)</span></code>'),
            `as-token marker not rendered with the synthetic token; got:\n${out}`);
        assert.ok(!out.includes('<!--ipmt') && !out.includes('as-token'),
            `marker comment leaked; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: old cut=/as= syntax is NOT recognized (no backward compat)', () => {
    // The old attribute forms must be ignored — left as plain inline code,
    // no language-ipmt wrapper.
    setTokenLookup(() => [{ line: 0, col: 0, len: 3, type: 'ipmConcept', mods: 1 << 6 }]);
    try {
        for (const v of [
            'The <!--ipmt cut="cA ::c"-->`::c` marker.\n',
            'Color is <!--ipmt as="::e"-->`(orange)`.\n',
        ]) {
            const out = makeMdWithInline().render(v);
            assert.ok(!out.includes('language-ipmt'),
                `old syntax should NOT be highlighted; got:\n${out}`);
        }
    } finally {
        setTokenLookup(undefined);
    }
});

test('inline ipmt: as-token marker on cache miss still emits language-ipmt, no spans', () => {
    setTokenLookup(() => undefined);
    try {
        const out = makeMdWithInline().render('The <!--ipmt:as-token:c-marker-->`::c` marker.\n');
        assert.ok(out.includes('<code class="language-ipmt">'),
            `language-ipmt missing on cache miss; got:\n${out}`);
        assert.ok(!/<span class="ipm-/.test(out),
            `cache miss should not emit spans; got:\n${out}`);
        assert.ok(!out.includes('<!--ipmt'),
            `marker comment leaked; got:\n${out}`);
    } finally {
        setTokenLookup(undefined);
    }
});
