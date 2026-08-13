// `.ipmt` preview pane.
//
// Webview-backed view that renders the current `.ipmt` buffer as an
// SVG. Mirrors the markdown-language-features preview UX (Open Preview
// / Open Preview to the Side icons, side-by-side layout, debounced
// re-render on edit), but the SVG NEVER touches disk — every render
// goes through `ipm.embedBuffer` which holds the bytes in memory.
//
// The webview also provides pan (translate) and crisp zoom: the SVG
// element is RESIZED per step rather than CSS-scaled, so vectors stay
// sharp, with a zoom indicator shown while zoomed and view state kept
// across debounced re-renders.

import * as path from 'path';
import * as vscode from 'vscode';
import { LanguageClient } from 'vscode-languageclient/node';

interface EmbedBufferBlock {
    index: number;
    id: string;
    hash: string;
    source?: string;
    svgBase64?: string;
    outcome: string;
    error?: string;
}

interface EmbedBufferResult {
    uri: string;
    blocks: EmbedBufferBlock[];
}

// Number of attempts when the server returns "document not open" —
// vscode-languageclient sends didOpen for already-open docs
// asynchronously after client.start() resolves, so an immediate call
// from a command click can race the notification.
const NOT_OPEN_RETRIES = 6;
const NOT_OPEN_DELAY_MS = 200;

// One webview per source URI. Re-issuing the open command for a doc
// that already has a preview focuses the existing panel instead of
// opening a duplicate (matches markdown-preview behavior).
const panels = new Map<string, vscode.WebviewPanel>();

// Per-panel debounce timer keyed on the source doc URI.
const debouncers = new Map<string, NodeJS.Timeout>();

// Latest "good" SVG per source URI. On a parse error mid-edit we keep
// showing the previous render rather than blanking the panel.
const lastGoodSvg = new Map<string, string>();

let logFn: ((line: string) => void) | undefined;

export function setIpmtPreviewLog(fn: ((line: string) => void) | undefined): void {
    logFn = fn;
}

function log(line: string): void {
    if (logFn) logFn(line);
}

// openIpmtPreview opens (or focuses) a preview panel for the active
// `.ipmt` editor.
//
//   viewColumn = ViewColumn.Beside → side-by-side variant. Source tab
//                                    stays open; preview goes in a new
//                                    column to the right.
//   viewColumn = ViewColumn.Active → in-place toggle. Preview opens in
//                                    the source's column; the source
//                                    text editor tab is closed so the
//                                    preview visually REPLACES it
//                                    (matches the user expectation
//                                    "open in current editor, not new").
export async function openIpmtPreview(
    ctx: vscode.ExtensionContext,
    client: LanguageClient | undefined,
    viewColumn: vscode.ViewColumn,
): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.languageId !== 'ipmt') {
        void vscode.window.showInformationMessage(
            'infinite.pm: open a .ipmt file first to use the preview.',
        );
        return;
    }
    const doc = editor.document;
    const uriStr = doc.uri.toString();
    const inPlace = viewColumn === vscode.ViewColumn.Active;
    const sourceColumn = editor.viewColumn ?? vscode.ViewColumn.Active;

    // Already open → focus it. (Even in-place we don't re-create.)
    const existing = panels.get(uriStr);
    if (existing) {
        existing.reveal(viewColumn, /*preserveFocus*/ false);
        if (inPlace) {
            await closeSourceTabFor(doc.uri, sourceColumn);
        }
        return;
    }

    // Fetch the initial SVG BEFORE creating the webview, so it can be
    // baked into the page's initial HTML. Going via postMessage races
    // with the webview's script load AND with the editor's column-layout
    // settling (most visible in side-by-side mode, where the new column
    // is mid-resize when the message would have arrived). Inlining
    // sidesteps both: the first paint already has the SVG, CSS
    // `width: 100%` follows the column from frame one.
    const initial = client
        ? await fetchInitialRender(client, doc)
        : { kind: 'error' as const, text: 'ipm-rpc not running. Install it from ipm-tools and reload.' };
    if (initial.kind === 'svg') {
        lastGoodSvg.set(uriStr, initial.svgHtml);
    }

    // Tab title is just the basename. Newer VS Code dropped the legacy
    // `Preview ` prefix from markdown's preview tab — the webview iconPath
    // signals "this is a preview" on its own.
    const tabTitle = path.basename(doc.uri.fsPath);
    const panel = vscode.window.createWebviewPanel(
        'ipmtPreview',
        tabTitle,
        { viewColumn, preserveFocus: false },
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(ctx.extensionUri, 'media')],
        },
    );
    // Tab icon. Mirrors markdown-language-features' webview.iconPath
    // wiring, down to using the same artwork it ships for its own preview
    // tab — `preview-{light,dark}.svg`. The title-bar buttons use codicons
    // instead ($(open-preview) / $(preview)), as markdown's do.
    panel.iconPath = {
        light: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-light.svg'),
        dark: vscode.Uri.joinPath(ctx.extensionUri, 'media', 'preview-dark.svg'),
    };
    panel.webview.html = buildHtml(panel.webview, initial);
    panels.set(uriStr, panel);

    panel.onDidDispose(() => {
        panels.delete(uriStr);
        lastGoodSvg.delete(uriStr);
        const t = debouncers.get(uriStr);
        if (t) {
            clearTimeout(t);
            debouncers.delete(uriStr);
        }
    }, null, ctx.subscriptions);

    // In-place toggle: close the source tab AFTER the preview is up so
    // the column is left with exactly one tab — the preview.
    if (inPlace) {
        await closeSourceTabFor(doc.uri, sourceColumn);
    }
}

