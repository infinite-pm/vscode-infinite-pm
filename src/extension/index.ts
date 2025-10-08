// Entry point for the vscode-infinite-pm extension.
//
// Scope (tiny by design — the heavy lifting is in cmd/ipm-rpc):
//   * resolve the ipm-rpc binary (config → PATH → bundled fallback)
//   * start an LSP client (vscode-languageclient) and connect to ipm-rpc
//     over stdio
//   * forward textDocument/didSave on .md files to the server's
//     workspace/executeCommand ipm.embed (when ipm.embedOnSave is true)
//   * graceful degradation when ipm-rpc isn't installed: grammars still
//     work; the LSP features are dormant with a one-time notification
//   * auto-restart the LSP client when the ipm-rpc binary mtime changes
//     (so `go install ./cmd/ipm-rpc` re-picks-up without a window reload)
//   * "infinite.pm: Restart Language Server" command for manual restarts

import * as fs from 'fs';
import * as vscode from 'vscode';
import {
    LanguageClient,
    LanguageClientOptions,
    ServerOptions,
    TransportKind,
} from 'vscode-languageclient/node';

import { resolveServer, ServerInfo } from './serverPath';
import { findGitRepoRoot } from './gitRepo';
import { runIpmEmbedForce, wireEmbedOnSave, wireIpmtIncludeRefresh } from './embedOnSave';
import { registerCacheBust, setDebugLog, setLiveCache } from './cachebust';
import { LiveCache, wireLiveRefresh } from './liveRefresh';
import { registerFenceHighlight, registerInlineIpmtHighlight, setHighlightDebugLog, setTokenLookup } from './previewHighlight';
import { getServerVersion } from './serverVersion';
import {
    copyActivePreviewPath,
    disposeAllIpmtPreviews,
    onIpmtChange,
    onIpmtClose,
    openIpmtPreview,
    revealActivePreviewInExplorer,
    setIpmtPreviewLog,
    showSource as showIpmtSource,
} from './ipmtPreview';

let client: LanguageClient | undefined;
let clientDisposables: vscode.Disposable[] = [];
// Most-recently-active markdown editor URI. The re-embed commands fall
// back to this when the active tab is a *preview* (a webview, where
// vscode.window.activeTextEditor is undefined) — so "Force Re-embed …"
// works while looking at the rendered markdown, not just the source.
let lastMarkdownUri: vscode.Uri | undefined;
let binaryWatcher: fs.FSWatcher | undefined;
let restartTimer: NodeJS.Timeout | undefined;
let restartInFlight = false;
let serverState: {
    command?: string;
    version?: string;
    versionError?: string;
    connected: boolean;
} = { connected: false };

const liveCache = new LiveCache();
setLiveCache(liveCache);
setTokenLookup((uri, source) => liveCache.getTokensForSource(uri, source));

// The subset of markdown-it's API our preview hooks actually touch. Derived
// from the three register* functions' own parameter types so it stays in
// lock-step with them — VS Code's markdown engine passes a full MarkdownIt
// instance at runtime, which structurally satisfies this. (We can't use the
// `MarkdownIt` type from @types/markdown-it directly: its richer Token type
// isn't assignable to the narrower token shapes those hooks declare.)
type PreviewMarkdownIt =
    Parameters<typeof registerCacheBust>[0] &
    Parameters<typeof registerFenceHighlight>[0] &
    Parameters<typeof registerInlineIpmtHighlight>[0];

const extensionApi = {
    extendMarkdownIt(md: PreviewMarkdownIt) {
        registerCacheBust(md);
        registerFenceHighlight(md);
        registerInlineIpmtHighlight(md);
        return md;
    },
};

