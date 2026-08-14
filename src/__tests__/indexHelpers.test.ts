// index.ts used to export only activate/deactivate, so every command body was
// unreachable from a test — which is what pushed 28 of the 123 documented
// promises up to an extension-host suite that does not exist. Most of them do
// not need a host at all; they needed an export and an explicit argument.
//
// These cover the three that are pure decisions rather than VS Code
// choreography: which file a re-embed command acts on, what "Show Server Info"
// says, and the once-per-install notice for a missing binary.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';

const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') return '__ipm_vscode_stub_idx__';
    if (request === 'vscode-languageclient/node') return '__ipm_lc_stub_idx__';
    return origResolve.call(this, request, ...rest);
};

const shown: Array<{ message: string; items: string[] }> = [];

const stub = (id: string, exports: unknown) => {
    (require as unknown as { cache: Record<string, unknown> }).cache[id] = {
        id, filename: id, loaded: true, exports, children: [], paths: [],
    };
};
stub('__ipm_vscode_stub_idx__', {
    window: {
        activeTextEditor: undefined,
        createOutputChannel: () => ({ appendLine() { /* noop */ }, show() { /* noop */ }, dispose() { /* noop */ } }),
        showInformationMessage: (message: string, ...items: unknown[]) => {
            shown.push({ message, items: items.filter((i): i is string => typeof i === 'string') });
            return Promise.resolve(undefined);
        },
        onDidChangeActiveTextEditor: () => ({ dispose() { /* noop */ } }),
    },
    workspace: {
        getConfiguration: () => ({ get: (_k: string, d: unknown) => d }),
        onDidChangeTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidCloseTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidSaveTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidOpenTextDocument: () => ({ dispose() { /* noop */ } }),
        onDidGrantWorkspaceTrust: () => ({ dispose() { /* noop */ } }),
        createFileSystemWatcher: () => ({ onDidChange() { /* noop */ }, onDidCreate() { /* noop */ } }),
        textDocuments: [],
        isTrusted: true,
    },
    commands: { registerCommand: () => ({ dispose() { /* noop */ } }), executeCommand: () => Promise.resolve() },
    languages: { createDiagnosticCollection: () => ({ dispose() { /* noop */ } }) },
    Uri: { file: (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }) },
    ViewColumn: { Active: -1, Beside: -2 },
    ProgressLocation: { Notification: 15 },
});
stub('__ipm_lc_stub_idx__', { LanguageClient: class { }, TransportKind: { stdio: 0 } });

test.after(() => { moduleAny._resolveFilename = origResolve; });

const { formatServerInfo, resolveTargetMarkdown, resolveAnchorUri, showOneShotMissingBinaryNotice } =
    require('../extension/index') as typeof import('../extension/index');

const uri = (p: string) => ({ fsPath: p, scheme: 'file', toString: () => `file://${p}` }) as never;
const editor = (path: string, languageId: string, scheme = 'file') =>
    ({ document: { languageId, uri: { ...(uri(path) as object), scheme } } }) as never;

// --- which file a re-embed command acts on ------------------------------

test('a focused markdown editor is the target', () => {
    assert.equal(
        resolveTargetMarkdown(editor('/a.md', 'markdown'), uri('/fallback.md'))?.fsPath,
        '/a.md',
    );
});

test('with the PREVIEW focused there is no active editor, so the fallback wins', () => {
    // This is the case the fallback exists for: a webview is focused, so
    // vscode.window.activeTextEditor is undefined, and "Force Re-embed Current
    // File" must still mean the markdown behind the preview.
    assert.equal(resolveTargetMarkdown(undefined, uri('/fallback.md'))?.fsPath, '/fallback.md');
});

test('a focused non-markdown editor does not become the target', () => {
    assert.equal(
        resolveTargetMarkdown(editor('/notes.ipmt', 'ipmt'), uri('/fallback.md'))?.fsPath,
        '/fallback.md',
    );
});

test('an untitled or virtual document is not a re-embed target', () => {
    // ipm.embed reads from disk; a non-file scheme has no path to read.
    assert.equal(
        resolveTargetMarkdown(editor('/x.md', 'markdown', 'untitled'), uri('/fallback.md'))?.fsPath,
        '/fallback.md',
    );
});

test('the repo anchor accepts any file, not just markdown', () => {
    // "Re-embed All in Repo" anchors on whatever is focused — the repo is the
    // scope, so a .ipmt or a .go file locates it just as well.
    assert.equal(resolveAnchorUri(editor('/pkg/main.go', 'go'), uri('/fallback.md'))?.fsPath, '/pkg/main.go');
    assert.equal(resolveAnchorUri(undefined, uri('/fallback.md'))?.fsPath, '/fallback.md');
    assert.equal(resolveAnchorUri(undefined, undefined), undefined);
});

// --- what Show Server Info says -----------------------------------------

test('server info names the path, version and connection state', () => {
    const text = formatServerInfo({ command: '/usr/bin/ipm-rpc', version: 'ipm-rpc v0.4.2', connected: true });
    assert.match(text, /^Path:    \/usr\/bin\/ipm-rpc$/m);
    assert.match(text, /^Version: ipm-rpc v0\.4\.2$/m);
    assert.match(text, /^LSP:     connected$/m);
});

test('server info says what is missing when nothing resolved', () => {
    // The whole value of this command is the failing case: a user runs it
    // because the extension is not working.
    const text = formatServerInfo({ connected: false });
    assert.match(text, /Path:    \(not resolved\)/);
    assert.match(text, /Version: \(unknown\)/);
    assert.match(text, /LSP:     not connected/);
});

test('a restricted workspace says so first, and says how to fix it', () => {
    const text = formatServerInfo({ connected: false, untrusted: true });
    const first = text.split('\n')[0];
    assert.match(first, /RESTRICTED/,
        'the reason the server is not running belongs at the top, not under the path');
    assert.match(text, /Manage Workspace Trust/, 'tell the user the action that fixes it');
});

test('a version probe error is reported rather than swallowed', () => {
    const text = formatServerInfo({
        command: '/usr/bin/ipm-rpc', connected: false, versionError: 'exit status 127',
    });
    assert.match(text, /Version probe error: exit status 127/);
});

// --- the once-per-install missing-binary notice --------------------------

function fakeContext(seen = false) {
    const store = new Map<string, unknown>([['ipm.didShowMissingBinaryNotice', seen || undefined]]);
    return {
        globalState: {
            get: (key: string) => store.get(key),
            update: (key: string, value: unknown) => { store.set(key, value); return Promise.resolve(); },
        },
    } as never;
}

test('the missing-binary notice appears once, and never again', () => {
    shown.length = 0;
    const ctx = fakeContext();

    showOneShotMissingBinaryNotice(ctx);
    assert.equal(shown.length, 1, 'the first run tells the user how to get the LSP features');
    assert.match(shown[0].message, /ipm\.serverPath/, 'name the setting that fixes it');
    assert.match(shown[0].message, /Grammar highlighting works without it/,
        'say what still works, so the notice is not read as "the extension is broken"');

    showOneShotMissingBinaryNotice(ctx);
    showOneShotMissingBinaryNotice(ctx);
    assert.equal(shown.length, 1, 'a notice on every activation would be nagware');
});

test('an install that has already seen the notice stays quiet', () => {
    shown.length = 0;
    showOneShotMissingBinaryNotice(fakeContext(true));
    assert.deepEqual(shown, []);
});
