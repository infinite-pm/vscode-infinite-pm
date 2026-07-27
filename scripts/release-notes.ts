// Release preflight, used by .github/workflows/release.yml.
//
//   tsx scripts/release-notes.ts <tag>
//
// Two jobs, both of which must be right before anything is published:
//
//   1. Assert package.json's version is exactly the tag without its leading
//      `v`. A version/tag mismatch is the classic release accident, and the
//      marketplace never lets a version be replaced — only superseded.
//   2. Print the CHANGELOG.md section for that version on stdout, so the
//      GitHub release notes and the marketplace Changelog tab cannot disagree
//      with the file in the repo.
//
// Exits non-zero with a specific message on any mismatch; the workflow runs it
// before the publish job so a bad tag fails at minute one, not after five
// platform builds.

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');

function die(msg: string): never {
    console.error(`release-notes: ${msg}`);
    process.exit(1);
}

const tag = process.argv[2];
if (!tag) {
    die('usage: release-notes.ts <tag>   (e.g. v0.4.1)');
}

const wanted = tag.replace(/^v/, '');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as { version?: string };
if (pkg.version !== wanted) {
    die(`tag ${tag} implies version ${wanted}, but package.json says ${pkg.version ?? '(none)'}. ` +
        'Bump package.json (and CHANGELOG.md) or retag — do not publish a mismatch.');
}

// Sections look like `## 0.4.1 — 2026-07-27` or `## 0.4.1 — unreleased`;
// match on the version token only, so the suffix stays free-form.
const changelog = fs.readFileSync(path.join(ROOT, 'CHANGELOG.md'), 'utf8');
const lines = changelog.split('\n');
const start = lines.findIndex((l) => new RegExp(`^##\\s+v?${wanted.replace(/\./g, '\\.')}(\\s|$)`).test(l));
if (start === -1) {
    die(`CHANGELOG.md has no "## ${wanted}" section — write the release notes before tagging.`);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
    if (/^##\s/.test(lines[i])) {
        end = i;
        break;
    }
}
const body = lines.slice(start + 1, end).join('\n').trim();
if (!body) {
    die(`the "## ${wanted}" section of CHANGELOG.md is empty.`);
}
if (/unreleased/i.test(lines[start])) {
    die(`the "## ${wanted}" heading still says "unreleased" — date it before tagging.`);
}
process.stdout.write(body + '\n');
