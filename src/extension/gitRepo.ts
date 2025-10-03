// Tiny git-repo helper shared by the re-embed commands and the
// included-`.ipmt`-change refresh.

import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';

// findGitRepoRoot walks up from the file's directory to the nearest
// ancestor containing a `.git` entry (a dir for a normal clone, a file
// for a worktree/submodule) and returns it as a Uri. Returns undefined
// for non-file URIs or files not under any git repo.
export function findGitRepoRoot(uri: vscode.Uri): vscode.Uri | undefined {
    if (uri.scheme !== 'file') {
        return undefined;
    }
    let dir = path.dirname(uri.fsPath);
    for (;;) {
        if (fs.existsSync(path.join(dir, '.git'))) {
            return vscode.Uri.file(dir);
        }
        const parent = path.dirname(dir);
        if (parent === dir) {
            return undefined;
        }
        dir = parent;
    }
}
