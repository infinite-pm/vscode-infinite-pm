// Tests for the include-dependency matcher used by the .ipmt -> including
// markdown re-embed (embedOnSave.ts). The matcher decides whether a markdown
// file pulls in a given `.ipmt` via `<!-- ipm-include src=…/foo.ipmt -->`, so
// a save of the shared .ipmt re-embeds exactly the dependent markdown files.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

// embedOnSave.ts imports `vscode` and `vscode-languageclient/node` at module
// load. Stub both so the module loads cleanly under plain Node (`node:test`).
const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_eos__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_eos__';
    return origResolve.call(this, request, ...rest);
};
const stubCache = (id: string, exports: unknown) => {
    (require as unknown as { cache: Record<string, unknown> }).cache[id] = {
        id, filename: id, loaded: true, exports, children: [], paths: [],
    };
};
stubCache('__ipm_vscode_stub_eos__', {
    workspace: {
        getConfiguration: () => ({ get: (_: string, def: unknown) => def }),
        createFileSystemWatcher: () => ({ onDidChange() { /* noop */ }, onDidCreate() { /* noop */ } }),
        onDidSaveTextDocument: () => ({ dispose() { /* noop */ } }),
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
});
stubCache('__ipm_lc_stub_eos__', {});

const { markdownIncludesIpmt } =
    require('../extension/embedOnSave') as typeof import('../extension/embedOnSave');

test.after(() => {
    moduleAny._resolveFilename = origResolve;
});

test('markdownIncludesIpmt matches markdown that includes the .ipmt', () => {
    const md = [
        '# Doc',
        '',
        '<!-- ipm-include src=diagrams/flow.ipmt -->',
        '',
        'Some prose.',
    ].join('\n');
    assert.equal(markdownIncludesIpmt(md, 'flow.ipmt'), true);
});

test('markdownIncludesIpmt does not match markdown that references a different .ipmt', () => {
    // Has an ipm-include directive, but for a *different* basename — must not
    // match (otherwise an edit to flow.ipmt would needlessly re-embed it).
    const md = [
        '# Doc',
        '',
        '<!-- ipm-include src=diagrams/other.ipmt -->',
    ].join('\n');
    assert.equal(markdownIncludesIpmt(md, 'flow.ipmt'), false);
});

test('markdownIncludesIpmt does not match when the include directive is absent', () => {
    // The basename appears (e.g. in prose / a link) but there is no
    // ipm-include directive — not an include dependency.
    const md = 'See flow.ipmt for the source diagram, rendered separately.';
    assert.equal(markdownIncludesIpmt(md, 'flow.ipmt'), false);
});
