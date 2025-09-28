// embed-on-save handler.
//
// When the user saves a .md file with ipmt blocks, forward to the LSP
// server's workspace/executeCommand ipm.embed. The server reads the file
// from disk (it just got saved), runs the same md-embed logic the CLI
// uses, writes the new SVGs + updates marker hashes, and returns stats
// we surface in the output channel.
//
// Gated by the ipm.embedOnSave setting; debounced by ipm.embedDebounceMs.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

import { findGitRepoRoot } from './gitRepo';

export function wireEmbedOnSave(
    ctx: vscode.ExtensionContext,
    client: LanguageClient,
    log: vscode.OutputChannel,
    disposables?: vscode.Disposable[],
): void {
    const debouncers = new Map<string, NodeJS.Timeout>();

    const handler = vscode.workspace.onDidSaveTextDocument(async (doc) => {
        if (doc.languageId !== 'markdown') {
            return;
        }
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('embedOnSave', true)) {
            return;
        }
        const delay = cfg.get<number>('embedDebounceMs', 0);
        const key = doc.uri.toString();

        const existing = debouncers.get(key);
        if (existing) {
            clearTimeout(existing);
        }
        const runEmbed = async () => {
            debouncers.delete(key);
            await runIpmEmbed(client, doc.uri, log);
        };
        if (delay > 0) {
            debouncers.set(key, setTimeout(() => { void runEmbed(); }, delay));
        } else {
            await runEmbed();
        }
    });
    ctx.subscriptions.push(handler);
    disposables?.push(handler);
}

export async function runIpmEmbed(client: LanguageClient, uri: vscode.Uri, log: vscode.OutputChannel): Promise<void> {
    await runIpmEmbedCore(client, uri, log, /*force*/ false);
}

// Debounce for the .ipmt -> including-markdown refresh. Coalesces the
// double-fire from onDidSaveTextDocument + the FileSystemWatcher (both
// see the same disk write) and rapid successive agent writes.
const IPMT_REFRESH_DEBOUNCE_MS = 150;

// wireIpmtIncludeRefresh keeps markdown previews/SVGs in sync when an
// *included* `.ipmt` file changes.
//
// The markdown-only embed-on-save listener never sees edits that land in
// a file pulled in via `<!-- ipm-include src=foo.ipmt -->` — so when an
// edit (often from an AI agent) modifies the .ipmt rather than the
// markdown, the committed SVG + the rendered preview go stale. This wires
// two signals — an editor save of a .ipmt (agent edits applied + saved
// through VS Code) and a raw disk write to any *.ipmt (external tools /
// CLI agents that bypass the editor) — to a re-embed of the open markdown
// documents that use includes.
//
// We re-embed with force=false: the include block's marker hash is derived
// from the included .ipmt's on-disk content, so the server detects the
// change (OutcomeRehash) and regenerates only the affected blocks; open
// markdown that doesn't reference the changed file is a cheap no-op.
export function wireIpmtIncludeRefresh(
    ctx: vscode.ExtensionContext,
    client: LanguageClient,
    log: vscode.OutputChannel,
    disposables?: vscode.Disposable[],
): void {
    const debouncers = new Map<string, NodeJS.Timeout>();

    const schedule = (ipmtFsPath: string) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('embedOnSave', true)) {
            return;
        }
        const prev = debouncers.get(ipmtFsPath);
        if (prev) clearTimeout(prev);
        debouncers.set(ipmtFsPath, setTimeout(() => {
            debouncers.delete(ipmtFsPath);
            void reembedMarkdownIncluding(client, ipmtFsPath, log);
        }, IPMT_REFRESH_DEBOUNCE_MS));
    };

    // Editor save of a .ipmt — covers agent edits applied + saved through
    // VS Code's editor.
    const onSave = vscode.workspace.onDidSaveTextDocument((doc) => {
        if (doc.languageId !== 'ipmt') return;
        schedule(doc.uri.fsPath);
    });

    // Raw disk writes that bypass the editor save flow (external tools,
    // CLI agents writing the file directly). Scoped to *.ipmt.
    const watcher = vscode.workspace.createFileSystemWatcher('**/*.ipmt');
    const onChange = watcher.onDidChange((uri) => schedule(uri.fsPath));
    const onCreate = watcher.onDidCreate((uri) => schedule(uri.fsPath));

    ctx.subscriptions.push(onSave, watcher, onChange, onCreate);
    disposables?.push(onSave, watcher, onChange, onCreate);
}

// markdownIncludesIpmt is the cheap necessary-condition matcher used to
// decide whether a markdown file depends on a given `.ipmt`. A markdown that
// includes the file via `<!-- ipm-include src=…/foo.ipmt -->` necessarily
// contains both the `ipm-include` directive and the .ipmt's basename (it
// appears in the `src=` path). Substring tests rather than re-parsing include
// syntax: sound, cheap, and a false positive is a harmless no-op (we re-embed
// with force=false). Exported for unit testing.
export function markdownIncludesIpmt(markdownText: string, ipmtBasename: string): boolean {
    return markdownText.includes('ipm-include') && markdownText.includes(ipmtBasename);
}

