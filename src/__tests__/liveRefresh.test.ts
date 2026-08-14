// Tests for liveRefresh.ts, in three groups:
//
//   * the pure parts — LiveCache's data shape, token generations, eviction,
//     CRLF/trailing-newline normalization, SingleFlight, cooldownMs, and the
//     isTransientEmbedError predicate;
//   * the wiring — every listener wireLiveRefresh registers is fired here, and
//     the subscription count is asserted so a new one cannot arrive untested;
//   * setting blast radius — each setting the extension reads live is flipped,
//     and the observables it does NOT own are asserted unchanged.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// Stub vscode before importing liveRefresh (it imports `vscode` at the
// top of the file). Same shim as serverPath.test.ts.
const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_live__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_live__';
    return origResolve.call(this, request, ...rest);
};
// Settings the stubbed `vscode.workspace.getConfiguration` reports; empty
// means "extension default". Tests that care set entries and reset after.
const settings: Record<string, unknown> = {};
// Event handlers wireLiveRefresh registers, captured so a test can fire them.
const listeners: Record<string, ((arg: never) => void) | undefined> = {};
const capture = (name: string) => (fn: (arg: never) => void) => {
    listeners[name] = fn;
    return { dispose() { /* noop */ } };
};

(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_vscode_stub_live__'] = {
    id: '__ipm_vscode_stub_live__', filename: '__ipm_vscode_stub_live__',
    loaded: true, exports: {
        workspace: {
            // Section-aware on purpose. A stub that ignores the section argues
            // that `getConfiguration('ipmt')` reads our settings, and every
            // test would pass against a typo'd section that reads nothing.
            getConfiguration: (section?: string) => ({
                get: (key: string, def: unknown) =>
                    (section === 'ipm' && key in settings ? settings[key] : def),
            }),
            onDidChangeTextDocument: capture('change'),
            onDidOpenTextDocument: capture('open'),
            onDidSaveTextDocument: capture('save'),
            onDidCloseTextDocument: capture('close'),
            textDocuments: [] as unknown[],
        },
        commands: { executeCommand: () => Promise.resolve() },
    }, children: [], paths: [],
};
(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_lc_stub_live__'] = {
    id: '__ipm_lc_stub_live__', filename: '__ipm_lc_stub_live__',
    loaded: true, exports: {}, children: [], paths: [],
};

test.after(() => { moduleAny._resolveFilename = origResolve; });

const { LiveCache, SingleFlight, cooldownMs, shouldApplyRender, isTransientEmbedError, wireLiveRefresh } =
    require('../extension/liveRefresh') as typeof import('../extension/liveRefresh');

// --- ipm.liveRefresh gates diagrams, never colors -----------------------
// Found the hard way: a demo scene set ipm.liveRefresh=false to keep the
// preview showing the committed diagram, and every ipmt fence in that
// preview rendered black. The setting had been gating every embedBuffer
// call, and the markdown preview has no other source of tokens — so a
// switch about diagrams was silently turning off syntax highlighting.

interface RecordedRequest { command: string; args: Record<string, unknown> }

function wireWithFakes(cache = new LiveCache()): { requests: RecordedRequest[]; cache: LiveCache; subscriptions: unknown[] } {
    const requests: RecordedRequest[] = [];
    const client = {
        sendRequest: (_method: string, params: { command: string; arguments: unknown[] }) => {
            requests.push({
                command: params.command,
                args: (params.arguments[0] ?? {}) as Record<string, unknown>,
            });
            return Promise.resolve({ uri: 'file:///a.md', blocks: [] });
        },
        onDidChangeState: () => ({ dispose() { /* noop */ } }),
    };
    const ctx = { subscriptions: [] as unknown[] };
    const log = { appendLine() { /* noop */ } };

    wireLiveRefresh(
        ctx as never,
        client as never,
        cache,
        log as never,
    );
    return { requests, cache, subscriptions: ctx.subscriptions };
}

const fakeDoc = {
    uri: { toString: () => 'file:///a.md', fsPath: '/a.md' },
    languageId: 'markdown',
    version: 2,
};

