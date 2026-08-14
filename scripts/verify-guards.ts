// Do the guards actually fire?
//
//   npm run verify-guards
//
// Every assertion added this week was verified once, by hand, against the bug
// it exists for — then never again. That is how `.vscodeignore` ended up with a
// rule that could not fire: written, believed, and never tested. This applies
// each breakage deliberately, to a scratch copy, and asserts the expected red.
//
// It mutates copies under a temp directory and never touches the working tree.
// Slow (each case runs a suite), so it is not part of `npm test` — run it when
// you add a guard, and periodically to catch one that has rotted.

import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

interface Case {
    name: string;
    /** What this guard is supposed to catch, in the words of the bug it came from. */
    guards: string;
    /** Apply the breakage inside the scratch copy. */
    break: (dir: string) => void;
    /** Which test file should go red. */
    spec: string;
}

const edit = (file: string, from: string | RegExp, to: string) => (dir: string) => {
    const p = path.join(dir, file);
    const before = fs.readFileSync(p, 'utf8');
    const after = before.replace(from, to);
    if (after === before) {
        throw new Error(`verify-guards: could not apply the breakage to ${file} — the code moved`);
    }
    fs.writeFileSync(p, after);
};

const CASES: Case[] = [
    {
        name: 'save keeps the tokens',
        guards: '0.4.2: saving a .md evicted the semantic tokens and every fence went black',
        break: edit('src/extension/liveRefresh.ts',
            'cache.deleteSvgs(doc.uri.toString());', 'cache.delete(doc.uri.toString());'),
        spec: 'src/__tests__/liveRefresh.test.ts',
    },
    {
        name: 'no setting switches colours off',
        guards: '0.4.2: ipm.liveRefresh=false gated every embedBuffer call, colours included',
        break: edit('src/extension/liveRefresh.ts',
            'const fireTokens = (doc: vscode.TextDocument) => {',
            'const fireTokens = (doc: vscode.TextDocument) => {\n        if (!liveDiagrams()) return;'),
        spec: 'src/__tests__/liveRefresh.test.ts',
    },
    {
        name: 'the .vsix ships exactly what it should',
        guards: '0.4.2: 2MB of demo GIF in nine platform packages, from a rule that could not fire',
        break: (dir) => {
            edit('.vscodeignore', '!media/icon.png', '!media/icon.png\n!media/demo/**')(dir);
            fs.mkdirSync(path.join(dir, 'media', 'demo'), { recursive: true });
            fs.writeFileSync(path.join(dir, 'media', 'demo', 'probe.gif'), 'GIF89a');
        },
        spec: 'src/__tests__/packageManifest.test.ts',
    },
    {
        name: 'the README matches the manifest',
        guards: '0.4.3: the README named a palette entry that had been renamed two releases earlier',
        break: edit('package.json', '"title": "Open as Preview"', '"title": "Open Preview Renamed"'),
        spec: 'src/__tests__/readmeManifest.test.ts',
    },
    {
        name: 'the token legend agrees across repos',
        guards: 'a modifier inserted mid-list recolours every fence, silently',
        break: edit('src/extension/previewHighlight.ts',
            'const MOD_PARTOF    = 1 << 2;', 'const MOD_PARTOF    = 1 << 5;'),
        spec: 'src/__tests__/serverLegend.test.ts',
    },
    {
        name: 'the preview seam still carries colour',
        guards: 'a request was issued and carried nothing the renderer could use',
        break: edit('src/extension/liveRefresh.ts',
            /while \(out\.endsWith\('\\n'\)\) out = out\.slice\(0, -1\);/,
            '/* normalization removed */'),
        spec: 'src/__tests__/previewSeam.test.ts',
    },
    {
        name: 'the webview only calls helpers that exist',
        guards: 'a typo in the inline script is invisible to tsc and fatal at runtime',
        break: edit('src/extension/ipmtPreview.ts', 'V.isZoomed(scale)', 'V.isZoomedTypo(scale)'),
        spec: 'src/__tests__/previewView.test.ts',
    },
];

function scratchCopy(): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ipm-guards-'));
    // Everything the suites read, minus the heavy directories. node_modules is
    // symlinked rather than copied: 400MB per case is not a price worth paying.
    for (const entry of ['src', 'scripts', 'media', 'syntaxes', 'package.json', '.vscodeignore',
        'README.md', 'CHANGELOG.md', 'AUTHORS.md', 'LICENSE', 'language-configuration.json',
        'tsconfig.json', 'dist', 'bin']) {
        const from = path.join(ROOT, entry);
        if (!fs.existsSync(from)) continue;
        fs.cpSync(from, path.join(dir, entry), { recursive: true });
    }
    fs.symlinkSync(path.join(ROOT, 'node_modules'), path.join(dir, 'node_modules'));
    return dir;
}

function runsRed(dir: string, spec: string): boolean {
    try {
        execFileSync('node', ['--import', 'tsx', '--test', spec], {
            cwd: dir, stdio: 'pipe', encoding: 'utf8',
        });
        return false;   // exit 0 — the suite passed, so the guard did not fire
    } catch {
        return true;
    }
}

let failed = 0;
for (const c of CASES) {
    const dir = scratchCopy();
    try {
        c.break(dir);
        const red = runsRed(dir, c.spec);
        console.log(`${red ? 'ok  ' : 'DEAD'}  ${c.name}`);
        if (!red) {
            failed++;
            console.log(`      guard is dead: ${c.guards}`);
            console.log(`      ${c.spec} still passes with the breakage applied`);
        }
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

if (failed > 0) {
    console.error(`\n${failed} guard(s) no longer catch what they were written for.`);
    process.exit(1);
}
console.log(`\nall ${CASES.length} guards fire.`);