// reembedMarkdownIncluding re-embeds every markdown file that pulls in the
// changed `.ipmt`, so the committed SVG (and any live preview) tracks it.
//
// Scope: the git repo containing the .ipmt (falling back to its workspace
// folder, then to just the open markdown docs when the file is outside any
// workspace folder). Repo-wide — not just open files — because the common
// case is that the dependent markdown is committed/closed while only the
// shared .ipmt is being edited; the committed SVG must still regenerate.
//
// Matching: see markdownIncludesIpmt — a sound, cheap necessary condition.
// A false positive is a harmless no-op since we re-embed with force=false
// (the include block's marker hash is derived from the .ipmt's on-disk
// content, so the server rehashes exactly the blocks that actually changed).
//
// We skip markdown whose buffer has unsaved edits: ipm.embed reads from
// disk and would fight the user's pending changes; those refresh on their
// own next save.
async function reembedMarkdownIncluding(
    client: LanguageClient,
    ipmtFsPath: string,
    log: vscode.OutputChannel,
): Promise<void> {
    const ipmtUri = vscode.Uri.file(ipmtFsPath);
    const ipmtBasename = path.basename(ipmtFsPath);
    const base = findGitRepoRoot(ipmtUri) ?? vscode.workspace.getWorkspaceFolder(ipmtUri)?.uri;

    let candidates: vscode.Uri[];
    if (base) {
        candidates = await vscode.workspace.findFiles(
            new vscode.RelativePattern(base, '**/*.md'),
            '**/node_modules/**',
        );
    } else {
        candidates = vscode.workspace.textDocuments
            .filter((d) => d.languageId === 'markdown' && d.uri.scheme === 'file')
            .map((d) => d.uri);
    }

    const dirty = new Set(
        vscode.workspace.textDocuments
            .filter((d) => d.isDirty)
            .map((d) => d.uri.toString()),
    );

    let refreshed = 0;
    for (const md of candidates) {
        if (dirty.has(md.toString())) continue;
        let text: string;
        try {
            text = Buffer.from(await vscode.workspace.fs.readFile(md)).toString('utf8');
        } catch {
            continue;
        }
        if (!markdownIncludesIpmt(text, ipmtBasename)) continue;
        await runIpmEmbed(client, md, log);
        refreshed++;
    }

    if (refreshed === 0) {
        log.appendLine(`[embed] ${ipmtBasename} changed — no dependent markdown to refresh`);
        return;
    }
    log.appendLine(`[embed] ${ipmtBasename} changed — re-embedded ${refreshed} dependent markdown file(s)`);
    // Nudge the preview so regenerated SVGs / data URLs land in the DOM.
    try {
        await vscode.commands.executeCommand('markdown.preview.refresh');
    } catch (err) {
        log.appendLine(`[embed] markdown.preview.refresh failed: ${err}`);
    }
}

// runIpmEmbedForce is exported for the "Force re-embed current file"
// and "Force re-embed all .md in workspace" commands. With force=true
// the LSP server bypasses the SVG-freshness check and re-renders every
// block, regardless of whether the source hash changed.
export async function runIpmEmbedForce(client: LanguageClient, uri: vscode.Uri, log: vscode.OutputChannel): Promise<void> {
    await runIpmEmbedCore(client, uri, log, /*force*/ true);
}

async function runIpmEmbedCore(client: LanguageClient, uri: vscode.Uri, log: vscode.OutputChannel, force: boolean): Promise<void> {
    try {
        const res = await client.sendRequest<unknown>('workspace/executeCommand', {
            command: 'ipm.embed',
            arguments: [{ file: uri.toString(), force }],
        });
        const r = res as EmbedResult | null;
        if (!r) {
            log.appendLine('[embed] ipm.embed returned no result');
            return;
        }
        if (r.changed || force) {
            const tag = force ? ' (forced)' : '';
            log.appendLine(`[embed]${tag} ${uri.fsPath} — ${r.staleSummary || 'updated'}`);
        }
        if (r.warnings && r.warnings.length > 0) {
            for (const w of r.warnings) {
                log.appendLine(`[embed] WARN block ${w.blockIndex} ${w.outcome}: ${w.message}`);
            }
        }
    } catch (err) {
        log.appendLine(`[embed] ipm.embed failed for ${uri.fsPath}: ${err}`);
    }
}

interface EmbedResult {
    file: string;
    changed: boolean;
    warnings?: { blockIndex: number; outcome: string; message: string }[];
    staleSummary?: string;
}
