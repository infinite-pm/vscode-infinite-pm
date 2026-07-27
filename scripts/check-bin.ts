// Packaging preflight: warn when no ipm-rpc binary is staged under
// bin/<goos>-<goarch>/. CI stages bin/ and invokes vsce directly, so this guard covers local `npm run package`; a
// local checkout usually has it empty, which silently produces a .vsix
// without a bundled server. That vsix still works — the extension falls
// back to `ipm.serverPath` or an `ipm-rpc` found on PATH — but the
// "bundled, nothing extra to install" promise doesn't hold, so say so
// loudly at package time. Warn only, never fail: packaging a
// binary-less vsix is a legitimate dev workflow.

import * as fs from 'fs';
import * as path from 'path';

const BIN_DIR = path.resolve(__dirname, '..', 'bin');

function hasBundledBinary(): boolean {
    if (!fs.existsSync(BIN_DIR)) return false;
    for (const entry of fs.readdirSync(BIN_DIR, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = path.join(BIN_DIR, entry.name);
        if (fs.existsSync(path.join(dir, 'ipm-rpc')) || fs.existsSync(path.join(dir, 'ipm-rpc.exe'))) {
            return true;
        }
    }
    return false;
}

if (!hasBundledBinary()) {
    console.warn('warning: no ipm-rpc under bin/<goos>-<goarch>/ — the packaged vsix will rely on PATH or the ipm.serverPath setting for its language server (CI stages the binary before packaging)');
}