export async function activate(ctx: vscode.ExtensionContext): Promise<typeof extensionApi> {
    const log = vscode.window.createOutputChannel('infinite.pm');
    ctx.subscriptions.push(log);
    log.appendLine(`infinite.pm extension activating (built: ${(globalThis as any).BUILD_TIMESTAMP || 'dev'})`);
    setDebugLog((line) => log.appendLine(line));
    setHighlightDebugLog((line) => log.appendLine(line));
    setIpmtPreviewLog((line) => log.appendLine(line));

    ctx.subscriptions.push(
        vscode.commands.registerCommand('infinite.pm.restartServer', async () => {
            log.appendLine('[lsp] restart requested via command');
            await restartClient(ctx, log, 'command');
        }),
        vscode.commands.registerCommand('infinite.pm.showServerInfo', async () => {
            await showServerInfo(log);
        }),
        vscode.commands.registerCommand('infinite.pm.openPreview', async () => {
            await openIpmtPreview(ctx, client, vscode.ViewColumn.Active);
        }),
        vscode.commands.registerCommand('infinite.pm.openPreviewToSide', async () => {
            await openIpmtPreview(ctx, client, vscode.ViewColumn.Beside);
        }),
        vscode.commands.registerCommand('infinite.pm.showSource', async () => {
            await showIpmtSource();
        }),
        vscode.commands.registerCommand('infinite.pm.embedCurrentFile', async () => {
            await embedCurrentFile(client, log);
        }),
        vscode.commands.registerCommand('infinite.pm.embedAllInWorkspace', async () => {
            await embedAllInWorkspace(client, log);
        }),
        vscode.commands.registerCommand('infinite.pm.embedAllInRepo', async () => {
            await embedAllInRepo(client, log);
        }),
        vscode.commands.registerCommand('infinite.pm.copyPath', async () => {
            await copyActivePreviewPath(/*relative*/ false);
        }),
        vscode.commands.registerCommand('infinite.pm.copyRelativePath', async () => {
            await copyActivePreviewPath(/*relative*/ true);
        }),
        vscode.commands.registerCommand('infinite.pm.revealInExplorer', async () => {
            await revealActivePreviewInExplorer();
        }),
        vscode.window.onDidChangeActiveTextEditor((editor) => {
            if (editor && editor.document.languageId === 'markdown' && editor.document.uri.scheme === 'file') {
                lastMarkdownUri = editor.document.uri;
            }
        }),
        vscode.workspace.onDidChangeTextDocument((e) => {
            onIpmtChange(client, e.document);
        }),
        vscode.workspace.onDidCloseTextDocument((doc) => {
            onIpmtClose(doc);
        }),
    );

    // Seed the markdown fallback from whatever's active at activation, so
    // the re-embed commands work even if the user's first action is to
    // focus an already-open markdown preview.
    const active = vscode.window.activeTextEditor;
    if (active && active.document.languageId === 'markdown' && active.document.uri.scheme === 'file') {
        lastMarkdownUri = active.document.uri;
    }

    await startClient(ctx, log);

    return extensionApi;
}

export async function deactivate(): Promise<void> {
    stopBinaryWatcher();
    disposeAllIpmtPreviews();
    await stopClient();
}

async function startClient(ctx: vscode.ExtensionContext, log: vscode.OutputChannel): Promise<void> {
    serverState = { connected: false };
    const serverInfo = resolveServer(ctx, log);
    if (!serverInfo) {
        showOneShotMissingBinaryNotice(ctx);
        return;
    }
    log.appendLine(`[lsp] using ipm-rpc at ${serverInfo.command}`);
    serverState.command = serverInfo.command;

    try {
        const v = await getServerVersion(serverInfo.command);
        serverState.version = v.version;
        log.appendLine(`[lsp] ${v.version}`);
    } catch (err) {
        serverState.versionError = String(err);
        log.appendLine(`[lsp] --version probe failed: ${err}`);
    }

    const serverOpts: ServerOptions = {
        command: serverInfo.command,
        args: serverInfo.args,
        transport: TransportKind.stdio,
    };
    const clientOpts: LanguageClientOptions = {
        documentSelector: [
            { scheme: 'file', language: 'ipmt' },
            { scheme: 'file', language: 'markdown' },
        ],
        outputChannel: log,
    };
    const newClient = new LanguageClient('ipm-rpc', 'infinite.pm', serverOpts, clientOpts);

    try {
        await newClient.start();
        log.appendLine('[lsp] connected');
        serverState.connected = true;
    } catch (err) {
        log.appendLine(`[lsp] failed to start: ${err}`);
        vscode.window.showWarningMessage(
            `infinite.pm: could not start ipm-rpc (${err}). Highlighting works; LSP features are disabled.`,
        );
        return;
    }

    client = newClient;
    clientDisposables = [];
    wireEmbedOnSave(ctx, newClient, log, clientDisposables);
    wireIpmtIncludeRefresh(ctx, newClient, log, clientDisposables);
    wireLiveRefresh(ctx, newClient, liveCache, log, clientDisposables);

    setupBinaryWatcher(ctx, log, serverInfo);
}

async function stopClient(): Promise<void> {
    for (const d of clientDisposables) {
        try { d.dispose(); } catch { /* best-effort */ }
    }
    clientDisposables = [];
    if (client) {
        try {
            await client.stop();
        } catch {
            /* best-effort */
        }
        client = undefined;
    }
}

