# Contributing

Issues and pull requests are welcome at
<https://github.com/infinite-pm/vscode-ipm>.

## Development setup

See the [Development section of the README](README.md#development) for the
full command list. The short version:

- Clone [ipm-tools](https://github.com/infinite-pm/ipm-tools) **next to this
  repo** (`../ipm-tools`) — the palette codegen reads its source of truth
  from there, and `ipm-rpc` (the LSP server) is built from it.
- `npm install`, then `npm run build`.
- `npm test` runs the unit tests (plus the palette drift check). Please make
  sure it passes before sending a PR.
- Press `F5` in VS Code to try your changes in a development host.
