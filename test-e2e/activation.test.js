// Does the thing we ship actually load, and is everything it promises present?
//
// The manifest tests assert what package.json DECLARES. This asserts what the
// running extension host has: a command declared but never registered is
// invisible to those tests and produces "command 'x' not found" for a user.

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vscode = require('vscode');
const { activated, openDoc, closeEverything, waitFor } = require('./helpers');

suite('activation', () => {
    suiteTeardown(closeEverything);

    test('the extension activates and exports its markdown-it hook', async () => {
        const api = await activated();
        assert.equal(typeof api.extendMarkdownIt, 'function',
            'the markdown preview asks for this by name; without it every fence is unstyled');
    });

    test('every command the manifest declares is really registered', async () => {
        await activated();
        const manifest = JSON.parse(
            fs.readFileSync(path.resolve(__dirname, '..', 'package.json'), 'utf8'));
        const declared = manifest.contributes.commands.map((c) => c.command);
        const registered = new Set(await vscode.commands.getCommands(true));

        const missing = declared.filter((id) => !registered.has(id));
        assert.deepEqual(missing, [],
            'these are in the palette but nothing answers them — the user gets ' +
            '"command not found"');
    });

    test('activation is triggered by opening a .ipmt file', async () => {
        // The manifest claims onLanguage:ipmt. If that ever stops being true,
        // the first .ipmt a user opens has no highlighting until something else
        // wakes the extension.
        const ext = vscode.extensions.getExtension('infinite-pm.vscode-infinite-pm');
        await openDoc('diagram.ipmt');
        await waitFor(() => ext.isActive, 'the extension to activate on a .ipmt document');
    });

    test('the language server starts and answers', async () => {
        // Everything downstream — diagnostics, colours, embed — is this
        // connection. Assert it directly so a failure here is not reported as
        // six unrelated failures.
        await activated();
        const doc = await openDoc('diagram.ipmt');
        const tokens = await waitFor(
            async () => {
                const t = await vscode.commands.executeCommand(
                    'vscode.provideDocumentSemanticTokens', doc.uri);
                return t && t.data && t.data.length > 0 ? t : undefined;
            },
            'semantic tokens from ipm-rpc',
        );
        assert.ok(tokens.data.length % 5 === 0,
            'the LSP semantic-token encoding is 5 uint32s per token');
    });
});