test('a text change still refreshes colors when ipm.liveRefresh is off', async () => {
    // The stub answers only for the 'ipm' section, so this is what
    // `getConfiguration('ipm').get('liveRefresh')` reads.
    settings['liveRefresh'] = false;
    try {
        const { requests } = wireWithFakes();
        listeners['change']?.({ document: fakeDoc } as never);
        await new Promise(resolve => setImmediate(resolve));

        assert.deepEqual(
            requests.map(r => `${r.command} tokensOnly=${r.args.tokensOnly}`),
            ['ipm.embedBuffer tokensOnly=true'],
            'colors must refresh, and must not drag a diagram render along with them',
        );
    } finally {
        delete settings['liveRefresh'];
    }
});

test('a text change refreshes both colors and diagrams by default', async () => {
    const { requests } = wireWithFakes();
    listeners['change']?.({ document: fakeDoc } as never);
    await new Promise(resolve => setImmediate(resolve));

    assert.deepEqual(requests.map(r => r.args.tokensOnly), [true],
        'the immediate call is colors-only; the diagram follows on the debounce');
});

// --- every handler this wires must be fired by a test -----------------
// The save handler was registered from the start and never once fired by a
// test. It evicted the whole live cache, tokens included, and nothing re-fired
// the server on that path — so saving a .md left every ipmt fence in the
// preview black until the next keystroke. Twenty lines here would have caught
// it, in a harness that already captured the listener.
//
// The count assertion is the part that generalises: a sixth subscription added
// without a test fails this, rather than joining `save` in the four years
// nobody noticed.

test('wireLiveRefresh registers exactly the handlers these tests fire', () => {
    const { subscriptions } = wireWithFakes();
    assert.equal(subscriptions.length, 5,
        'wireLiveRefresh registered a subscription these tests do not exercise — ' +
        'fire it below, then update this count');
    assert.deepEqual(Object.keys(listeners).sort(), ['change', 'close', 'open', 'save'],
        'the workspace listeners captured by the stub changed; a new one needs a test');
});

test('saving evicts the rendered SVGs and KEEPS the tokens', async () => {
    const cache = new LiveCache();
    const { requests } = wireWithFakes(cache);
    const tokens = [{ line: 0, col: 0, len: 2, type: 'ipmEvent' }];
    cache.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'data:image/svg+xml;base64,XXX' });
    cache.setTokensForSource('file:///a.md', 'e1 ::e', tokens);

    listeners['save']?.(fakeDoc as never);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(cache.get('file:///a.md', '01'), undefined,
        'the on-disk SVGs are authoritative again after a save');
    assert.deepEqual(cache.getTokensForSource('file:///a.md', 'e1 ::e'), tokens,
        'colors must survive a save: the text did not change, and nothing re-fires here');
    assert.deepEqual(requests, [],
        'nothing re-fires the server on the save path — which is exactly why the ' +
        'tokens have to survive it');
});

test('closing a document drops everything for it', async () => {
    const cache = new LiveCache();
    wireWithFakes(cache);
    cache.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'data:x' });
    cache.setTokensForSource('file:///a.md', 'e1 ::e', [{ line: 0, col: 0, len: 2, type: 'ipmEvent' }]);

    listeners['close']?.(fakeDoc as never);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(cache.get('file:///a.md', '01'), undefined);
    assert.equal(cache.getTokensForSource('file:///a.md', 'e1 ::e'), undefined,
        'a closed document keeps nothing — its versions restart at 1 on reopen');
});

test('opening a markdown document fetches its colors eagerly', async () => {
    const { requests } = wireWithFakes();
    listeners['open']?.(fakeDoc as never);
    await new Promise(resolve => setImmediate(resolve));

    assert.equal(requests.length, 1, 'a cold open must not wait for the first keystroke');
    assert.equal(requests[0].command, 'ipm.embedBuffer');
});

