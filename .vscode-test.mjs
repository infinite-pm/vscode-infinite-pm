// Extension-host tests: the layer that needs a real VS Code.
//
// Everything provable without one lives in `npm test` (158 assertions, under a
// second). What is left here is what genuinely needs an extension host —
// command registration, tab state, the clipboard, diagnostics arriving from a
// real server over a real LSP connection, files appearing on disk.
//
//   npm run test:e2e            # downloads a VS Code on first run
//   npm run test:e2e -- --label commands
//
// That opens real VS Code windows on your display. To run it the way CI does —
// headless, no windows, no X server needed on the host — `make e2e` in the
// sibling vscode-infinite-pm-dev checkout runs this same suite inside the
// recording image, which already carries Xvfb.
//
// Specs are plain JavaScript on purpose. They run inside VS Code's own Node,
// mocha-style, and adding a TypeScript build step for a dozen files would buy
// types at the cost of a second compile pipeline that can rot independently.
//
// The bundled server is used as-is: resolveServer falls back to
// bin/<os>-<arch>/ipm-rpc, which `make vscode-pkg` (or CI's cross-build) puts
// there. No ipm.serverPath, so the test exercises the same resolution order a
// user gets.
import { defineConfig } from '@vscode/test-cli';

export default defineConfig({
    label: 'e2e',
    files: 'test-e2e/**/*.test.js',
    workspaceFolder: './test-e2e/fixtures/workspace',
    version: 'stable',
    mocha: {
        ui: 'tdd',            // suite()/test(), as VS Code's own samples use
        timeout: 30_000,          // a cold server start on a loaded CI runner
        slow: 5_000,
        retries: 0,               // a retried assertion is a flake we did not fix
    },
    launchArgs: [
        '--disable-extensions',   // ours is loaded by the harness regardless
    ],
});
