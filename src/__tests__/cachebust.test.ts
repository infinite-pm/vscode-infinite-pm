// Tests for the cache-bust rule: when an ipm-svg marker precedes an image,
// the image's `src` must gain a `?v=<hash>` query so the rendered preview
// re-fetches the file when the on-disk SVG changes.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import MarkdownIt from 'markdown-it';

// Stub `vscode` so `liveRefresh.ts` (transitively imported via cachebust.ts's
// `import type` is type-only, but liveRefresh.ts itself imports vscode) can
// load cleanly in plain Node.
const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_cb__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_cb__';
    return origResolve.call(this, request, ...rest);
};
const stubCache = (id: string, exports: unknown) => {
    (require as unknown as { cache: Record<string, unknown> }).cache[id] = {
        id, filename: id, loaded: true, exports, children: [], paths: [],
    };
};
stubCache('__ipm_vscode_stub_cb__', {
    workspace: {
        getConfiguration: () => ({ get: (_: string, def: unknown) => def }),
        onDidChangeTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidSaveTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidCloseTextDocument: () => ({ dispose() { /* noop */ } }),
    },
    commands: { executeCommand: () => Promise.resolve() },
});
stubCache('__ipm_lc_stub_cb__', {});

const { registerCacheBust, setLiveCache } =
    require('../extension/cachebust') as typeof import('../extension/cachebust');
const { LiveCache } = require('../extension/liveRefresh') as typeof import('../extension/liveRefresh');

test.after(() => {
    setLiveCache(undefined);
    moduleAny._resolveFilename = origResolve;
});

function makeMd(): MarkdownIt {
    const md = new MarkdownIt({ html: true });
    registerCacheBust(md);
    return md;
}

test('marker before image: src gains ?v=<hash>', () => {
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](_ipm/foo/01.ipm.svg)\n',
    );
    assert.ok(out.includes('src="_ipm/foo/01.ipm.svg?v=ab12cd34"'),
        `expected ?v=ab12cd34; got:\n${out}`);
});

test('hash with extra attrs around it is parsed correctly', () => {
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=deadbeef path=./x.svg pos=before -->\n![](./x.svg)\n',
    );
    assert.ok(out.includes('src="./x.svg?v=deadbeef"'),
        `expected ?v=deadbeef; got:\n${out}`);
});

test('image without a preceding marker is left alone', () => {
    const out = makeMd().render('![](other.svg)\n');
    assert.ok(out.includes('src="other.svg"') && !out.includes('?v='),
        `plain image must not be modified; got:\n${out}`);
});

test('unrelated HTML comment does not trigger rewriting', () => {
    const out = makeMd().render('<!-- some other comment -->\n![](other.svg)\n');
    assert.ok(!out.includes('?v='), `should not rewrite; got:\n${out}`);
});

test('marker present but missing hash= attr is a no-op', () => {
    const out = makeMd().render('<!-- ipm-svg id=01 -->\n![](x.svg)\n');
    // Marker is malformed (no hash); rule can't compute a cache-buster.
    assert.ok(out.includes('src="x.svg"') && !out.includes('?v='),
        `no hash → no rewrite; got:\n${out}`);
});

test('src that already has a query string keeps it', () => {
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=ab -->\n![](x.svg?ref=42)\n',
    );
    // Both the original query and the cache-bust value must survive.
    // markdown-it HTML-escapes & in attributes, so the literal output is
    // `?ref=42&amp;v=ab`.
    assert.ok(out.includes('?ref=42&amp;v=ab'),
        `should preserve original query and add cache-bust; got:\n${out}`);
});

test('hash change actually changes the URL (the whole point)', () => {
    const md1 = makeMd();
    const md2 = makeMd();
    const a = md1.render('<!-- ipm-svg id=01 hash=aaaaaaaa -->\n![](x.svg)\n');
    const b = md2.render('<!-- ipm-svg id=01 hash=bbbbbbbb -->\n![](x.svg)\n');
    assert.notEqual(a, b, 'rendered HTML must differ when only the hash changes');
    assert.ok(a.includes('?v=aaaaaaaa') && b.includes('?v=bbbbbbbb'),
        `expected per-hash URLs; got a=${a}\nb=${b}`);
});