// closeSourceTabFor closes the text-editor tab for `uri` in
// `viewColumn`. Used by the in-place preview toggle: after the
// preview's webview is created in the same column, we close the
// source tab so the user sees exactly one tab (the preview) — matching
// the "Open Preview" UX VS Code Insiders shows for markdown.
async function closeSourceTabFor(uri: vscode.Uri, viewColumn: vscode.ViewColumn): Promise<void> {
    const uriStr = uri.toString();
    for (const group of vscode.window.tabGroups.all) {
        if (group.viewColumn !== viewColumn) continue;
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputText && input.uri.toString() === uriStr) {
                try {
                    await vscode.window.tabGroups.close(tab);
                } catch (err) {
                    log(`[ipmt-preview] closeSourceTabFor failed: ${err}`);
                }
                return;
            }
        }
    }
}

// onIpmtChange is wired to onDidChangeTextDocument. For a `.ipmt`
// document with a live preview, schedules a debounced re-render.
export function onIpmtChange(
    client: LanguageClient | undefined,
    doc: vscode.TextDocument,
): void {
    if (!client) return;
    if (doc.languageId !== 'ipmt') return;
    const uriStr = doc.uri.toString();
    const panel = panels.get(uriStr);
    if (!panel) return;

    const cfg = vscode.workspace.getConfiguration('ipm');
    const delay = Math.max(0, cfg.get<number>('liveRefreshDebounceMs', 300));
    const prev = debouncers.get(uriStr);
    if (prev) clearTimeout(prev);
    debouncers.set(uriStr, setTimeout(async () => {
        debouncers.delete(uriStr);
        // Always render even if the panel isn't currently visible — the user
        // might bring it forward and we want it already up to date.
        await renderOnce(client, doc, panel);
    }, delay));
}

// onIpmtClose drops the panel + caches when the source document is
// closed. We DON'T auto-close the panel — matching markdown preview's
// behavior — but we stop scheduling renders against a detached doc.
export function onIpmtClose(doc: vscode.TextDocument): void {
    if (doc.languageId !== 'ipmt') return;
    const uriStr = doc.uri.toString();
    const t = debouncers.get(uriStr);
    if (t) {
        clearTimeout(t);
        debouncers.delete(uriStr);
    }
}

// showSource flips from the active `.ipmt` preview webview back to
// its source text document. Wired to the `infinite.pm.showSource`
// command, gated by `activeWebviewPanelId == 'ipmtPreview'` so the
// editor title icon only appears when a preview is focused.
//
// Toggle behavior: opens the source in the SAME view column as the
// preview, then closes the preview's tab — leaving exactly one tab
// in that column (the source). Mirrors the in-place "Open Preview"
// direction so the two icons act as a true toggle.
export async function showSource(): Promise<void> {
    for (const [uriStr, panel] of panels.entries()) {
        if (!panel.active) continue;
        const targetColumn = panel.viewColumn ?? vscode.ViewColumn.Active;
        try {
            const uri = vscode.Uri.parse(uriStr);
            const doc = await vscode.workspace.openTextDocument(uri);
            // `preview: false` pins the resulting tab — without it,
            // showTextDocument opens in preview mode (italic title)
            // and the next click in the explorer would replace the
            // tab. Matches the user expectation that returning from
            // a preview behaves like opening a regular source file.
            await vscode.window.showTextDocument(doc, {
                viewColumn: targetColumn,
                preserveFocus: false,
                preview: false,
            });
            // After focusing the source, close the preview tab so we
            // end up with one tab in the column (the source).
            await closePreviewTabFor(uriStr, targetColumn);
        } catch (err) {
            log(`[ipmt-preview] showSource failed for ${uriStr}: ${err}`);
        }
        return;
    }
    void vscode.window.showInformationMessage(
        'infinite.pm: no active .ipmt preview to switch source from.',
    );
}

