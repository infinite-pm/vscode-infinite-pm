// What ends up inside the .vsix, asserted exactly.
//
// 0.4.2 shipped 2MB of demo GIF in each of its nine platform packages. The
// .vscodeignore had a rule against exactly that, with a comment explaining why
// — and the rule could never fire, because vsce applies every `!` re-include
// AFTER the ignore patterns whatever their order, so a blanket `!media/**`
// re-included media/demo/** and the line below it did nothing.
//
// The lesson is not "exclude media/demo". A second `does not contain
// media/demo/` assertion would be one more guard aimed at the last bug. This
// asserts the whole manifest against a checked-in list, so ANY change to what
// ships — an addition, a removal, a rename — has to be acknowledged in a diff.
//
// It lives in `npm test` on purpose. The obvious home is beside
// scripts/check-bin.ts, which `npm run package` runs — but CI never calls
// `npm run package` (build-vsix.yml runs `npx vsce package` directly), so a
// guard hung there would be exactly as dead as the .vscodeignore rule was.
//
// To update after a deliberate change:
//   npx vsce ls | sed 's|^bin/.*|bin/<target>/ipm-rpc|' | sort -u > scripts/expected-package-files.txt

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const EXPECTED = path.join(ROOT, 'scripts', 'expected-package-files.txt');

// `vsce ls` prints the files it would package, one per line. The bundled server
// is per-platform (bin/linux-x64/ipm-rpc, bin/win32-x64/ipm-rpc.exe, …) and a
// dev machine has whichever it built, so collapse that one line.
function packagedFiles(): string[] {
    const out = execFileSync('npx', ['vsce', 'ls'], { cwd: ROOT, encoding: 'utf8' });
    return [...new Set(
        out.split('\n')
            .map((l) => l.trim())
            .filter(Boolean)
            .map((l) => (l.startsWith('bin/') ? 'bin/<target>/ipm-rpc' : l)),
    )].sort((a, b) => a.localeCompare(b));
}

test('the .vsix contains exactly the files we expect', () => {
    const expected = fs.readFileSync(EXPECTED, 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
    const actual = packagedFiles();

    const added = actual.filter((f) => !expected.includes(f));
    const removed = expected.filter((f) => !actual.includes(f));

    assert.deepEqual(added, [],
        'these files would now ship and are not in scripts/expected-package-files.txt. ' +
        'If that is intended, add them there in the same commit; if not, .vscodeignore needs a rule ' +
        'that can actually fire (re-includes beat ignores, so narrow the `!` patterns).');
    assert.deepEqual(removed, [],
        'these files no longer ship. If that is intended, drop them from ' +
        'scripts/expected-package-files.txt in the same commit.');
});

test('no recording, screenshot or doc directory rides along', () => {
    // The manifest test above already covers this. This one exists to name the
    // failure: if someone regenerates the expected list without reading it, at
    // least the megabytes announce themselves.
    const heavy = packagedFiles().filter((f) => /\.(gif|mp4|webm|png)$/i.test(f) && f !== 'media/icon.png');
    assert.deepEqual(heavy, [],
        'only media/icon.png should ship as an image — the README embeds its recordings ' +
        'by relative path and vsce rewrites those to absolute URLs at package time');
});
