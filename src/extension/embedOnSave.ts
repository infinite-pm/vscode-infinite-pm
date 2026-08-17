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

// A BURST of .ipmt changes — a generator writing a corpus, a checkout, a
// re-embed sweep — is not N edits; it is one event, and it must cost one
// scan. The debounce above is per file, which is right for two agents each
// editing their own file and catastrophic for a tool writing 2,800 files:
// each one scheduled its own repo-wide markdown scan (findFiles over every
// *.md, then a read of each), 150ms apart, and the extension host stalled
// for minutes — twice in one day the renderer died behind it. So changes
// coalesce into one pending set, flushed once the burst has been quiet for
// this long, and the scan runs ONCE for the whole set.
const IPMT_BURST_QUIET_MS = 500;

// Generated trees are never edited by hand and never included by hand-written
// markdown that matters here; a change under one of these is noise to this
// feature and, in bulk, the thing that took the extension host down. Matched
// as path segments so `temp/` anywhere in the tree counts, not only at the
// root. `ipm.embedIgnore` extends the list.
const IPMT_IGNORED_SEGMENTS = ['temp', 'tmp', 'node_modules', '.git', 'out', 'dist', 'target', 'build'];

export function ipmtChangeIsIgnored(fsPath: string, extra: string[] = []): boolean {
    const segs = fsPath.split(/[\\/]/);
    const ignored = new Set([...IPMT_IGNORED_SEGMENTS, ...extra]);
    // Not the basename: a file called out.ipmt is fine, a directory called out is not.
    return segs.slice(0, -1).some((seg) => ignored.has(seg));
}

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
    // One pending set for the whole burst, not a timer per file.
    const pending = new Set<string>();
    let flush: NodeJS.Timeout | undefined;
    let dropped = 0;

    const schedule = (ipmtFsPath: string) => {
        const cfg = vscode.workspace.getConfiguration('ipm');
        if (!cfg.get<boolean>('embedOnSave', true)) {
            return;
        }
        if (ipmtChangeIsIgnored(ipmtFsPath, cfg.get<string[]>('embedIgnore', []))) {
            dropped++;
            return;
        }
        pending.add(ipmtFsPath);
        if (flush) clearTimeout(flush);
        flush = setTimeout(() => {
            flush = undefined;
            const batch = [...pending];
            pending.clear();
            if (dropped > 0) {
                log.appendLine(`[embed] ignored ${dropped} .ipmt change(s) under generated/temp trees`);
                dropped = 0;
            }
            void reembedMarkdownIncluding(client, batch, log);
        }, Math.max(IPMT_REFRESH_DEBOUNCE_MS, IPMT_BURST_QUIET_MS));
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
//
// Takes the whole BURST of changed .ipmt paths and scans once: one findFiles
// per repo the burst touched, one read per markdown, matched against every
// basename in the burst. Per-file scanning is what stalled the extension host
// when a generator wrote thousands of .ipmt at once.
async function reembedMarkdownIncluding(
    client: LanguageClient,
    ipmtFsPaths: string[],
    log: vscode.OutputChannel,
): Promise<void> {
    if (ipmtFsPaths.length === 0) return;
    const basenames = ipmtFsPaths.map((p) => path.basename(p));
    const label = basenames.length === 1 ? basenames[0] : `${basenames.length} .ipmt files`;

    // Group by repo so a burst spanning two checkouts scans each once.
    const bases = new Map<string, vscode.Uri | undefined>();
    for (const p of ipmtFsPaths) {
        const u = vscode.Uri.file(p);
        const base = findGitRepoRoot(u) ?? vscode.workspace.getWorkspaceFolder(u)?.uri;
        bases.set(base ? base.toString() : '', base);
    }
    const seen = new Set<string>();
    let candidates: vscode.Uri[] = [];
    for (const base of bases.values()) {
        const found = base
            ? await vscode.workspace.findFiles(new vscode.RelativePattern(base, '**/*.md'), '**/node_modules/**')
            : vscode.workspace.textDocuments
                .filter((d) => d.languageId === 'markdown' && d.uri.scheme === 'file')
                .map((d) => d.uri);
        for (const u of found) {
            if (!seen.has(u.toString())) {
                seen.add(u.toString());
                candidates.push(u);
            }
        }
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
        if (!basenames.some((b) => markdownIncludesIpmt(text, b))) continue;
        await runIpmEmbed(client, md, log);
        refreshed++;
    }

    if (refreshed === 0) {
        log.appendLine(`[embed] ${label} changed — no dependent markdown to refresh`);
        return;
    }
    log.appendLine(`[embed] ${label} changed — re-embedded ${refreshed} dependent markdown file(s)`);
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