// closePreviewTabFor closes the webview tab that holds the .ipmt
// preview for `uriStr` in the given view column.
async function closePreviewTabFor(uriStr: string, viewColumn: vscode.ViewColumn): Promise<void> {
    for (const group of vscode.window.tabGroups.all) {
        if (group.viewColumn !== viewColumn) continue;
        for (const tab of group.tabs) {
            const input = tab.input;
            if (input instanceof vscode.TabInputWebview && input.viewType.endsWith('ipmtPreview')) {
                // Only close the preview that matches our source URI.
                // The panel reference is the most reliable matcher.
                const panel = panels.get(uriStr);
                if (panel && tab.label === panel.title) {
                    try {
                        await vscode.window.tabGroups.close(tab);
                    } catch (err) {
                        log(`[ipmt-preview] closePreviewTabFor failed: ${err}`);
                    }
                    return;
                }
            }
        }
    }
}

// activePreviewSourceUri returns the source .ipmt URI of the currently
// focused preview panel, or undefined when no preview is active. Used by
// the Copy Path / Copy Relative Path commands, which run from the
// preview's title menu / tab context menu (where there is no underlying
// text editor resource to copy from).
export function activePreviewSourceUri(): vscode.Uri | undefined {
    for (const [uriStr, panel] of panels.entries()) {
        if (panel.active) {
            return vscode.Uri.parse(uriStr);
        }
    }
    return undefined;
}

// copyActivePreviewPath copies the active .ipmt preview's source path to
// the clipboard — absolute (relative=false) or workspace-relative
// (relative=true), matching VS Code's built-in "Copy Path" / "Copy
// Relative Path" which webview previews don't otherwise get (the preview
// tab has no file resource behind it).
export async function copyActivePreviewPath(relative: boolean): Promise<void> {
    const uri = activePreviewSourceUri();
    if (!uri) {
        void vscode.window.showInformationMessage(
            'infinite.pm: no active .ipmt preview to copy the path from.',
        );
        return;
    }
    const text = relative
        ? vscode.workspace.asRelativePath(uri, false)
        : uri.fsPath;
    await vscode.env.clipboard.writeText(text);
    log(`[ipmt-preview] copied ${relative ? 'relative ' : ''}path: ${text}`);
}

// revealActivePreviewInExplorer reveals the active .ipmt preview's source
// file in the Explorer view. Delegates to VS Code's built-in
// `revealInExplorer`, passing the source URI explicitly — the built-in
// can't infer it from a webview preview (which has no active-editor
// resource).
export async function revealActivePreviewInExplorer(): Promise<void> {
    const uri = activePreviewSourceUri();
    if (!uri) {
        void vscode.window.showInformationMessage(
            'infinite.pm: no active .ipmt preview to reveal.',
        );
        return;
    }
    await vscode.commands.executeCommand('revealInExplorer', uri);
}

// disposeAllIpmtPreviews tears down every panel + cache. Called on
// extension restart.
export function disposeAllIpmtPreviews(): void {
    for (const p of panels.values()) {
        try { p.dispose(); } catch { /* ignore */ }
    }
    panels.clear();
    for (const t of debouncers.values()) clearTimeout(t);
    debouncers.clear();
    lastGoodSvg.clear();
}

// InitialRender describes what to bake into the webview's first paint:
// a ready SVG, an empty-file note, an error to display, or the
// last-good SVG with a parse-error banner overlaid.
type InitialRender =
    | { kind: 'svg'; svgHtml: string }
    | { kind: 'svg+error'; svgHtml: string; error: string }
    | { kind: 'wait'; text: string }
    | { kind: 'error'; text: string };