async function restartClient(ctx: vscode.ExtensionContext, log: vscode.OutputChannel, reason: string): Promise<void> {
    if (restartInFlight) {
        log.appendLine(`[lsp] restart (${reason}) skipped — restart already in flight`);
        return;
    }
    restartInFlight = true;
    try {
        log.appendLine(`[lsp] restarting (${reason})`);
        stopBinaryWatcher();
        await stopClient();
        await startClient(ctx, log);
        log.appendLine(`[lsp] restart complete (${reason})`);
    } finally {
        restartInFlight = false;
    }
}

function setupBinaryWatcher(ctx: vscode.ExtensionContext, log: vscode.OutputChannel, serverInfo: ServerInfo): void {
    stopBinaryWatcher();

    const cfg = vscode.workspace.getConfiguration('ipm');
    if (!cfg.get<boolean>('restartOnBinaryChange', true)) {
        return;
    }
    if (!serverInfo.command) {
        return;
    }
    try {
        // fs.watch on a single file fires when the inode is replaced (which
        // is what `go install` does — it writes to a tempfile and renames).
        // Some platforms drop the watch after the rename; re-set it from
        // inside the callback if that becomes an issue. For now the simple
        // form is enough.
        binaryWatcher = fs.watch(serverInfo.command, () => {
            if (restartTimer) {
                clearTimeout(restartTimer);
            }
            restartTimer = setTimeout(() => {
                restartTimer = undefined;
                void restartClient(ctx, log, 'binary changed');
            }, 500);
        });
        binaryWatcher.on('error', (err) => {
            log.appendLine(`[lsp] binary watcher error: ${err}`);
        });
        log.appendLine(`[lsp] watching binary for changes: ${serverInfo.command}`);
    } catch (err) {
        log.appendLine(`[lsp] could not watch ipm-rpc binary: ${err}`);
        binaryWatcher = undefined;
    }
}

function stopBinaryWatcher(): void {
    if (restartTimer) {
        clearTimeout(restartTimer);
        restartTimer = undefined;
    }
    if (binaryWatcher) {
        try { binaryWatcher.close(); } catch { /* best-effort */ }
        binaryWatcher = undefined;
    }
}

async function showServerInfo(log: vscode.OutputChannel): Promise<void> {
    const lines: string[] = [];
    lines.push(`Path:    ${serverState.command ?? '(not resolved)'}`);
    lines.push(`Version: ${serverState.version ?? '(unknown)'}`);
    if (serverState.versionError) {
        lines.push(`Version probe error: ${serverState.versionError}`);
    }
    lines.push(`LSP:     ${serverState.connected ? 'connected' : 'not connected'}`);
    const message = lines.join('\n');

    log.appendLine('--- infinite.pm: server info ---');
    log.appendLine(message);
    log.appendLine('--------------------------------');

    const action = await vscode.window.showInformationMessage(
        `infinite.pm — ${serverState.version ?? '(unknown version)'} @ ${serverState.command ?? '(not resolved)'}`,
        { modal: false, detail: message },
        'Show Output',
        'Restart Server',
    );
    if (action === 'Show Output') {
        log.show(true);
    } else if (action === 'Restart Server') {
        await vscode.commands.executeCommand('infinite.pm.restartServer');
    }
}

// resolveTargetMarkdown returns the markdown file the re-embed commands
// should act on: the active text editor when it's a markdown file, else
// the most-recently-active markdown editor. The fallback is what makes
// the commands usable while the *preview* (a webview) is focused — there
// vscode.window.activeTextEditor is undefined.
function resolveTargetMarkdown(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.languageId === 'markdown' && editor.document.uri.scheme === 'file') {
        return editor.document.uri;
    }
    return lastMarkdownUri;
}

// resolveAnchorUri returns a file URI to anchor a repo lookup on: the
// active editor's file when there is one, else the markdown fallback (so
// "Re-embed All in Repo" works from a focused markdown preview too).
function resolveAnchorUri(): vscode.Uri | undefined {
    const editor = vscode.window.activeTextEditor;
    if (editor && editor.document.uri.scheme === 'file') {
        return editor.document.uri;
    }
    return lastMarkdownUri;
}

// embedCurrentFile force-re-embeds every ipmt block in the target
// markdown document. Bypasses the SVG-freshness check on the LSP side
// — useful after a renderer/style upgrade where the source hash
// hasn't changed but the on-disk SVGs need to be regenerated.
async function embedCurrentFile(client: LanguageClient | undefined, log: vscode.OutputChannel): Promise<void> {
    if (!client) {
        void vscode.window.showWarningMessage('infinite.pm: LSP server not running.');
        return;
    }
    const uri = resolveTargetMarkdown();
    if (!uri) {
        void vscode.window.showInformationMessage('infinite.pm: open a markdown file (or its preview) first.');
        return;
    }
    // Save first so the disk content matches the buffer — ipm.embed
    // reads from disk. The buffer may not be the active editor (e.g. the
    // preview is focused), so look it up by URI.
    const doc = vscode.workspace.textDocuments.find((d) => d.uri.toString() === uri.toString());
    if (doc && doc.isDirty) {
        await doc.save();
    }
    log.appendLine(`[embed] force re-embed: ${uri.fsPath}`);
    await runIpmEmbedForce(client, uri, log);
}

