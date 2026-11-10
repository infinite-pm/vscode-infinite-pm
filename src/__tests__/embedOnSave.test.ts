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
let onWatchChange: ((uri: { fsPath: string }) => void) | undefined;
let findFilesCalls = 0;
// The workspace folder the stub reports for every file.
let wsRoot = '/repo';

stubCache('__ipm_vscode_stub_eos__', {
    workspace: {
        // Section-aware: a stub that answers for any section would let code
        // reading getConfiguration('ipmt') pass every assertion below.
        getConfiguration: (section?: string) => ({
            get: (key: string, def: unknown) =>
                (section === 'ipm' && key in settings ? settings[key] : def),
        }),
        createFileSystemWatcher: () => ({
            onDidChange(fn: (uri: { fsPath: string }) => void) { onWatchChange = fn; return { dispose() { /* noop */ } }; },
            onDidCreate() { return { dispose() { /* noop */ } }; },
            dispose() { /* noop */ },
        }),
        onDidSaveTextDocument: (fn: (doc: unknown) => unknown) => {
            onSave = fn;
            return { dispose() { /* noop */ } };
        },
        // The repo-wide markdown scan. Counting calls is the whole point of
        // the burst tests: a burst must cost ONE of these, not one per file.
        findFiles: () => { findFilesCalls++; return Promise.resolve([]); },
        getWorkspaceFolder: () => ({ uri: { toString: () => 'file://' + wsRoot, fsPath: wsRoot } }),
        textDocuments: [],
        fs: { readFile: () => Promise.resolve(new Uint8Array()) },
    },
    Uri: { file: (p: string) => ({ fsPath: p, toString: () => 'file://' + p }) },
    RelativePattern: class { constructor(public base: unknown, public pattern: string) { /* noop */ } },
    commands: { executeCommand: () => Promise.resolve() },
});
stubCache('__ipm_lc_stub_eos__', {});

const { markdownIncludesIpmt, wireEmbedOnSave, wireIpmtIncludeRefresh, ipmtChangeIsIgnored } =
    require('../extension/embedOnSave') as typeof import('../extension/embedOnSave');

const fakeCtx = { subscriptions: [] as unknown[] } as never;
const fakeLog = { appendLine() { /* noop */ } } as never;
const fakeClient = { sendRequest: () => Promise.resolve(null) } as never;
const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

// --- bursts of .ipmt changes ---------------------------------------------
// The include-refresh watcher used to schedule one repo-wide markdown scan
// PER changed .ipmt, 150ms apart. A generator writing 2,800 files into the
// workspace therefore queued 2,800 scans (findFiles over every *.md, then a
// read of each), the extension host stalled for minutes, and the renderer
// died behind it — twice in one day. These pin the two things that stop it:
// generated trees are ignored, and a burst costs one scan.

test('a change under a temp/ or generated tree is ignored', () => {
    assert.equal(ipmtChangeIsIgnored('/repo/temp/layout-audit/x.ipmt'), true);
    assert.equal(ipmtChangeIsIgnored('/repo/a/b/tmp/x.ipmt'), true, 'matched as a segment anywhere, not only at the root');
    assert.equal(ipmtChangeIsIgnored('/repo/node_modules/pkg/x.ipmt'), true);
    assert.equal(ipmtChangeIsIgnored('/repo/docs/x.ipmt'), false);
    assert.equal(ipmtChangeIsIgnored('/repo/docs/out.ipmt'), false, 'the basename is not a directory');
    assert.equal(ipmtChangeIsIgnored('/repo/gen/x.ipmt', ['gen']), true, 'ipm.embedIgnore extends the list');
});

test('a burst of changed .ipmt files costs ONE repo scan, not one per file', async () => {
    findFilesCalls = 0;
    wireIpmtIncludeRefresh(fakeCtx, fakeClient, fakeLog);
    assert.ok(onWatchChange, 'the watcher must be wired');
    for (let i = 0; i < 300; i++) {
        onWatchChange!({ fsPath: `/repo/docs/gen-${i}.ipmt` });
    }
    await tick(50);
    assert.equal(findFilesCalls, 0, 'nothing runs while the burst is still arriving');
    await tick(700);
    assert.equal(findFilesCalls, 1,
        `300 changed files must trigger exactly one scan; got ${findFilesCalls}. Per-file scans are what stalled the extension host.`);
});

test('changes under temp/ trigger no scan at all', async () => {
    findFilesCalls = 0;
    wireIpmtIncludeRefresh(fakeCtx, fakeClient, fakeLog);
    for (let i = 0; i < 2800; i++) {
        onWatchChange!({ fsPath: `/repo/temp/layout-audit/f-${i}.ipmt` });
    }
    await tick(700);
    assert.equal(findFilesCalls, 0, 'a corpus written into temp/ is not an edit to react to');
});

// The ignored names are matched BELOW the workspace folder. Matched on the
// whole path, a workspace that itself lives under /tmp, ~/build or an out/
// directory lost include-refresh for every file in it: the watcher dropped
// each change as "generated", and the page kept its old diagram.
test('a workspace that itself sits under tmp/ or out/ is not a generated tree', () => {
    const root = '/tmp/work/out/ws';
    assert.equal(ipmtChangeIsIgnored(`${root}/docs/x.ipmt`, [], root), false,
        'the names above the workspace folder do not count');
    assert.equal(ipmtChangeIsIgnored(`${root}/x.ipmt`, [], root), false);
    assert.equal(ipmtChangeIsIgnored(`${root}/temp/x.ipmt`, [], root), true,
        'below the folder they still do');
    assert.equal(ipmtChangeIsIgnored(`${root}/gen/x.ipmt`, ['gen'], root), true);
    assert.equal(ipmtChangeIsIgnored('/elsewhere/tmp/x.ipmt', [], root), true,
        'a file outside the folder is matched on its whole path, as before');
});

test('an .ipmt change in a workspace under out/ still triggers the scan', async () => {
    wsRoot = '/work/out/workspaces/include-refresh';
    try {
        findFilesCalls = 0;
        wireIpmtIncludeRefresh(fakeCtx, fakeClient, fakeLog);
        onWatchChange!({ fsPath: `${wsRoot}/answer.ipmt` });
        await tick(700);
        assert.equal(findFilesCalls, 1,
            'the change is in the workspace, not in a generated tree; it must reach the markdown that includes it');
    } finally {
        wsRoot = '/repo';
    }
});
