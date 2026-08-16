# Contributing

Issues and pull requests are welcome at
<https://github.com/infinite-pm/vscode-infinite-pm>.

## Development setup

See the [Development section of the README](README.md#development) for the
full command list. The short version:

- Clone [ipm-tools](https://github.com/infinite-pm/ipm-tools) **next to this
  repo** (`../ipm-tools`) — the palette codegen reads its source of truth
  from there, and `ipm-rpc` (the LSP server) is built from it.
- `npm install`, then `npm run build`.
- `npm test` runs the unit tests (plus the palette drift check). Please make
  sure it passes before sending a PR. Under a second, no VS Code involved.
- `npm run test:e2e` runs the extension-host suite: a real VS Code, a real
  extension host, the real bundled `ipm-rpc`. It downloads a VS Code on first
  run (into `.vscode-test/`, gitignored) and needs a display — on a headless
  box, `xvfb-run -a npm run test:e2e`. Specs live in `test-e2e/` as plain
  JavaScript and run mocha-style inside the host.
  - Real VS Code windows open and take focus for the duration. To run it
    without that, `make e2e` in a `../vscode-infinite-pm-dev` checkout runs the
    same suite inside the recording container, which carries its own Xvfb.
  - It needs the server bundled where the packaged extension keeps it:
    `make vscode-pkg` from `../ipm-drawio`, or
    `go build -C ../ipm-tools -o bin/linux-amd64/ipm-rpc ./cmd/ipm-rpc`.
  - CI runs it on merges to main and nightly, not on PRs — see
    `.github/workflows/e2e.yml` for why.
- New test? Put it at the cheapest layer that can honestly prove the thing.
  Most of what looks like it needs a host does not: `src/__tests__` covers the
  renderer, the caches, the settings and the manifest with a stubbed `vscode`.
- Press `F5` in VS Code to try your changes in an Extension Development Host
  (build first, or keep `npm run watch` running).

## Releasing

Tag-driven, and the one-time marketplace setup is the interesting part:
[RELEASING.md](RELEASING.md).