// fetchInitialRender computes what the panel should show on first
// paint. Used by openIpmtPreview to bake the result into the initial
// HTML — no postMessage race, no JS DOM scrub needed for the first
// render. (Subsequent edits still go through postMessage.)
async function fetchInitialRender(
    client: LanguageClient,
    doc: vscode.TextDocument,
): Promise<InitialRender> {
    const uriStr = doc.uri.toString();
    const result = await callEmbedBuffer(client, uriStr);
    if (result.kind === 'err') {
        return { kind: 'error', text: String(result.err) };
    }
    const res = result.res;
    if (!res || !res.blocks || res.blocks.length === 0) {
        return { kind: 'wait', text: '(empty .ipmt file)' };
    }
    const block = res.blocks[0];
    if (!block.svgBase64) {
        return { kind: 'error', text: block.error ?? 'parse error' };
    }
    const svgHtml = stripSvgFixedDims(Buffer.from(block.svgBase64, 'base64').toString('utf8'));
    return { kind: 'svg', svgHtml };
}

// renderOnce calls ipm.embedBuffer once for a `.ipmt` doc and forwards
// the SVG to the webview. Handles the "document not open" race by
// retrying with backoff, and falls back to the last-good render on
// transient parse errors.
async function renderOnce(
    client: LanguageClient,
    doc: vscode.TextDocument,
    panel: vscode.WebviewPanel,
): Promise<void> {
    const uriStr = doc.uri.toString();
    const result = await callEmbedBuffer(client, uriStr);
    if (result.kind === 'err') {
        log(`[ipmt-preview] embedBuffer failed for ${uriStr}: ${result.err}`);
        panel.webview.postMessage({ kind: 'error', text: String(result.err) });
        return;
    }
    const res = result.res;
    if (!res || !res.blocks || res.blocks.length === 0) {
        // Empty buffer → blank slate, not an error.
        panel.webview.postMessage({ kind: 'wait', text: '(empty .ipmt file)' });
        return;
    }
    const block = res.blocks[0];
    if (!block.svgBase64) {
        // Parse error mid-edit — keep showing the previous good SVG
        // but post the error so the webview can show a banner.
        const prev = lastGoodSvg.get(uriStr);
        if (prev) {
            panel.webview.postMessage({
                kind: 'svg+error',
                svgHtml: prev,
                error: block.error ?? 'parse error',
            });
        } else {
            panel.webview.postMessage({
                kind: 'error',
                text: block.error ?? 'parse error',
            });
        }
        return;
    }
    const svgHtml = stripSvgFixedDims(Buffer.from(block.svgBase64, 'base64').toString('utf8'));
    lastGoodSvg.set(uriStr, svgHtml);
    panel.webview.postMessage({ kind: 'svg', svgHtml });
}

// callEmbedBuffer wraps the LSP call with the "document not open in
// server" retry loop (vscode-languageclient sends didOpen
// asynchronously after client.start() resolves, so an immediate call
// from a command click can race the notification).
async function callEmbedBuffer(
    client: LanguageClient,
    uriStr: string,
): Promise<{ kind: 'ok'; res: EmbedBufferResult | null } | { kind: 'err'; err: unknown }> {
    let lastErr: unknown = undefined;
    for (let attempt = 0; attempt <= NOT_OPEN_RETRIES; attempt++) {
        try {
            const res = await client.sendRequest<EmbedBufferResult | null>(
                'workspace/executeCommand',
                {
                    command: 'ipm.embedBuffer',
                    arguments: [{ uri: uriStr }],
                },
            );
            return { kind: 'ok', res };
        } catch (err) {
            lastErr = err;
            const msg = String(err);
            if (!msg.includes('document not open in server')) break;
            if (attempt < NOT_OPEN_RETRIES) {
                await new Promise(r => setTimeout(r, NOT_OPEN_DELAY_MS));
            }
        }
    }
    return { kind: 'err', err: lastErr };
}

// stripSvgFixedDims removes the `width="…"` and `height="…"` attributes
// from the root <svg> element so CSS `width: 100%` can actually scale
// the drawing — otherwise browsers treat those attributes as intrinsic
// dimensions, `height: auto` keeps the (wrong) intrinsic height, and
// the viewBox content scales to fit width×height with
// `preserveAspectRatio="xMidYMid meet"` (content centered with empty
// margins on each side, which is what the user reports).
//
// We do this server-side AND in the webview JS (defense in depth):
// if the JS DOM scrub somehow doesn't run, the SVG still arrives sized
// correctly.
function stripSvgFixedDims(svgHtml: string): string {
    return svgHtml
        .replace(/(<svg[^>]*?)\s+width="[^"]*"/i, '$1')
        .replace(/(<svg[^>]*?)\s+height="[^"]*"/i, '$1');
}

