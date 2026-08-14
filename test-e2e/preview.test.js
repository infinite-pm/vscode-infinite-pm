// Tab choreography for the two preview commands.
//
// This is the reason an extension-host lane exists at all: the unit tests can
// assert that `tabGroups.close` was called on a stub, but only a real host can
// say what the user is left looking at. The in-place command's whole contract
// is that the column ends up with one tab.

const assert = require('assert');
const vscode = require('vscode');
const { activated, openDoc, closeEverything, allTabs, waitFor } = require('./helpers');

suite('preview commands', () => {
    setup(async () => {
        await activated();
        await closeEverything();
    });
    suiteTeardown(closeEverything);

    test('Open Preview to the Side leaves the source open beside it', async () => {
        await openDoc('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.openPreviewToSide');

        const tabs = await waitFor(
            () => { const t = allTabs(); return t.some((x) => x.isPreviewPanel) ? t : undefined; },
            'the preview panel to appear',
        );
        assert.ok(tabs.some((t) => t.label === 'diagram.ipmt' && !t.isPreviewPanel),
            'the source must stay open — "to the side" means both are visible');
        const columns = new Set(tabs.map((t) => t.viewColumn));
        assert.equal(columns.size, 2, 'source and preview belong in different columns');
    });

    test('Open as Preview replaces the tab it was run from', async () => {
        await openDoc('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.openPreview');

        await waitFor(
            () => {
                const tabs = allTabs();
                return tabs.length === 1 && tabs[0].isPreviewPanel ? tabs : undefined;
            },
            'exactly one tab, the preview, in the source\'s column',
        );
    });

    test('the chord round trip returns to the source', async () => {
        // Shift+Ctrl+V both ways. The commands are the same ones the keybindings
        // point at, so this asserts the round trip without simulating keys.
        const doc = await openDoc('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.openPreview');
        await waitFor(() => allTabs().every((t) => t.isPreviewPanel), 'the preview to take over');

        await vscode.commands.executeCommand('infinite.pm.showSource');
        const tabs = await waitFor(
            () => {
                const t = allTabs();
                return t.length === 1 && !t[0].isPreviewPanel ? t : undefined;
            },
            'the source to come back alone',
        );
        assert.equal(tabs[0].uri, doc.uri.toString(), 'and it must be the same file');
    });

    test('a second open focuses the existing preview rather than duplicating it', async () => {
        await openDoc('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.openPreviewToSide');
        await waitFor(() => allTabs().some((t) => t.isPreviewPanel), 'the first preview');

        await vscode.commands.executeCommand('infinite.pm.openPreviewToSide');
        // Give a duplicate a chance to appear before asserting it did not.
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(allTabs().filter((t) => t.isPreviewPanel).length, 1,
            'one preview per document, however many times the command runs');
    });

    test('the preview refuses politely when the active editor is not .ipmt', async () => {
        await openDoc('page.md');
        await vscode.commands.executeCommand('infinite.pm.openPreview');
        await new Promise((r) => setTimeout(r, 500));
        assert.equal(allTabs().filter((t) => t.isPreviewPanel).length, 0,
            'a markdown file has its own preview; ours must not open an empty panel');
    });
});
