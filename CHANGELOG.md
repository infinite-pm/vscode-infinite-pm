# Changelog

## Unreleased

- The Marketplace icon is the infinite.pm mark, generated from the project's
  logo set, instead of the placeholder drawn during release setup.
- The Marketplace summary leads with the infinite.pm project name.
- The bundled `ipm-rpc` reports its release version again. Releases pin
  ipm-tools by resolved SHA, and a shallow tagless checkout left Go with no tag
  to stamp, so `ipm-rpc --version` (and "Show Server Info") showed a
  `v0.0.0-<time>-<sha>` pseudo-version instead of the tag it was built from.

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
