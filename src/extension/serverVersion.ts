// Calls `ipm-rpc --version` and returns the printed version string.
//
// Used by the "infinite.pm: Show Server Info" command and the activation
// log line, so a user can verify which binary (and which build) the
// extension picked up — diagnosing the "stale binary" footgun where a
// freshly-installed extension talks to a pre-rebuild server process.

import { execFile } from 'child_process';

export interface ServerVersionInfo {
    command: string;
    version: string;
    stderr?: string;
}

export function getServerVersion(command: string, timeoutMs: number = 2000): Promise<ServerVersionInfo> {
    return new Promise((resolve, reject) => {
        execFile(command, ['--version'], { timeout: timeoutMs }, (err, stdout, stderr) => {
            if (err) {
                reject(err);
                return;
            }
            // Output is one line, "ipm-rpc <version>". We surface the whole
            // line so a downstream caller could split if needed; for display
            // we just trim trailing whitespace.
            const version = stdout.toString().trim();
            resolve({
                command,
                version,
                stderr: stderr ? stderr.toString() : undefined,
            });
        });
    });
}
