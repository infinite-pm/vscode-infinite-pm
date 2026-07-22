# Changelog

## 0.4.1

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
- Diagnostics in the Problems panel (parse errors + IPMV* validation
  findings) and hover documentation for kind markers and arrows.
- Embed-on-save: saving a `.md` file with ipmt blocks refreshes its
  committed SVGs under `_ipm/` and their marker hashes (`ipm.embed`).
- Live SVG refresh as you type: in-memory renders via `ipm.embedBuffer`
  swap the preview images to `data:` URLs until the next save; the preview
  recovers automatically if `ipm-rpc` dies mid-refresh.
- `.ipmt` preview pane with pan + zoom (in-place and to-the-side), plus
  Copy Path / Copy Relative Path / Reveal in Explorer on the preview.
- Force re-embed commands: current file, whole workspace, current repo.
- `ipm-rpc` resolution order `ipm.serverPath` → `PATH` → bundled
  per-platform binary, with LSP auto-restart when the binary changes.