// embedAllInWorkspace finds every `.md` file in the workspace and
// force-re-embeds it. Useful as a one-shot after a renderer upgrade
// — equivalent to running md-embed across the whole repo. Skips files
// inside common ignore directories (.git, node_modules) via VS Code's
// default findFiles search.
async function embedAllInWorkspace(client: LanguageClient | undefined, log: vscode.OutputChannel): Promise<void> {
    if (!client) {
        void vscode.window.showWarningMessage('infinite.pm: LSP server not running.');
        return;
    }
    const files = await vscode.workspace.findFiles('**/*.md', '**/node_modules/**');
    if (files.length === 0) {
        void vscode.window.showInformationMessage('infinite.pm: no .md files found in workspace.');
        return;
    }
    await confirmAndEmbedFiles(client, log, files, 'workspace');
}

// embedAllInRepo force-re-embeds every `.md` file in the git repository
// that contains the active file — the repo is located by walking up from
// the active file's directory to the nearest `.git`. Useful in multi-root
// or monorepo setups where embedAllInWorkspace would touch unrelated repos.
async function embedAllInRepo(client: LanguageClient | undefined, log: vscode.OutputChannel): Promise<void> {
    if (!client) {
        void vscode.window.showWarningMessage('infinite.pm: LSP server not running.');
        return;
    }
    const anchor = resolveAnchorUri();
    if (!anchor) {
        void vscode.window.showInformationMessage('infinite.pm: open a file inside the target git repo first.');
        return;
    }
    const repoRoot = findGitRepoRoot(anchor);
    if (!repoRoot) {
        void vscode.window.showInformationMessage(
            `infinite.pm: ${anchor.fsPath} is not inside a git repository.`,
        );
        return;
    }
    const files = await vscode.workspace.findFiles(
        new vscode.RelativePattern(repoRoot, '**/*.md'),
        '**/node_modules/**',
    );
    if (files.length === 0) {
        void vscode.window.showInformationMessage('infinite.pm: no .md files found in this git repo.');
        return;
    }
    const repoLabel = vscode.workspace.asRelativePath(repoRoot, false) || repoRoot.fsPath;
    await confirmAndEmbedFiles(client, log, files, `repo ${repoLabel}`);
}

// confirmAndEmbedFiles prompts (modal) and then force-re-embeds the given
// files with a cancellable progress notification. Shared by the
// "re-embed all in workspace" and "re-embed all in repo" commands.
async function confirmAndEmbedFiles(
    client: LanguageClient,
    log: vscode.OutputChannel,
    files: vscode.Uri[],
    scope: string,
): Promise<void> {
    const proceed = await vscode.window.showInformationMessage(
        `infinite.pm: force re-embed ${files.length} markdown files in ${scope}? Existing SVGs will be overwritten.`,
        { modal: true },
        'Re-embed all',
    );
    if (proceed !== 'Re-embed all') return;

    await vscode.window.withProgress(
        {
            location: vscode.ProgressLocation.Notification,
            title: `infinite.pm: re-embedding ${files.length} files in ${scope}`,
            cancellable: true,
        },
        async (progress, token) => {
            const step = 100 / files.length;
            let done = 0;
            for (const uri of files) {
                if (token.isCancellationRequested) {
                    log.appendLine(`[embed] ${scope} re-embed cancelled by user`);
                    break;
                }
                progress.report({
                    message: vscode.workspace.asRelativePath(uri),
                    increment: step,
                });
                await runIpmEmbedForce(client, uri, log);
                done++;
            }
            log.appendLine(`[embed] ${scope} re-embed done: ${done}/${files.length} files`);
        },
    );
}

function showOneShotMissingBinaryNotice(ctx: vscode.ExtensionContext) {
    const key = 'ipm.didShowMissingBinaryNotice';
    if (ctx.globalState.get<boolean>(key)) {
        return;
    }
    void ctx.globalState.update(key, true);
    void vscode.window.showInformationMessage(
        "infinite.pm: install ipm-rpc to enable diagnostics, hover, semantic tokens, and embed-on-save. " +
        "Set 'ipm.serverPath' or add the binary to your PATH. Grammar highlighting works without it.",
        'OK',
    );
}