function buildHtml(webview: vscode.Webview, initial: InitialRender): string {
    const nonce = randomNonce();
    const csp = [
        `default-src 'none'`,
        `style-src 'unsafe-inline'`,
        // SVGs may inline <image href="data:..."> for embedded raster bits.
        `img-src ${webview.cspSource} data:`,
        `script-src 'nonce-${nonce}'`,
    ].join('; ');
    // Bake the initial render directly into the HTML — first paint
    // already has the SVG, so CSS sizing applies from frame one and
    // there is no postMessage timing window to lose against.
    let initialBanner = '';
    let initialBody = '';
    if (initial.kind === 'svg') {
        initialBody = `<div class="svg-host">${initial.svgHtml}</div>`;
    } else if (initial.kind === 'svg+error') {
        initialBanner = `<div class="error">${escapeHtml(initial.error)}</div>`;
        initialBody = `<div class="svg-host">${initial.svgHtml}</div>`;
    } else if (initial.kind === 'error') {
        initialBanner = `<div class="error">${escapeHtml(initial.text)}</div>`;
    } else {
        initialBody = `<div class="status">${escapeHtml(initial.text)}</div>`;
    }
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <title>ipmt preview</title>
  <style>
    html, body { height: 100%; width: 100%; overflow: hidden; }
    body {
      background: var(--vscode-editor-background);
      color: var(--vscode-editor-foreground);
      font-family: var(--vscode-editor-font-family, monospace);
      margin: 0;
      padding: 0;
      box-sizing: border-box;
    }
    /* Banner floats over the diagram so it never steals layout height —
     * the diagram is always free to fill the viewport for zoom/pan. */
    #error-banner {
      position: absolute;
      top: 0; left: 0; right: 0;
      padding: 4px;
      z-index: 10;
      pointer-events: none;
    }
    #error-banner .error {
      pointer-events: auto;
      color: var(--vscode-errorForeground, #f48771);
      background: var(--vscode-editor-background);
      border: 1px solid currentColor;
      padding: 6px 10px;
      border-radius: 3px;
      white-space: pre-wrap;
    }
    #root {
      position: relative;
      width: 100%; height: 100%;
      overflow: hidden;
    }
    .status {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
      padding: 6px 10px;
    }
    /* The .svg-host wraps the rendered SVG. Pan is done with
     * "transform: translate" (no rasterization). Zoom is done by RESIZING
     * the inner <svg> element itself — that forces the browser to
     * re-rasterize vectors at the new size, which keeps lines crisp at
     * any zoom level. (CSS "scale()" promotes the element to its own
     * compositor layer and stretches the cached bitmap, which is what
     * makes scaled SVG look blurry.) */
    .svg-host {
      position: absolute;
      top: 0;
      left: 0;
      cursor: zoom-in;
      user-select: none;
    }
    .svg-host.zoomed  { cursor: grab; }
    .svg-host.dragging { cursor: grabbing; }
    .svg-host svg {
      display: block;
      /* width/height are set in px by the JS apply() — do NOT use % here,
       * or the SVG would size to the host and the host already follows the
       * SVG, creating a circular layout dependency. */
      /* Mouse events go to .svg-host so pan-drag works anywhere on the
       * diagram, not just on empty pixels. */
      pointer-events: none;
    }
    /* Bottom-right zoom indicator — mirrors VS Code's image-preview
     * status-bar zoom %. Click resets to 100%. */
    #zoom-overlay {
      position: fixed;
      right: 8px;
      bottom: 8px;
      z-index: 20;
      background: rgba(0, 0, 0, 0.55);
      color: #fff;
      padding: 2px 8px;
      border-radius: 3px;
      font-size: 11px;
      font-family: var(--vscode-editor-font-family, monospace);
      cursor: pointer;
      user-select: none;
      display: none;
    }
    #zoom-overlay:hover { opacity: 0.85; }
  </style>