test('non-markdown documents are ignored on the save and close paths too', async () => {
    const cache = new LiveCache();
    wireWithFakes(cache);
    cache.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'data:x' });

    listeners['save']?.({ ...fakeDoc, languageId: 'ipmt' } as never);
    listeners['close']?.({ ...fakeDoc, languageId: 'ipmt' } as never);
    await new Promise(resolve => setImmediate(resolve));

    assert.ok(cache.get('file:///a.md', '01'), 'a .ipmt save must not evict markdown state');
});

test('a non-markdown document is ignored on both paths', async () => {
    const { requests } = wireWithFakes();
    listeners['change']?.({ document: { ...fakeDoc, languageId: 'plaintext' } } as never);
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(requests, []);
});

// --- setting blast radius ------------------------------------------------
// 122 of the 123 promises this extension makes say what a feature DOES. Almost
// none says what a setting must LEAVE ALONE — and that is the shape the
// liveRefresh bug had: a switch about diagrams silently turned off syntax
// highlighting, and no assertion existed to contradict it because none had
// ever been phrased that way.
//
// This is phrased that way. It needs no prior bug: flip each setting the
// extension reads live, and assert the observables that setting does not own
// are identical to the run with defaults.

interface Observed { tokenRequests: number; fullRequests: number; tokensSurviveSave: boolean }

async function observe(): Promise<Observed> {
    const cache = new LiveCache();
    const { requests } = wireWithFakes(cache);
    const tokens = [{ line: 0, col: 0, len: 2, type: 'ipmEvent' }];

    listeners['change']?.({ document: fakeDoc } as never);
    await new Promise(resolve => setImmediate(resolve));

    cache.setTokensForSource('file:///a.md', 'e1 ::e', tokens);
    cache.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'data:x' });
    listeners['save']?.(fakeDoc as never);
    await new Promise(resolve => setImmediate(resolve));

    return {
        tokenRequests: requests.filter(r => r.args.tokensOnly === true).length,
        fullRequests: requests.filter(r => r.args.tokensOnly === false).length,
        tokensSurviveSave: cache.getTokensForSource('file:///a.md', 'e1 ::e') !== undefined,
    };
}

// Every setting the extension re-reads on each event, with a value that is not
// its default. `serverPath` and `restartOnBinaryChange` are read at activation
// by index.ts, not here, so they are out of this table's scope.
const LIVE_SETTINGS: Array<[string, unknown]> = [
    ['liveRefresh', false],
    ['liveRefreshDebounceMs', 0],
    ['embedOnSave', false],
    ['embedDebounceMs', 800],
];

test('no setting can switch fence colors off', async () => {
    const base = await observe();
    assert.equal(base.tokenRequests, 1, 'baseline: a change fetches colors');
    assert.equal(base.tokensSurviveSave, true, 'baseline: colors survive a save');

    for (const [key, value] of LIVE_SETTINGS) {
        settings[key] = value;
        try {
            const got = await observe();
            assert.equal(got.tokenRequests, base.tokenRequests,
                `ipm.${key}=${JSON.stringify(value)} changed how many color refreshes a keystroke ` +
                'triggers. Colors are the preview\'s syntax highlighting; no setting owns them ' +
                'except by turning the extension off.');
            assert.equal(got.tokensSurviveSave, base.tokensSurviveSave,
                `ipm.${key}=${JSON.stringify(value)} changed whether colors survive a save`);
        } finally {
            delete settings[key];
        }
    }
});

test('only ipm.liveRefresh changes whether a diagram render is requested', async () => {
    // The immediate call is colors-only whatever the settings; the diagram
    // follows on the debounce, which this harness does not run. What matters
    // here is that no setting sneaks a full render into the immediate path.
    for (const [key, value] of LIVE_SETTINGS) {
        settings[key] = value;
        try {
            const got = await observe();
            assert.equal(got.fullRequests, 0,
                `ipm.${key}=${JSON.stringify(value)} put a diagram render on the keystroke path`);
        } finally {
            delete settings[key];
        }
    }
});

