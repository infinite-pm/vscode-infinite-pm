# Changelog

## 0.4.2 — unreleased

- `ipm-rpc --version` and the "Show Server Info" command report the bundled
  server's release version. 0.4.1 shipped a server that reported a
  `v0.0.0-<time>-<sha>` pseudo-version instead of the tag it was built from.
- A new extension icon: the infinite.pm logo, the mark over the project name.
- The Marketplace summary leads with the project name, and names diagnostics
  alongside ipmt language support and embed-on-save.
- The `.ipmt` editor title bar carries the same two preview buttons a Markdown
  editor does, wearing the same icons: "Open Preview to the Side"
  (`$(open-preview)`) and "Open as Preview" (`$(preview)`), the latter
  replacing the tab you are in. Both buttons were there before, but the second
  one wore preview-shaped artwork that looks like the first at 16px, so the
  pair read as one control duplicated.
- ipmt fences in the markdown preview stay colored while you type. Two
  things went wrong before: live-refresh used a resetting debounce, so typing
  without a 300 ms pause never refreshed anything, and tokens are looked up by
  exact block source, so each keystroke missed the cache and the whole block
  fell back to plain black text. Colors now refresh on every change through a
  `tokensOnly` server call that skips diagram layout (0.5–2 ms on a normal
  document), paced by a single-flight so a slow document simply refreshes less
  often instead of queueing calls. Diagrams keep the existing idle debounce —
  `ipm.liveRefreshDebounceMs` now describes that half only.
- That refresh rate limits itself rather than adding a setting to tune: each
  color refresh waits out a cooldown as long as the call that preceded it
  (capped at 250 ms), which holds the server's share of wall time near 50%
  whatever the machine. Measured while typing continuously: no change at all
  on a normal document or on a 95-block one, and 63% → 46% busy on a
  simulated slow machine with no loss of colored frames.
- The preview no longer forces a full webview reload on the typing path; it
  lets VS Code's own preview refresh pick the new tokens up.
- A slow in-flight render can no longer overwrite a newer diagram: responses
  for a superseded document revision are discarded.
- Saving a `.md` no longer blanks every ipmt block in the preview. The save
  path evicted the whole live cache including the semantic tokens, and nothing
  re-fired the server, so the blocks stayed uncolored until the next
  keystroke. It now evicts only the rendered SVGs, which is all the on-disk
  renders replace.
- Preview keybindings matching Markdown's: `Shift+Ctrl+V` (`Shift+Cmd+V`)
  opens the preview in place and `Ctrl+K V` (`Cmd+K V`) opens it to the side,
  both only while an `.ipmt` editor is focused.

## 0.4.1 — 2026-08-12

First public release.

- ipmt language support: syntax highlighting for `.ipmt` files and for
  ` ```ipmt ` fences inside Markdown — TextMate grammars for cold start,
  LSP semantic tokens (from the bundled `ipm-rpc` server) once connected.
  The editor pane and the markdown preview share the same Go-side
  tokenizer, so both paint identical colors.
- Semantic token palette generated from the source of truth in ipm-tools
  (`pkg/ipmtokens/palette.json`): 10 token types, 7 modifiers, drift check
  wired into build and test.
- Fence-meta aware highlighting: ` ```ipmt ` fences with meta tokens
  (`embed=false`, `unresolved`, `key=value`) are highlighted;
  ` ```ipmt-invalid ` fences are deliberately not.
- Inline ipmt highlighting in prose: an `<!--ipmt-->` (or
  `<!--ipmt:as-token:NAME-->`) marker before a backtick code span paints that
  span with the same token colors in the markdown preview.
- Diagnostics in the Problems panel (parse errors + IPMV* validation
  findings) and hover documentation for kind markers and arrows.
- Embed-on-save: saving a `.md` file with ipmt blocks refreshes its
  committed SVGs under `_ipm/` and their marker hashes (`ipm.embed`). Saving a
  shared `.ipmt` file re-embeds the markdown files that include it via
  `<!-- ipm-include -->`, scoped to its git repository.
- Live SVG refresh as you type: in-memory renders via `ipm.embedBuffer`
  swap the preview images to `data:` URLs until the next save; the preview
  recovers automatically if `ipm-rpc` dies mid-refresh.
- `.ipmt` preview pane with pan + zoom (in-place and to-the-side), plus
  Copy Path / Copy Relative Path / Reveal in Explorer on the preview.
- Force re-embed commands: current file, whole workspace, current repo.
- `ipm-rpc` resolution order `ipm.serverPath` → `PATH` → bundled
  per-platform binary, with LSP auto-restart when the binary changes.
  `ipm.serverPath` is `machine-overridable`, so a workspace cannot choose
  which executable gets spawned.
- A platform-specific `.vsix` for each of the nine targets VS Code resolves:
  linux x64/arm64/armhf, alpine x64/arm64, darwin x64/arm64 and win32
  x64/arm64. VS Code has no target-platform fallback, so an unbuilt platform
  would be uninstallable rather than degraded.
- Restricted workspaces are supported *limited*: highlighting works, but the
  server does not start and nothing is written to disk until the folder is
  trusted (the server then starts without a reload). Virtual workspaces are
  declared unsupported — the server is a local child process.
