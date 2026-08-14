// Shared helpers for the extension-host specs.
//
// Every wait here is on a condition, never on a duration. A `setTimeout` that
// is usually long enough is how a suite becomes a coin flip on a loaded CI
// runner, and a flaky gate teaches people to ignore red.

const assert = require('assert');
const vscode = require('vscode');

/** Poll `predicate` until it is truthy, or fail with `what` in the message. */
async function waitFor(predicate, what, timeout = 20_000, interval = 100) {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
        last = await predicate();
        if (last) return last;
        await new Promise((r) => setTimeout(r, interval));
    }
    assert.fail(`timed out after ${timeout}ms waiting for ${what} (last value: ${JSON.stringify(last)})`);
}

/** Every tab across every group, as {label, viewColumn, kind}. */
function allTabs() {
    return vscode.window.tabGroups.all.flatMap((g) =>
        g.tabs.map((t) => ({
            label: t.label,
            viewColumn: g.viewColumn,
            isPreviewPanel: t.input instanceof vscode.TabInputWebview,
            uri: t.input && t.input.uri ? t.input.uri.toString() : undefined,
        })),
    );
}

async function closeEverything() {
    await vscode.commands.executeCommand('workbench.action.closeAllEditors');
    await waitFor(() => allTabs().length === 0, 'all editors to close', 5_000);
}

/** The one workspace folder these specs run against. */
function workspaceUri(...segments) {
    const root = vscode.workspace.workspaceFolders[0].uri;
    return segments.length ? vscode.Uri.joinPath(root, ...segments) : root;
}

async function openDoc(name) {
    const doc = await vscode.workspace.openTextDocument(workspaceUri(name));
    await vscode.window.showTextDocument(doc, { preview: false });
    return doc;
}

/** The extension, activated. Its exports are what the markdown preview uses. */
async function activated() {
    const ext = vscode.extensions.getExtension('infinite-pm.vscode-infinite-pm');
    assert.ok(ext, 'the extension under test is not installed in this host');
    return ext.isActive ? ext.exports : await ext.activate();
}

module.exports = { waitFor, allTabs, closeEverything, workspaceUri, openDoc, activated };