test('the config stub is section-aware, so a wrong section fails', () => {
    // Guards the guard: with a section-blind stub, code reading
    // getConfiguration('ipmt') would read our test settings and every
    // assertion above would pass against a typo.
    const vscodeStub = (require as unknown as { cache: Record<string, { exports: unknown }> })
        .cache['__ipm_vscode_stub_live__'].exports as {
            workspace: { getConfiguration: (s?: string) => { get: (k: string, d: unknown) => unknown } };
        };
    settings['liveRefresh'] = false;
    try {
        assert.equal(vscodeStub.workspace.getConfiguration('ipm').get('liveRefresh', true), false);
        assert.equal(vscodeStub.workspace.getConfiguration('ipmt').get('liveRefresh', true), true,
            'a stub that answers for any section cannot catch a mistyped one');
    } finally {
        delete settings['liveRefresh'];
    }
});

test('set + get round-trip', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,XXX' });
    const got = c.get('file:///a.md', '01');
    assert.deepEqual(got, { hash: 'aaaa', dataUrl: 'data:image/svg+xml;base64,XXX' });
});

test('get returns undefined for unknown URI', () => {
    const c = new LiveCache();
    assert.equal(c.get('file:///nope.md', '01'), undefined);
});

test('get returns undefined for unknown block id', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'data:x' });
    assert.equal(c.get('file:///a.md', '99'), undefined);
});

test('overwriting the same key replaces the entry and adjusts byte count', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'aa', dataUrl: 'short' });
    const before = c.bytes();
    c.set('file:///a.md', '01', { hash: 'bb', dataUrl: 'much-much-longer-data-url' });
    assert.equal(c.size(), 1, 'overwriting should not add a second entry');
    assert.ok(c.bytes() > before, 'bytes should grow when entry grows');
    assert.equal(c.get('file:///a.md', '01')?.hash, 'bb');
});

test('delete by URI removes all blocks for that URI', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'a1', dataUrl: 'x' });
    c.set('file:///a.md', '02', { hash: 'a2', dataUrl: 'y' });
    c.set('file:///b.md', '01', { hash: 'b1', dataUrl: 'z' });
    c.delete('file:///a.md');
    assert.equal(c.get('file:///a.md', '01'), undefined);
    assert.equal(c.get('file:///a.md', '02'), undefined);
    assert.equal(c.get('file:///b.md', '01')?.hash, 'b1');
    assert.equal(c.size(), 1);
});

test('clear empties everything', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'a', dataUrl: 'x' });
    c.set('file:///b.md', '01', { hash: 'b', dataUrl: 'y' });
    c.clear();
    assert.equal(c.size(), 0);
    assert.equal(c.bytes(), 0);
});

test('size() counts every (uri,block) pair', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'a1', dataUrl: 'x' });
    c.set('file:///a.md', '02', { hash: 'a2', dataUrl: 'y' });
    c.set('file:///b.md', '01', { hash: 'b1', dataUrl: 'z' });
    assert.equal(c.size(), 3);
});

test('bytes() tracks data-URL string lengths', () => {
    const c = new LiveCache();
    c.set('file:///a.md', '01', { hash: 'a', dataUrl: 'x'.repeat(100) });
    c.set('file:///a.md', '02', { hash: 'a', dataUrl: 'x'.repeat(50) });
    assert.equal(c.bytes(), 150);
    c.delete('file:///a.md');
    assert.equal(c.bytes(), 0);
});

test('setTokensForSource + getTokensForSource round-trip per URI', () => {
    const c = new LiveCache();
    const tokens = [{ line: 0, col: 0, len: 3, type: 'ipmEvent' }];
    c.setTokensForSource('file:///a.md', 'A ::e --> B ::e\n', tokens);
    const got = c.getTokensForSource('file:///a.md', 'A ::e --> B ::e\n');
    assert.deepEqual(got, tokens);
    // Different source for the same URI returns undefined.
    assert.equal(c.getTokensForSource('file:///a.md', 'other'), undefined);
    // Different URI returns undefined.
    assert.equal(c.getTokensForSource('file:///b.md', 'A ::e --> B ::e\n'), undefined);
});

