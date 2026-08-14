// Tests for the `.ipmt` preview pane.
//
// We stub `vscode` and `vscode-languageclient/node` the same way
// liveRefresh.test.ts does (Module._resolveFilename shim + require.cache
// injection). The preview module is pure logic — the webview is a fake
// that just records postMessage calls, and the LSP client is a fake
// that returns canned `ipm.embedBuffer` responses.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

interface FakeWebview {
    posted: unknown[];
    html: string;
    postMessage: (m: unknown) => Promise<boolean>;
    // The preview loads media/preview-view.js through this; a stub without it
    // fails with "asWebviewUri is not a function", which is the stub being
    // out of date rather than the code being wrong.
    asWebviewUri: (u: unknown) => string;
}
interface FakePanel {
    webview: FakeWebview;
    visible: boolean;
    active: boolean;
    viewColumn?: number;
    revealCalls: number;
    disposeCalls: number;
    reveal: () => void;
    dispose: () => void;
    onDidDispose: (fn: () => void) => { dispose: () => void };
}
interface FakeWindow {
    panels: FakePanel[];
    activeTextEditor?: { document: { languageId: string; uri: { toString: () => string } } };
    createWebviewPanel: () => FakePanel;
    showInformationMessage: (m: string) => Promise<void>;
}

function makePanel(): FakePanel {
    const posted: unknown[] = [];
    const panel: FakePanel = {
        webview: {
            posted,
            html: '',
            postMessage: async (m: unknown) => {
                posted.push(m);
                return true;
            },
            asWebviewUri: (u: unknown) => `vscode-webview://fake/${String(u)}`,
        } as unknown as FakeWebview,
        visible: true,
        active: false,
        viewColumn: 1,
        revealCalls: 0,
        disposeCalls: 0,
        reveal: () => { panel.revealCalls++; },
        dispose: () => { panel.disposeCalls++; },
        onDidDispose: (_fn: () => void) => ({ dispose: () => { /* noop */ } }),
    };
    return panel;
}

const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_preview__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_preview__';
    return origResolve.call(this, request, ...rest);
};

const fakeWindow: FakeWindow = {
    panels: [],
    activeTextEditor: undefined,
    createWebviewPanel: () => {
        const p = makePanel();
        fakeWindow.panels.push(p);
        return p;
    },
    showInformationMessage: async () => { /* noop */ },
};

interface ShownTextDocCall { uri: string; viewColumn?: number; preserveFocus?: boolean; preview?: boolean; }
const shownTextDocCalls: ShownTextDocCall[] = [];

const fakeWindowExt = fakeWindow as FakeWindow & {
    showTextDocument: (doc: { uri: { toString: () => string } }, opts?: { viewColumn?: number; preserveFocus?: boolean; preview?: boolean }) => Promise<void>;
};
fakeWindowExt.showTextDocument = async (doc, opts) => {
    shownTextDocCalls.push({
        uri: doc.uri.toString(),
        viewColumn: opts?.viewColumn,
        preserveFocus: opts?.preserveFocus,
        preview: opts?.preview,
    });
};

// Empty tabGroups: closeSourceTabFor / closePreviewTabFor iterate
// `tabGroups.all` and early-return when nothing matches. Good enough
// for unit tests that just want to verify the rest of the flow.
(fakeWindow as FakeWindow & { tabGroups: unknown }).tabGroups = {
    all: [] as Array<{ viewColumn: number; tabs: unknown[] }>,
    close: async () => true,
};

class FakeTabInputText { constructor(public uri: { toString: () => string }) {} }
class FakeTabInputWebview { constructor(public viewType: string) {} }

(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_vscode_stub_preview__'] = {
    id: '__ipm_vscode_stub_preview__', filename: '__ipm_vscode_stub_preview__',
    loaded: true, exports: {
        window: fakeWindow,
        workspace: {
            getConfiguration: () => ({ get: (_: string, def: unknown) => def }),
            asRelativePath: (u: { toString: () => string }) => u.toString(),
            openTextDocument: async (uri: { toString: () => string }) => ({ uri }),
        },
        ViewColumn: { Active: 1, Beside: -2 },
        Uri: {
            parse: (s: string) => ({ toString: () => s }),
            joinPath: (base: unknown, ..._parts: string[]) => base,
        },
        TabInputText: FakeTabInputText,
        TabInputWebview: FakeTabInputWebview,
    }, children: [], paths: [],
};
(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_lc_stub_preview__'] = {
    id: '__ipm_lc_stub_preview__', filename: '__ipm_lc_stub_preview__',
    loaded: true, exports: {}, children: [], paths: [],
};

test.after(() => { moduleAny._resolveFilename = origResolve; });

