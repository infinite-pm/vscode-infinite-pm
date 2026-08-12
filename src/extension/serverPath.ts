// Server-binary resolution for ipm-rpc.
//
// Resolution order:
//
//   1. ipm.serverPath setting — explicit override; for power users with
//      their own build.
//   2. ipm-rpc on PATH — picked up automatically if the user ran
//      `go install ./cmd/ipm-rpc` from ipm-tools.
//   3. Bundled fallback inside the extension. The published .vsix is
//      platform-specific and ships the matching binary at
//      bin/<os>-<arch>/ipm-rpc{,.exe}.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

export interface ServerInfo {
    command: string;
    args: string[];
}

// bundledBinaryPath returns the absolute path of an `ipm-rpc` binary the
// extension ships for the current OS+arch, or undefined if none exists.
// Performs a chmod +x on the candidate file (some .vsix extractions drop
// the executable bit); ignores errors there.
export function bundledBinaryPath(ctx: vscode.ExtensionContext): string | undefined {
    // Directory names are GOOS-GOARCH, matching how the vsix is packaged. An
    // architecture we do not ship for returns undefined rather than guessing:
    // handing an amd64 binary to an ia32 or s390x host fails at exec time with
    // a far less obvious error than falling through to PATH.
    const arch = (() => {
        switch (process.arch) {
            case 'x64':   return 'amd64';
            case 'arm64': return 'arm64';
            case 'arm':   return 'arm';     // 32-bit ARM (linux-armhf vsix)
            default:      return undefined;
        }
    })();
    const platform = (() => {
        switch (process.platform) {
            case 'darwin': return 'darwin';
            case 'linux':  return 'linux';
            case 'win32':  return 'windows';
            default:       return undefined;
        }
    })();
    if (!platform || !arch) {
        return undefined;
    }
    const ext = platform === 'windows' ? '.exe' : '';
    const candidate = path.join(ctx.extensionPath, 'bin', `${platform}-${arch}`, `ipm-rpc${ext}`);
    if (!fs.existsSync(candidate)) {
        return undefined;
    }
    try {
        fs.chmodSync(candidate, 0o755);
    } catch {
        /* best-effort */
    }
    return candidate;
}

export function resolveServer(ctx: vscode.ExtensionContext, log: vscode.OutputChannel): ServerInfo | undefined {
    // 1. Configured override.
    const cfg = vscode.workspace.getConfiguration('ipm');
    const configured = cfg.get<string>('serverPath', '').trim();
    if (configured) {
        if (isExecutableFile(configured)) {
            log.appendLine(`[lsp] using configured ipm.serverPath = ${configured}`);
            return { command: configured, args: [] };
        }
        log.appendLine(`[lsp] ipm.serverPath = ${configured}, but not an executable file; falling back to PATH`);
    }

    // 2. ipm-rpc on PATH.
    const onPath = findOnPath('ipm-rpc');
    if (onPath) {
        log.appendLine(`[lsp] using ipm-rpc from PATH: ${onPath}`);
        return { command: onPath, args: [] };
    }

    // 3. Bundled fallback.
    const bundled = bundledBinaryPath(ctx);
    if (bundled) {
        log.appendLine(`[lsp] using bundled ipm-rpc: ${bundled}`);
        return { command: bundled, args: [] };
    }

    return undefined;
}

function isExecutableFile(p: string): boolean {
    try {
        fs.accessSync(p, fs.constants.X_OK);
        return true;
    } catch {
        return process.platform === 'win32' && fs.existsSync(p);
    }
}

function findOnPath(command: string): string | undefined {
    const PATH = process.env.PATH;
    if (!PATH) {
        return undefined;
    }
    const exts = process.platform === 'win32'
        ? (process.env.PATHEXT?.split(path.delimiter) ?? ['.EXE', '.CMD', '.BAT'])
        : [''];
    for (const dir of PATH.split(path.delimiter)) {
        if (!dir) continue;
        for (const ext of exts) {
            const candidate = path.join(dir, command + ext);
            if (isExecutableFile(candidate)) {
                return candidate;
            }
        }
    }
    return undefined;
}