test('getTokensForSource(undefined, source) scans across URIs', () => {
    const c = new LiveCache();
    const t1 = [{ line: 0, col: 0, len: 1, type: 'ipmEvent' }];
    const t2 = [{ line: 0, col: 0, len: 1, type: 'ipmThing' }];
    c.setTokensForSource('file:///a.md', 'a\n', t1);
    c.setTokensForSource('file:///b.md', 'b\n', t2);
    assert.deepEqual(c.getTokensForSource(undefined, 'a\n'), t1);
    assert.deepEqual(c.getTokensForSource(undefined, 'b\n'), t2);
    assert.equal(c.getTokensForSource(undefined, 'nope\n'), undefined);
});

test('setTokensForSource normalizes trailing newline (Go ↔ markdown-it byte-match)', () => {
    // The Go side (mdembed) stores block content with no trailing
    // newline; markdown-it's fence `tok.content` always includes one.
    // The cache key normalizes both so lookups still match.
    const c = new LiveCache();
    const tokens = [{ line: 0, col: 0, len: 5, type: 'ipmEvent' }];
    c.setTokensForSource('file:///a.md', 'A ::e --> B ::e', tokens); // Go-side (no trailing \n)
    const got = c.getTokensForSource('file:///a.md', 'A ::e --> B ::e\n'); // markdown-it side
    assert.deepEqual(got, tokens);
    // And the reverse: store with trailing newline, look up without.
    c.setTokensForSource('file:///b.md', 'X ::e\n', tokens);
    assert.deepEqual(c.getTokensForSource('file:///b.md', 'X ::e'), tokens);
});

test('setTokensForSource also normalizes CRLF line endings', () => {
    const c = new LiveCache();
    const tokens = [{ line: 0, col: 0, len: 5, type: 'ipmEvent' }];
    c.setTokensForSource('file:///a.md', 'A ::e\r\nB ::e\r\n', tokens);
    assert.deepEqual(c.getTokensForSource('file:///a.md', 'A ::e\nB ::e\n'), tokens);
});

test('delete(uri) evicts tokens for that URI too', () => {
    const c = new LiveCache();
    c.setTokensForSource('file:///a.md', 'src', [{ line: 0, col: 0, len: 3, type: 'ipmEvent' }]);
    c.delete('file:///a.md');
    assert.equal(c.getTokensForSource('file:///a.md', 'src'), undefined);
});

// --- token generations -------------------------------------------------
// Tokens refresh on every keystroke, so the source-keyed map would grow
// without bound if a response did not retire the one before it. Two
// generations are kept: the newest, plus one round of grace for a preview
// render that is still working on the previous revision.

test('a new token generation retires the generation before last', () => {
    const c = new LiveCache();
    const t = [{ line: 0, col: 0, len: 1, type: 'ipmEvent' }];
    const uri = 'file:///a.md';

    c.beginTokenGeneration(uri);
    c.setTokensForSource(uri, 'gen1', t);
    c.beginTokenGeneration(uri);
    c.setTokensForSource(uri, 'gen2', t);

    // Newest plus one round of grace.
    assert.deepEqual(c.getTokensForSource(uri, 'gen2'), t);
    assert.deepEqual(c.getTokensForSource(uri, 'gen1'), t, 'previous generation stays readable');

    c.beginTokenGeneration(uri);
    c.setTokensForSource(uri, 'gen3', t);
    assert.deepEqual(c.getTokensForSource(uri, 'gen3'), t);
    assert.deepEqual(c.getTokensForSource(uri, 'gen2'), t);
    assert.equal(c.getTokensForSource(uri, 'gen1'), undefined,
        'two generations back must be evicted — otherwise per-keystroke firing leaks');
});

test('the newest generation wins when both hold the same source', () => {
    const c = new LiveCache();
    const stale = [{ line: 0, col: 0, len: 1, type: 'ipmThing' }];
    const fresh = [{ line: 0, col: 0, len: 1, type: 'ipmEvent' }];
    const uri = 'file:///a.md';

    c.beginTokenGeneration(uri);
    c.setTokensForSource(uri, 'A ::e', stale);
    c.beginTokenGeneration(uri);
    c.setTokensForSource(uri, 'A ::e', fresh);

    assert.deepEqual(c.getTokensForSource(uri, 'A ::e'), fresh);
});