const {
    openIpmtPreview,
    onIpmtChange,
    disposeAllIpmtPreviews,
    showSource,
} = require('../extension/ipmtPreview') as typeof import('../extension/ipmtPreview');

function makeClient(svgBytes: string): { sendRequest: (...args: unknown[]) => Promise<unknown>; calls: number } {
    let calls = 0;
    return {
        calls,
        sendRequest: async () => {
            calls++;
            return {
                uri: 'file:///t/diagram.ipmt',
                blocks: [{
                    index: 1,
                    id: 'preview',
                    hash: 'aabbcc',
                    svgBase64: Buffer.from(svgBytes).toString('base64'),
                    outcome: 'ok',
                }],
            };
        },
        get calls() { return calls; }, // eslint-disable-line @typescript-eslint/no-unused-vars
    } as unknown as { sendRequest: (...args: unknown[]) => Promise<unknown>; calls: number };
}

function makeDoc(languageId: string, uri: string) {
    return {
        languageId,
        uri: { toString: () => uri },
    };
}

test.beforeEach(() => {
    fakeWindow.panels.length = 0;
    disposeAllIpmtPreviews();
});

test('openIpmtPreview ignores non-ipmt active editor', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'markdown', uri: { toString: () => 'file:///t/x.md' } },
    };
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, undefined, 1 as never);
    assert.equal(fakeWindow.panels.length, 0,
        'no webview should open when the active editor is not a .ipmt file');
});

test('openIpmtPreview creates a panel and inlines the SVG in initial HTML', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/diagram.ipmt', fsPath: '/t/diagram.ipmt' } },
    };
    const client = makeClient('<svg id="ok"/>');
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, client as never, 1 as never);
    assert.equal(fakeWindow.panels.length, 1, 'one webview panel should be created');
    // The first render is baked into the HTML rather than posted — that
    // is what eliminates the postMessage race against the webview's
    // script load AND against the column-layout settling in
    // side-by-side mode.
    const html = fakeWindow.panels[0].webview.html;
    assert.ok(html.includes('<svg id="ok"/>'),
        `initial SVG should be inlined in the webview HTML; got ${html.slice(0, 400)}`);
    const posted = fakeWindow.panels[0].webview.posted as Array<{ kind: string; svgHtml?: string }>;
    assert.ok(!posted.some(m => m.kind === 'svg'),
        `no svg postMessage on first render — should be in HTML; got ${JSON.stringify(posted)}`);
});

test('openIpmtPreview reuses the panel for the same URI (focus, no new panel)', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/same.ipmt', fsPath: '/t/same.ipmt' } },
    };
    const client = makeClient('<svg/>');
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, client as never, 1 as never);
    await openIpmtPreview(ctx, client as never, 1 as never);
    assert.equal(fakeWindow.panels.length, 1,
        're-opening should focus the existing panel, not create a second');
    assert.equal(fakeWindow.panels[0].revealCalls, 1,
        'second open should call reveal() on the existing panel');
});

test('onIpmtChange schedules a re-render for ipmt docs with an open preview', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/edit.ipmt', fsPath: '/t/edit.ipmt' } },
    };
    const client = makeClient('<svg id="first"/>');
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, client as never, 1 as never);
    const panel = fakeWindow.panels[0];
    panel.webview.posted.length = 0;

    // Simulate an edit: replace client to return new SVG, then trigger change.
    const newClient = makeClient('<svg id="second"/>');
    onIpmtChange(newClient as never, makeDoc('ipmt', 'file:///t/edit.ipmt') as never);
    // Default debounce is 300 (from the stubbed getConfiguration → def=300).
    await new Promise(r => setTimeout(r, 380));
    const posted = panel.webview.posted as Array<{ kind: string; svgHtml?: string }>;
    const last = posted[posted.length - 1];
    assert.ok(last && last.kind === 'svg' && last.svgHtml!.includes('<svg id="second"/>'),
        `re-render should send the new SVG; got ${JSON.stringify(posted)}`);
});

test('onIpmtChange is a no-op for non-ipmt docs', async () => {
    const client = makeClient('<svg/>');
    onIpmtChange(client as never, makeDoc('markdown', 'file:///t/x.md') as never);
    await new Promise(r => setTimeout(r, 380));
    // No panel was opened, so there's nothing to assert on the panel
    // side; this is just a defensive check that no exception fired.
    assert.ok(true);
});

