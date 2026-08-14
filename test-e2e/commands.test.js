// The three commands nothing has ever covered — copy path, copy relative path,
// reveal in explorer — plus the embed command that writes to disk.
//
// All four are only reachable with a preview panel focused, which is why they
// escaped the unit suite: `vscode.window.activeTextEditor` is undefined there,
// and the code has to find the source document another way.

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vscode = require('vscode');
const { activated, openDoc, closeEverything, allTabs, waitFor, workspaceUri } = require('./helpers');

suite('preview-scoped commands', () => {
    setup(async () => {
        await activated();
        await closeEverything();
        await vscode.env.clipboard.writeText('');
    });
    suiteTeardown(closeEverything);

    async function previewOf(name) {
        await openDoc(name);
        await vscode.commands.executeCommand('infinite.pm.openPreviewToSide');
        await waitFor(() => allTabs().some((t) => t.isPreviewPanel), `the ${name} preview`);
    }

    test('Copy Path puts the source file\'s absolute path on the clipboard', async () => {
        await previewOf('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.copyPath');

        const copied = await waitFor(
            async () => (await vscode.env.clipboard.readText()) || undefined,
            'something on the clipboard',
        );
        assert.ok(path.isAbsolute(copied), `expected an absolute path, got ${copied}`);
        assert.equal(path.basename(copied), 'diagram.ipmt',
            'the preview must copy the path of its SOURCE, not of the webview');
    });

    test('Copy Relative Path copies the workspace-relative one', async () => {
        await previewOf('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.copyRelativePath');

        const copied = await waitFor(
            async () => (await vscode.env.clipboard.readText()) || undefined,
            'something on the clipboard',
        );
        assert.equal(copied, 'diagram.ipmt',
            'relative to the workspace root, which is what a reader can paste into a link');
        assert.ok(!path.isAbsolute(copied));
    });

    test('Reveal in Explorer View runs without an active text editor', async () => {
        // The assertion that matters is "does not throw": these commands run
        // with a webview focused, where activeTextEditor is undefined, and the
        // failure mode is an unhandled rejection in the extension host.
        await previewOf('diagram.ipmt');
        await vscode.commands.executeCommand('infinite.pm.revealInExplorer');
    });
});

suite('embed on demand', () => {
    const generated = () => workspaceUri('_ipm').fsPath;
    // ipm.embed writes SVGs relative to the GIT REPOSITORY containing the
    // markdown, not to the workspace folder. This fixture lives inside the
    // extension's own repo, so without a repository of its own the SVGs land
    // at the extension repo's root under _ipm/test-e2e/fixtures/… — which is
    // both a wrong assertion and litter. Give the fixture a repository for the
    // duration, the way the Go tests do (a .git directory with a HEAD is
    // enough for FindRepoRoot to stop there).
    const dotGit = () => workspaceUri('.git').fsPath;
    let original;

    setup(async () => {
        await activated();
        await closeEverything();
        original = fs.readFileSync(workspaceUri('page.md').fsPath, 'utf8');
        fs.rmSync(generated(), { recursive: true, force: true });
        fs.mkdirSync(dotGit(), { recursive: true });
        fs.writeFileSync(path.join(dotGit(), 'HEAD'), 'ref: refs/heads/main\n');
    });

    teardown(async () => {
        // Leave the fixture as we found it: these tests write real files.
        fs.writeFileSync(workspaceUri('page.md').fsPath, original);
        fs.rmSync(generated(), { recursive: true, force: true });
        fs.rmSync(dotGit(), { recursive: true, force: true });
        await closeEverything();
    });

    test('Force Re-embed Current File writes the SVG and links it', async () => {
        const doc = await openDoc('page.md');
        await vscode.commands.executeCommand('infinite.pm.embedCurrentFile');

        // Two halves of the same promise: a file on disk, and a marker in the
        // markdown pointing at it.
        const svg = await waitFor(
            () => {
                const dir = path.join(generated(), 'page');
                if (!fs.existsSync(dir)) return undefined;
                const found = fs.readdirSync(dir).filter((f) => f.endsWith('.ipm.svg'));
                return found.length ? path.join(dir, found[0]) : undefined;
            },
            'a generated SVG under _ipm/page/',
        );
        // Not just "is it an SVG". Every SVG check across these repos used to
        // stop at that, and a layout collapse — every node at (0,0), no edges —
        // passes it while producing a picture nobody can read.
        const rendered = fs.readFileSync(svg, 'utf8');
        assert.match(rendered, /<svg/, 'the generated file must be an SVG');

        const labels = [...rendered.matchAll(/<text[^>]*>([^<]*)<\/text>/g)].map((m) => m[1]);
        for (const node of ['alpha', 'beta']) {
            assert.ok(labels.includes(node),
                `the fence names ${node} and the diagram does not: labels were ${labels.join(', ')}`);
        }
        const edges = [...rendered.matchAll(/data-edge-base=/g)].length;
        assert.ok(edges >= 1,
            'the fence has an arrow; a diagram with no edge geometry is a layout failure ' +
            'that still renders as a valid SVG');

        await waitFor(
            () => doc.getText().includes('<!-- ipm-svg') || undefined,
            'the marker to be inserted into the markdown',
        );
        assert.match(doc.getText(), /!\[\]\(_ipm\/page\/\d+\.ipm\.svg\)/,
            'the marker is only useful if the image link follows it');
    });
});