test('generation rotation is per URI', () => {
    const c = new LiveCache();
    const t = [{ line: 0, col: 0, len: 1, type: 'ipmEvent' }];
    c.setTokensForSource('file:///a.md', 'shared', t);
    // Two rotations on b.md must not touch a.md's tokens.
    c.beginTokenGeneration('file:///b.md');
    c.beginTokenGeneration('file:///b.md');
    assert.deepEqual(c.getTokensForSource('file:///a.md', 'shared'), t);
});

// --- save must not blank the preview ------------------------------------

test('deleteSvgs drops rendered SVGs but keeps tokens (the save path)', () => {
    // Saving evicts SVGs because the on-disk renders take over, but the
    // buffer text is unchanged — dropping tokens there left every ipmt
    // block uncolored until the next keystroke, since nothing re-fires
    // embedBuffer on save.
    const c = new LiveCache();
    const uri = 'file:///a.md';
    const tokens = [{ line: 0, col: 0, len: 5, type: 'ipmEvent' }];
    c.set(uri, '01', { hash: 'aa', dataUrl: 'data:image/svg+xml;base64,XXX' });
    c.setTokensForSource(uri, 'A ::e', tokens);

    c.deleteSvgs(uri);

    assert.equal(c.get(uri, '01'), undefined, 'SVG entry must go');
    assert.equal(c.bytes(), 0, 'byte accounting must follow the eviction');
    assert.deepEqual(c.getTokensForSource(uri, 'A ::e'), tokens, 'tokens must survive a save');
});

test('delete(uri) still drops both maps (the close path)', () => {
    const c = new LiveCache();
    const uri = 'file:///a.md';
    c.set(uri, '01', { hash: 'aa', dataUrl: 'data:x' });
    c.setTokensForSource(uri, 'A ::e', [{ line: 0, col: 0, len: 5, type: 'ipmEvent' }]);
    c.delete(uri);
    assert.equal(c.get(uri, '01'), undefined);
    assert.equal(c.getTokensForSource(uri, 'A ::e'), undefined);
});

// --- out-of-order responses ---------------------------------------------

test('shouldApplyRender discards responses for superseded revisions', () => {
    assert.equal(shouldApplyRender(undefined, 1), true, 'first response always applies');
    assert.equal(shouldApplyRender(5, 6), true, 'newer revision applies');
    assert.equal(shouldApplyRender(5, 5), true, 're-render of the same revision applies');
    assert.equal(shouldApplyRender(5, 4), false,
        'an older in-flight response must not clobber newer SVGs');
});

// --- single-flight pacing ------------------------------------------------

test('SingleFlight runs one task at a time and coalesces the rest', async () => {
    // Zero clock: this test is about coalescing, not pacing — the cooldown
    // has its own tests below.
    const flight = new SingleFlight(() => 0);
    const started: string[] = [];
    let release: (() => void) | undefined;
    const blocked = (label: string) => () => {
        started.push(label);
        return new Promise<void>(resolve => { release = resolve; });
    };

    flight.run('a.md', blocked('first'));
    assert.deepEqual(started, ['first']);
    assert.ok(flight.isRunning('a.md'));

    // Three more edits while the first call is in the air: only the LAST
    // one survives — intermediate buffer states are unusable anyway.
    flight.run('a.md', blocked('second'));
    flight.run('a.md', blocked('third'));
    flight.run('a.md', blocked('fourth'));
    assert.deepEqual(started, ['first'], 'nothing may start while one is running');
    assert.ok(flight.hasQueued('a.md'));

    release?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'fourth'], 'only the newest queued task runs');

    release?.();
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(flight.isRunning('a.md'), false);
    assert.equal(flight.hasQueued('a.md'), false);
});

test('SingleFlight keys are independent per document', () => {
    const flight = new SingleFlight();
    const started: string[] = [];
    const blocked = (label: string) => () => {
        started.push(label);
        return new Promise<void>(() => { /* never settles */ });
    };
    flight.run('a.md', blocked('a'));
    flight.run('b.md', blocked('b'));
    assert.deepEqual(started, ['a', 'b'], 'one document must not block another');
});

