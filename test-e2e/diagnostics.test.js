// Diagnostics arriving from the real server, over a real LSP connection, into
// VS Code's Problems panel.
//
// The Go suite proves ipm-rpc PUBLISHES them and the unit suite proves nothing
// about them at all — the wire between the two has never been exercised. This
// is the assertion that fails if the client stops subscribing, if the document
// selector stops matching .ipmt, or if the server is not started at all.

const assert = require('assert');
const vscode = require('vscode');
const { activated, openDoc, closeEverything, waitFor, workspaceUri } = require('./helpers');

suite('diagnostics', () => {
    setup(async () => {
        await activated();
        await closeEverything();
    });
    suiteTeardown(closeEverything);

    test('an invalid .ipmt reports its error, with the reason', async () => {
        const doc = await openDoc('broken.ipmt');
        const found = await waitFor(
            () => {
                const d = vscode.languages.getDiagnostics(doc.uri);
                return d && d.length ? d : undefined;
            },
            'a diagnostic on broken.ipmt',
        );
        // The fixture is `alpha ::e --::P--> gamma ::c`: PartOf is not legal
        // from an event to a concept, and the message should say so rather
        // than "parse error".
        assert.match(found[0].message, /PartOf|::P/,
            `the message should name the rule that was broken, got: ${found[0].message}`);
        assert.ok(found[0].range, 'a diagnostic without a range cannot be shown in the gutter');
    });

    test('a valid .ipmt reports nothing', async () => {
        const doc = await openDoc('diagram.ipmt');
        // Give the server the same chance to be wrong as the test above gave it
        // to be right, then assert silence.
        await new Promise((r) => setTimeout(r, 2_000));
        assert.deepEqual(vscode.languages.getDiagnostics(doc.uri), [],
            'a clean file with warnings on it is worse than no diagnostics at all');
    });

    test('fixing the file clears the diagnostic', async () => {
        const uri = workspaceUri('broken.ipmt');
        const doc = await vscode.workspace.openTextDocument(uri);
        const editor = await vscode.window.showTextDocument(doc, { preview: false });
        await waitFor(() => vscode.languages.getDiagnostics(uri).length > 0 || undefined,
            'the initial diagnostic');

        // thing -> event IS legal for PartOf; swapping the kinds fixes it.
        await editor.edit((b) => b.replace(
            new vscode.Range(0, 0, doc.lineCount, 0),
            'alpha ::t --::P--> gamma ::e\n',
        ));
        try {
            await waitFor(() => vscode.languages.getDiagnostics(uri).length === 0 || undefined,
                'the diagnostic to clear once the file is valid');
        } finally {
            // The edit is in-memory only; revert so the fixture stays broken
            // for the next run.
            await vscode.commands.executeCommand('workbench.action.files.revert');
        }
    });
});
