// Tests for the LSP-server binary resolution. We stub the vscode module
// before importing serverPath so the module under test loads outside a
// VS Code host.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import Module from 'node:module';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const stubVscode = {
    workspace: {
        getConfiguration: () => ({ get: (_k: string, def: unknown) => def }),
    },
    window: { createOutputChannel: () => ({ appendLine() { /* noop */ } }) },
};

const moduleAny = Module as unknown as { _resolveFilename: (...args: unknown[]) => string };
const origResolve = moduleAny._resolveFilename;
moduleAny._resolveFilename = function (this: unknown, request: string, ...rest: unknown[]) {
    if (request === 'vscode') {
        return '__ipm_vscode_stub__';
    }
    return origResolve.call(this, request, ...rest);
};
(require as unknown as { cache: Record<string, unknown> }).cache['__ipm_vscode_stub__'] = {
    id: '__ipm_vscode_stub__',
    filename: '__ipm_vscode_stub__',
    loaded: true,
    exports: stubVscode,
    children: [],
    paths: [],
};

const { resolveServer } = require('../extension/serverPath') as
    typeof import('../extension/serverPath');

// resolveServer falls through to `findOnPath('ipm-rpc')` after the
// configured-path check fails. On a developer machine the user usually has
// the real binary on PATH (e.g. ~/go/bin/ipm-rpc), which would mask the
// bundled-fallback case the bundled-binary tests are trying to exercise.
// Park PATH on an empty tmpdir for the duration of the test file so the
// PATH lookup deterministically misses.
const origPath = process.env.PATH;
const isolatedPathDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-rpc-empty-path-'));
process.env.PATH = isolatedPathDir;

test.after(() => {
    moduleAny._resolveFilename = origResolve;
    process.env.PATH = origPath;
    try { fs.rmdirSync(isolatedPathDir); } catch { /* tmpdir cleanup is best-effort */ }
});

// fakeExtensionContext returns a minimal vscode.ExtensionContext shaped
// object that resolveServer / bundledBinaryPath need.
function fakeContext(extensionPath: string): any {
    return { extensionPath };
}

test('resolveServer returns nothing when no binary is available', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-rpc-test-'));
    // Empty extension directory; no bin/ subtree.
    const out = resolveServer(fakeContext(tmp), fakeLog());
    assert.equal(out, undefined);
});

test('resolveServer finds a bundled binary when one exists for this platform', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-rpc-test-'));
    const arch =
        process.arch === 'x64'   ? 'amd64' :
        process.arch === 'arm64' ? 'arm64' :
        process.arch === 'arm'   ? 'arm'   : null;
    const platform =
        process.platform === 'darwin' ? 'darwin' :
        process.platform === 'linux'  ? 'linux'  :
        process.platform === 'win32'  ? 'windows' : null;
    if (!platform || !arch) {
        // Unsupported test platform — skip.
        return;
    }
    const ext = platform === 'windows' ? '.exe' : '';
    const binDir = path.join(tmp, 'bin', `${platform}-${arch}`);
    fs.mkdirSync(binDir, { recursive: true });
    const binPath = path.join(binDir, `ipm-rpc${ext}`);
    fs.writeFileSync(binPath, '#!/bin/sh\necho ipm-rpc fake\n');
    fs.chmodSync(binPath, 0o755);

    const out = resolveServer(fakeContext(tmp), fakeLog());
    assert.ok(out, 'expected resolveServer to find the bundled binary');
    assert.equal(out!.command, binPath);
});

function fakeLog() {
    return { appendLine() { /* discard */ } } as any;
}