test('SingleFlight releases the key when a task rejects', async () => {
    // A failed embedBuffer (server crash mid-request) must not wedge the
    // token path for the rest of the session.
    const flight = new SingleFlight();
    let ran = 0;
    flight.run('a.md', () => Promise.reject(new Error('connection got disposed')));
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(flight.isRunning('a.md'), false, 'a rejection must clear in-flight state');

    flight.run('a.md', () => { ran++; return Promise.resolve(); });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(ran, 1, 'the next edit must still fire');
});

// --- duty-cycle bound ----------------------------------------------------
// Single-flight bounds how many calls are in the air (one), not what share
// of wall time they occupy. On a slow machine — a 200ms round trip against
// 90ms keystrokes — back-to-back refreshes would keep the server busy
// continuously. The cooldown makes the share ~50% by construction, derived
// from measured latency rather than a setting.

test('cooldownMs mirrors the last call and caps at the preview cadence', () => {
    assert.equal(cooldownMs(0), 0, 'an instant call imposes no gap');
    assert.equal(cooldownMs(1), 1, 'a 1ms call: invisible');
    assert.equal(cooldownMs(35), 35, 'a heavy document paces itself');
    assert.equal(cooldownMs(2000), 250,
        'never wait longer than the preview render cadence — past that the user reads it as staleness');
    assert.equal(cooldownMs(-1), 0, 'a clock that went backwards must not wedge the key');
});

test('SingleFlight makes the next run wait out the cooldown', async () => {
    // Fake the clock so the task "takes" 60ms without the test sleeping for
    // it; the cooldown timer itself is real.
    const clock = [0, 60];
    const flight = new SingleFlight(() => clock.shift() ?? 60);
    const started: string[] = [];

    flight.run('a.md', () => { started.push('first'); return Promise.resolve(); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first']);
    assert.ok(flight.isCooling('a.md'), 'a 60ms call must be followed by a cooldown');

    flight.run('a.md', () => { started.push('second'); return Promise.resolve(); });
    assert.deepEqual(started, ['first'], 'the follow-up waits rather than running back-to-back');

    await new Promise(resolve => setTimeout(resolve, 90));
    assert.deepEqual(started, ['first', 'second'], 'and runs once the cooldown expires');
    assert.equal(flight.isCooling('a.md'), false);
});

test('SingleFlight imposes no cooldown when calls are instant', async () => {
    // The common case: ~1ms round trips must stay effectively per-keystroke.
    const flight = new SingleFlight(() => 0);
    const started: string[] = [];
    flight.run('a.md', () => { started.push('first'); return Promise.resolve(); });
    await new Promise(resolve => setImmediate(resolve));
    flight.run('a.md', () => { started.push('second'); return Promise.resolve(); });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['first', 'second']);
    assert.equal(flight.isCooling('a.md'), false);
});

test('isTransientEmbedError: retries didOpen races and dead-connection errors', () => {
    // Server hasn't seen didOpen yet (startup / restart race).
    assert.ok(isTransientEmbedError(new Error('document not open in server: file:///a.md (run textDocument/didOpen first)')));
    // Server process died mid-request; vscode-languageclient auto-respawns
    // it and the retry lands on the fresh connection.
    assert.ok(isTransientEmbedError(new Error('Pending response rejected since connection got disposed')));
    assert.ok(isTransientEmbedError(new Error('Connection is disposed.')));
    assert.ok(isTransientEmbedError(new Error('Connection got closed')));
    assert.ok(isTransientEmbedError(new Error('Client is not running and can\'t be stopped.')));
});

test('isTransientEmbedError: does not retry permanent errors', () => {
    assert.ok(!isTransientEmbedError(new Error('analyze: parse error at line 3')));
    assert.ok(!isTransientEmbedError(new Error('missing or empty \'uri\'')));
    assert.ok(!isTransientEmbedError(new Error('resolve uri: not a file scheme')));
});