test('multiple markers each cache-bust their own image', () => {
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=aaaa1111 -->\n![](_ipm/a/01.svg)\n\n' +
        '<!-- ipm-svg id=02 hash=bbbb2222 -->\n![](_ipm/b/02.svg)\n',
    );
    assert.ok(out.includes('src="_ipm/a/01.svg?v=aaaa1111"'), `first miss: ${out}`);
    assert.ok(out.includes('src="_ipm/b/02.svg?v=bbbb2222"'), `second miss: ${out}`);
});

test('live cache: data URL replaces src when (uri, id) match', () => {
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE' });
    setLiveCache(cache);
    try {
        const md = makeMd();
        const env = { currentDocument: { uri: 'file:///x.md' } };
        const out = md.render(
            '<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](_ipm/x/01.ipm.svg)\n',
            env,
        );
        assert.ok(out.includes('src="data:image/svg+xml;base64,LIVE"'),
            `expected data URL substitution; got:\n${out}`);
        // Make sure the disk URL + ?v= is NOT used when the live entry wins.
        assert.ok(!out.includes('_ipm/x/01.ipm.svg'),
            `disk src leaked through despite live entry; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: missing entry falls back to disk ?v=<hash>', () => {
    const cache = new LiveCache();
    // Cache has data for id=02, but the marker says id=01.
    cache.set('file:///x.md', '02', { hash: 'bbbb', dataUrl: 'data:image/svg+xml;base64,WRONG' });
    setLiveCache(cache);
    try {
        const out = makeMd().render(
            '<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](_ipm/x/01.ipm.svg)\n',
            { currentDocument: { uri: 'file:///x.md' } },
        );
        assert.ok(out.includes('_ipm/x/01.ipm.svg?v=ab12cd34'),
            `expected disk ?v= fallback; got:\n${out}`);
        assert.ok(!out.includes('WRONG'), `wrong-id cache entry leaked; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: env without uri falls back to disk path', () => {
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE' });
    setLiveCache(cache);
    try {
        const out = makeMd().render('<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](x.svg)\n');
        // No env → no uri → no live lookup → disk path with cache-buster.
        assert.ok(out.includes('x.svg?v=ab12cd34'),
            `expected disk fallback when env missing; got:\n${out}`);
        assert.ok(!out.includes('LIVE'), `live entry used despite missing env; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: cleared cache reverts to disk behavior', () => {
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE' });
    setLiveCache(cache);
    setLiveCache(undefined); // simulate save-time eviction at the module level
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](x.svg)\n',
        { currentDocument: { uri: 'file:///x.md' } },
    );
    assert.ok(out.includes('x.svg?v=ab12cd34'), `expected disk fallback; got:\n${out}`);
});

test('live cache: ACTUAL VS Code env (currentDocument IS a vscode.Uri directly)', () => {
    // From vscode-src/extensions/markdown-language-features/src/markdownEngine.ts:
    //   readonly currentDocument: vscode.Uri | undefined;
    //   ...
    //   currentDocument: typeof input === 'string' ? undefined : input.uri,
    // i.e. env.currentDocument IS the Uri, not a wrapping document.
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE-VSCODE' });
    setLiveCache(cache);
    try {
        const env = {
            currentDocument: {
                scheme: 'file',
                authority: '',
                path: '/x.md',
                fsPath: '/x.md',
                toString() { return 'file:///x.md'; },
            },
            containingImages: new Set(),
            slugifier: {},
            resourceProvider: {},
        };
        const out = makeMd().render('<!-- ipm-svg id=01 hash=ab -->\n![](x.svg)\n', env);
        assert.ok(out.includes('data:image/svg+xml;base64,LIVE-VSCODE'),
            `Uri-as-currentDocument shape was not handled; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: VS Code-shaped env (currentDocument.uri is a Uri-like object)', () => {
    // VS Code's markdown preview passes `env.currentDocument` as a
    // SkinnyTextDocument whose `.uri` is a vscode.Uri instance — an object
    // with `scheme`, `fsPath`, etc., plus a `toString()` that returns the
    // URI string. Earlier extractor versions rejected this shape and
    // returned undefined, causing live-refresh to silently fall back to
    // the disk path. Regression guard.
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE' });
    setLiveCache(cache);
    try {
        const env = {
            currentDocument: {
                uri: {
                    scheme: 'file',
                    fsPath: '/x.md',
                    toString() { return 'file:///x.md'; },
                },
                version: 1,
            },
            // The other keys VS Code passes — extractor should ignore them.
            containingImages: {},
            slugifier: {},
            resourceProvider: {},
        };
        const out = makeMd().render('<!-- ipm-svg id=01 hash=ab -->\n![](x.svg)\n', env);
        assert.ok(out.includes('data:image/svg+xml;base64,LIVE'),
            `live URL did not win for VS Code-shape env; got:\n${out}`);
        assert.ok(!out.includes('x.svg?v='),
            `disk fallback fired even though live entry was available; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: env where currentDocument.uri is a plain string', () => {
    // Some VS Code versions / forks pass the URI as a plain string. The
    // extractor accepts that too.
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE2' });
    setLiveCache(cache);
    try {
        const env = { currentDocument: { uri: 'file:///x.md' } };
        const out = makeMd().render('<!-- ipm-svg id=01 hash=ab -->\n![](x.svg)\n', env);
        assert.ok(out.includes('data:image/svg+xml;base64,LIVE2'),
            `string-uri shape failed; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('live cache: data URL also wins for src that already had a query', () => {
    const cache = new LiveCache();
    cache.set('file:///x.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,LIVE' });
    setLiveCache(cache);
    try {
        const out = makeMd().render(
            '<!-- ipm-svg id=01 hash=ab12cd34 -->\n![](x.svg?ref=42)\n',
            { currentDocument: { uri: 'file:///x.md' } },
        );
        assert.ok(out.includes('src="data:image/svg+xml;base64,LIVE"'),
            `live entry should replace src wholesale; got:\n${out}`);
        assert.ok(!out.includes('ref=42'),
            `pre-existing query should not survive when data URL wins; got:\n${out}`);
    } finally {
        setLiveCache(undefined);
    }
});

test('prior v= between two other params is stripped without merging neighbours', () => {
    // Regression: a stale `v=old` sitting BETWEEN other query params must be
    // removed while keeping the `&` that separated its neighbours, so
    // `a=1&v=old&b=2` becomes `a=1&b=2&v=<new>` and never the bogus
    // `a=1b=2&v=<new>` (which would merge two params into one).
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=newhash -->\n![](x.svg?a=1&v=old&b=2)\n',
    );
    // markdown-it HTML-escapes `&` to `&amp;` in attributes.
    assert.ok(out.includes('src="x.svg?a=1&amp;b=2&amp;v=newhash"'),
        `expected a=1 and b=2 preserved and separated; got:\n${out}`);
    assert.ok(!out.includes('a=1b=2'),
        `neighbouring params were merged (the bug); got:\n${out}`);
    assert.ok(!out.includes('v=old'),
        `stale v=old leaked through; got:\n${out}`);
});

test('prior v= at the start of the query keeps the following params', () => {
    // `?v=old&b=2` must become `?b=2&v=<new>`, not drop or merge b=2.
    const out = makeMd().render(
        '<!-- ipm-svg id=01 hash=newhash -->\n![](x.svg?v=old&b=2)\n',
    );
    assert.ok(out.includes('src="x.svg?b=2&amp;v=newhash"'),
        `expected b=2 preserved; got:\n${out}`);
    assert.ok(!out.includes('v=old'),
        `stale v=old leaked through; got:\n${out}`);
});

test('reapplying preserves the latest hash (no duplicate v=)', () => {
    // Simulate a token whose src was already cache-busted by a prior run.
    // Render twice on the same md instance — the cache-buster must be the
    // value from THIS render, not stack with the prior one.
    const md = makeMd();
    md.render('<!-- ipm-svg id=01 hash=aaaaaaaa -->\n![](x.svg)\n');
    const out = md.render('<!-- ipm-svg id=01 hash=bbbbbbbb -->\n![](x.svg)\n');
    // Latest hash should be bbbbbbbb; no `v=aaaaaaaa` left over.
    assert.ok(out.includes('?v=bbbbbbbb'), `latest hash missing: ${out}`);
    assert.ok(!out.includes('v=aaaaaaaa'), `old hash leaked: ${out}`);
    // Exactly one v= per src.
    const match = out.match(/src="[^"]*"/);
    assert.ok(match && (match[0].match(/v=/g) || []).length === 1,
        `expected exactly one v=; got ${match?.[0]}`);
});