</head>
<body>
  <div id="root">${initialBody}</div>
  <div id="error-banner">${initialBanner}</div>
  <div id="zoom-overlay" title="Click to reset zoom (Ctrl+0)">100%</div>
  <script nonce="${nonce}">
    const root = document.getElementById('root');
    const banner = document.getElementById('error-banner');
    const overlay = document.getElementById('zoom-overlay');

    function setBanner(text) {
      if (!text) { banner.innerHTML = ''; return; }
      const div = document.createElement('div');
      div.className = 'error';
      div.textContent = text;
      banner.innerHTML = '';
      banner.appendChild(div);
    }

    // Tighten the SVG to its actual visible content. The pkg/ipmsvg
    // renderer emits viewBox="0 0 \${Bounds.W} \${Bounds.H}" using the
    // layout's full bounds, which can include large unused margins.
    // getBBox() returns the union of all rendered geometry → tight
    // viewBox → diagram fills the host without empty bands.
    function fitSvg() {
      const svg = root.querySelector('svg');
      if (!svg) return;
      svg.removeAttribute('width');
      svg.removeAttribute('height');
      try {
        const bbox = svg.getBBox();
        if (bbox && bbox.width > 0 && bbox.height > 0) {
          const pad = 8;
          const vb = (bbox.x - pad) + ' ' + (bbox.y - pad) + ' ' +
                     (bbox.width + pad * 2) + ' ' + (bbox.height + pad * 2);
          svg.setAttribute('viewBox', vb);
        }
      } catch (e) { /* getBBox on detached SVG */ }
    }

    // Pan + zoom state, preserved across edits (re-renders) so the user's
    // current view persists while typing. Reset only on explicit user
    // action (Ctrl+0 or overlay click).
    //
    // baseW / baseH are the SVG's "fit" dimensions (its CSS size at
    // scale=1, computed from the viewBox and the viewport). At zoom s,
    // the SVG's CSS width/height = baseW*s, baseH*s. We resize the SVG
    // ELEMENT (not CSS transform: scale) so the browser re-rasterizes
    // the vectors at the new size — keeps lines crisp at any zoom.
    let scale = 1, tx = 0, ty = 0;
    let baseW = 0, baseH = 0;
    let dragStart = null;
    let dragMoved = false;
    let isFirstFit = true;
    const STEP = 1.25;
    const MIN_SCALE = 0.1, MAX_SCALE = 30;

    function host() { return root.querySelector('.svg-host'); }
    function svgEl() { return root.querySelector('svg'); }

    // Compute baseW/baseH from the SVG's viewBox fitted to the viewport.
    // Returns false if there's no usable SVG (so callers can skip apply).
    function computeBase() {
      const s = svgEl();
      if (!s || !s.viewBox || !s.viewBox.baseVal) { baseW = baseH = 0; return false; }
      const vb = s.viewBox.baseVal;
      if (vb.width <= 0 || vb.height <= 0) { baseW = baseH = 0; return false; }
      const r = root.getBoundingClientRect();
      if (r.width <= 0 || r.height <= 0) { baseW = baseH = 0; return false; }
      const fitS = Math.min(r.width / vb.width, r.height / vb.height);
      baseW = vb.width * fitS;
      baseH = vb.height * fitS;
      return true;
    }

    function recenter() {
      const r = root.getBoundingClientRect();
      tx = (r.width - baseW * scale) / 2;
      ty = (r.height - baseH * scale) / 2;
    }

    function apply() {
      const h = host();
      const s = svgEl();
      if (!h || !s || baseW <= 0) return;
      // Resize the SVG ELEMENT itself — forces vector re-rasterization
      // at the new size on every zoom step. (CSS transform: scale would
      // promote to a compositor layer and stretch the cached bitmap.)
      s.style.width = (baseW * scale) + 'px';
      s.style.height = (baseH * scale) + 'px';
      // Pan with translate only — no scale, no rasterization.
      h.style.transform = 'translate(' + tx + 'px, ' + ty + 'px)';
      const isZoomed = Math.abs(scale - 1) > 0.005;
      h.classList.toggle('zoomed', isZoomed);
      overlay.style.display = isZoomed ? 'block' : 'none';
      overlay.textContent = Math.round(scale * 100) + '%';
    }
    function zoomAt(newScale, cx, cy) {
      newScale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, newScale));
      if (Math.abs(newScale - scale) < 1e-6) return;
      // Keep (cx, cy) — the local cursor point — fixed across the zoom:
      // tx' = cx + (tx - cx) * (newScale / scale)  (same for ty).
      const ratio = newScale / scale;
      tx = cx + (tx - cx) * ratio;
      ty = cy + (ty - cy) * ratio;
      scale = newScale;
      apply();
    }
    function reset() { scale = 1; recenter(); apply(); }

    // onNewSvg: called after the .svg-host is (re)populated. Fits the
    // viewBox, computes base dimensions, centers on the FIRST render
    // only; subsequent renders preserve the user's view (scale + pan).
    function onNewSvg() {
      fitSvg();
      if (!computeBase()) return;
      if (isFirstFit) {
        isFirstFit = false;
        recenter();
      }
      apply();
    }
    function viewCenter() {
      const r = root.getBoundingClientRect();
      return [r.width / 2, r.height / 2];
    }
    function rootLocal(e) {
      const r = root.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    }

    // Mouse wheel = smooth zoom centered on cursor.
    root.addEventListener('wheel', (e) => {
      e.preventDefault();
      const [cx, cy] = rootLocal(e);
      const factor = Math.exp(-e.deltaY * 0.0015);
      zoomAt(scale * factor, cx, cy);
    }, { passive: false });

    // Ctrl/Cmd + = / - / 0 keyboard shortcuts (matches VS Code image preview).
    document.addEventListener('keydown', (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      if (e.key === '=' || e.key === '+') {
        e.preventDefault();
        const [cx, cy] = viewCenter();
        zoomAt(scale * STEP, cx, cy);
      } else if (e.key === '-' || e.key === '_') {
        e.preventDefault();
        const [cx, cy] = viewCenter();
        zoomAt(scale / STEP, cx, cy);
      } else if (e.key === '0') {
        e.preventDefault();
        reset();
      }
    });

    // mousedown/move/up: distinguish drag (pan) from click (step zoom).
    // Threshold = a few pixels of movement before classifying as a drag,
    // so a steady click still zooms.
    root.addEventListener('mousedown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      dragStart = { x: e.clientX, y: e.clientY, tx, ty };
      dragMoved = false;
      const h = host();
      if (h) h.classList.add('dragging');
    });
    document.addEventListener('mousemove', (e) => {
      if (!dragStart) return;
      const dx = e.clientX - dragStart.x;
      const dy = e.clientY - dragStart.y;
      if (Math.abs(dx) > 3 || Math.abs(dy) > 3) dragMoved = true;
      if (dragMoved) {
        tx = dragStart.tx + dx;
        ty = dragStart.ty + dy;
        apply();
      }
    });
    document.addEventListener('mouseup', (e) => {
      if (!dragStart) return;
      const wasDrag = dragMoved;
      const h = host();
      if (h) h.classList.remove('dragging');
      dragStart = null;
      dragMoved = false;
      if (!wasDrag) {
        const [cx, cy] = rootLocal(e);
        if (e.shiftKey) zoomAt(scale / STEP, cx, cy);
        else zoomAt(scale * STEP, cx, cy);
      }
    });

    // Overlay click → reset. Stop propagation so it doesn't also trigger
    // a step-zoom via the document mouseup handler.
    overlay.addEventListener('mousedown', (e) => e.stopPropagation());
    overlay.addEventListener('click', (e) => { e.stopPropagation(); reset(); });

    // Initial render is baked into the HTML — fit + center on load.
    onNewSvg();

    // Viewport resize: recompute base dimensions so the diagram still
    // fits at the new size. Preserve scale and translation (the user
    // may have panned/zoomed); they can Ctrl+0 to recenter if needed.
    window.addEventListener('resize', () => {
      if (!computeBase()) return;
      apply();
    });

    window.addEventListener('message', (e) => {
      const m = e.data;
      if (m.kind === 'svg') {
        setBanner(null);
        root.innerHTML = '<div class="svg-host">' + m.svgHtml + '</div>';
        onNewSvg();
      } else if (m.kind === 'svg+error') {
        setBanner(m.error);
        root.innerHTML = '<div class="svg-host">' + m.svgHtml + '</div>';
        onNewSvg();
      } else if (m.kind === 'error') {
        setBanner(m.text);
        root.innerHTML = '';
        overlay.style.display = 'none';
      } else if (m.kind === 'wait') {
        setBanner(null);
        root.innerHTML = '<div class="status">' + m.text + '</div>';
        overlay.style.display = 'none';
      }
    });
  </script>
</body>
</html>`;
}

function escapeHtml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

function randomNonce(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let s = '';
    for (let i = 0; i < 32; i++) s += chars.charAt(Math.floor(Math.random() * chars.length));
    return s;
}