test('showSource on an active preview opens the source doc in the panel\'s column', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/return.ipmt', fsPath: '/t/return.ipmt' } },
    };
    const client = makeClient('<svg/>');
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, client as never, 1 as never);
    const panel = fakeWindow.panels[0];
    panel.active = true;
    panel.viewColumn = 1;
    shownTextDocCalls.length = 0;

    await showSource();
    assert.equal(shownTextDocCalls.length, 1,
        'showSource on an active preview should call showTextDocument exactly once');
    assert.equal(shownTextDocCalls[0].uri, 'file:///t/return.ipmt',
        'should focus the source URI of the active preview');
    assert.equal(shownTextDocCalls[0].viewColumn, 1,
        'should open in the same column as the preview');
    // `preview: false` pins the resulting tab — without it the tab is
    // in preview mode (italic title) and the next click in the
    // explorer would replace it, which is not how returning from a
    // preview should behave.
    assert.equal(shownTextDocCalls[0].preview, false,
        'should pass preview:false so the reopened source tab is pinned, not italic');
});

test('showSource is a no-op when no preview is active', async () => {
    shownTextDocCalls.length = 0;
    await showSource();
    assert.equal(shownTextDocCalls.length, 0,
        'no active panel → no showTextDocument call');
});

test('openIpmtPreview in-place closes the source tab after opening the preview', async () => {
    // Source tab exists in viewColumn 1; in-place open should close it.
    const closedTabs: unknown[] = [];
    const sourceUriObj = { toString: () => 'file:///t/in-place.ipmt', fsPath: '/t/in-place.ipmt' };
    const sourceTab = { label: 'in-place.ipmt', input: new FakeTabInputText(sourceUriObj) };
    const groups = [{ viewColumn: 1, tabs: [sourceTab] }];
    // Wire the fake tabGroups for this test.
    const tg = (fakeWindow as FakeWindow & { tabGroups: { all: unknown[]; close: (t: unknown) => Promise<boolean> } }).tabGroups;
    const origAll = tg.all;
    const origClose = tg.close;
    tg.all = groups;
    tg.close = async (tab: unknown) => { closedTabs.push(tab); return true; };
    try {
        fakeWindow.activeTextEditor = {
            document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/in-place.ipmt', fsPath: '/t/in-place.ipmt' } },
            // viewColumn is read on the editor — add it.
        } as unknown as typeof fakeWindow.activeTextEditor;
        (fakeWindow.activeTextEditor as unknown as { viewColumn: number }).viewColumn = 1;
        const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
        const client = makeClient('<svg/>');
        await openIpmtPreview(ctx, client as never, 1 as never); // ViewColumn.Active = 1 → in-place
        assert.ok(closedTabs.includes(sourceTab),
            `in-place open should close the source tab; closed=${JSON.stringify(closedTabs.map(t => (t as { label: string }).label))}`);
    } finally {
        tg.all = origAll;
        tg.close = origClose;
    }
});

test('openIpmtPreview to-side does NOT close the source tab', async () => {
    const closedTabs: unknown[] = [];
    const sourceUriObj = { toString: () => 'file:///t/side.ipmt', fsPath: '/t/side.ipmt' };
    const sourceTab = { label: 'side.ipmt', input: new FakeTabInputText(sourceUriObj) };
    const groups = [{ viewColumn: 1, tabs: [sourceTab] }];
    const tg = (fakeWindow as FakeWindow & { tabGroups: { all: unknown[]; close: (t: unknown) => Promise<boolean> } }).tabGroups;
    const origAll = tg.all;
    const origClose = tg.close;
    tg.all = groups;
    tg.close = async (tab: unknown) => { closedTabs.push(tab); return true; };
    try {
        fakeWindow.activeTextEditor = {
            document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/side.ipmt', fsPath: '/t/side.ipmt' } },
        } as unknown as typeof fakeWindow.activeTextEditor;
        (fakeWindow.activeTextEditor as unknown as { viewColumn: number }).viewColumn = 1;
        const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
        const client = makeClient('<svg/>');
        await openIpmtPreview(ctx, client as never, -2 as never); // ViewColumn.Beside = -2 → to-side
        assert.equal(closedTabs.length, 0,
            `to-side open should NOT close any tab; closed=${JSON.stringify(closedTabs)}`);
    } finally {
        tg.all = origAll;
        tg.close = origClose;
    }
});

test('disposeAllIpmtPreviews tears down panels + state', async () => {
    fakeWindow.activeTextEditor = {
        document: { languageId: 'ipmt', uri: { toString: () => 'file:///t/dispose.ipmt', fsPath: '/t/dispose.ipmt' } },
    };
    const client = makeClient('<svg/>');
    const ctx = { subscriptions: [], extensionUri: { toString: () => 'file:///ext' } } as unknown as Parameters<typeof openIpmtPreview>[0];
    await openIpmtPreview(ctx, client as never, 1 as never);
    const panel = fakeWindow.panels[0];
    disposeAllIpmtPreviews();
    assert.equal(panel.disposeCalls, 1, 'panel.dispose() should be called');
});
