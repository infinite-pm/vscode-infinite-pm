// Unit tests for the pure parts of liveRefresh.ts: the LiveCache's data
// shape and eviction guarantees (including token caching and CRLF /
// trailing-newline normalization) plus the `isTransientEmbedError`
// predicate. The runtime wiring (debouncer, LSP call, save eviction) has no
// automated coverage — it is exercised manually in a development host.

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
(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_vscode_stub_live__'] = {
    id: '__ipm_vscode_stub_live__', filename: '__ipm_vscode_stub_live__',
    loaded: true, exports: {
        workspace: {
            getConfiguration: () => ({ get: (_: string, def: unknown) => def }),
            onDidChangeTextDocument: () => ({ dispose() { /* noop */ } }),
            onDidSaveTextDocument: () => ({ dispose() { /* noop */ } }),
            onDidCloseTextDocument: () => ({ dispose() { /* noop */ } }),
        },
        commands: { executeCommand: () => Promise.resolve() },
    }, children: [], paths: [],
};
(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_lc_stub_live__'] = {
    id: '__ipm_lc_stub_live__', filename: '__ipm_lc_stub_live__',
    loaded: true, exports: {}, children: [], paths: [],
};

test.after(() => { moduleAny._resolveFilename = origResolve; });

const { LiveCache, isTransientEmbedError } = require('../extension/liveRefresh') as typeof import('../extension/liveRefresh');

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
