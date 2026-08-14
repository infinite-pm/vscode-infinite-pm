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
// Settings the stub reports, and the save listener wireEmbedOnSave registers.
const settings: Record<string, unknown> = {};
let onSave: ((doc: unknown) => unknown) | undefined;

stubCache('__ipm_vscode_stub_eos__', {
    workspace: {
        // Section-aware: a stub that answers for any section would let code
        // reading getConfiguration('ipmt') pass every assertion below.
        getConfiguration: (section?: string) => ({
            get: (key: string, def: unknown) =>
                (section === 'ipm' && key in settings ? settings[key] : def),
        }),
        createFileSystemWatcher: () => ({ onDidChange() { /* noop */ }, onDidCreate() { /* noop */ } }),
        onDidSaveTextDocument: (fn: (doc: unknown) => unknown) => {
            onSave = fn;
            return { dispose() { /* noop */ } };
        },
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => p }) },
});
stubCache('__ipm_lc_stub_eos__', {});

const { markdownIncludesIpmt, wireEmbedOnSave } =
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

// --- the other half of setting blast radius -----------------------------
// liveRefresh.test.ts asserts that no setting can switch fence colours off.
// This asserts the mirror: the settings that own the preview must not change
// what a save writes to disk. Between them, every setting the extension reads
// live is pinned from both directions.

interface EmbedRun { commands: string[] }

async function saveWithSettings(): Promise<EmbedRun> {
    const commands: string[] = [];
    const client = {
        sendRequest: (_m: string, params: { command: string }) => {
            commands.push(params.command);
            return Promise.resolve({ file: '/a.md', changed: false });
        },
    };
    const ctx = { subscriptions: [] as unknown[] };
    const log = { appendLine() { /* noop */ } };
    wireEmbedOnSave(ctx as never, client as never, log as never);

    await onSave?.({
        languageId: 'markdown',
        uri: { toString: () => 'file:///a.md', fsPath: '/a.md' },
    });
    await new Promise(resolve => setImmediate(resolve));
    return { commands };
}

test('saving a markdown file runs ipm.embed by default', async () => {
    const { commands } = await saveWithSettings();
    assert.deepEqual(commands, ['ipm.embed']);
});

test('ipm.embedOnSave=false is the only way to stop it', async () => {
    settings['embedOnSave'] = false;
    try {
        const { commands } = await saveWithSettings();
        assert.deepEqual(commands, [], 'embedOnSave=false must stop the write');
    } finally {
        delete settings['embedOnSave'];
    }
});

test('the preview settings do not change what a save writes', async () => {
    // ipm.liveRefresh is about the preview rendering from an unsaved buffer.
    // If it ever reaches this path, "turn off live preview" would quietly stop
    // maintaining the committed SVGs — the same class of surprise as the
    // colours bug, in the opposite direction.
    for (const [key, value] of [['liveRefresh', false], ['liveRefreshDebounceMs', 0]] as const) {
        settings[key] = value;
        try {
            const { commands } = await saveWithSettings();
            assert.deepEqual(commands, ['ipm.embed'],
                `ipm.${key}=${JSON.stringify(value)} changed what a save writes to disk`);
        } finally {
            delete settings[key];
        }
    }
});
