// Drift check: the generated palette files (package.json color rules,
// media/ipm-preview.css, src/palette.gen.ts) MUST match what
// scripts/gen-palette.ts produces from the source of truth in the
// ipm-tools repo (../ipm-tools/pkg/ipmtokens/palette.json). This test fails
// the moment someone edits one of the generated files directly, or the
// palette.json changes, without regenerating.
//
// To fix a failing assertion: edit the palette source of truth
// (../ipm-tools/pkg/ipmtokens/palette.json) and run `npm run gen-palette`.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

import { generateAll } from '../../scripts/gen-palette';
import { PALETTE } from '../palette.gen';

const ROOT = path.resolve(__dirname, '..', '..');
const SOT = '../ipm-tools/pkg/ipmtokens/palette.json';

test('package.json palette block matches the palette source of truth', () => {
    const onDisk = fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8');
    assert.equal(onDisk, generateAll().pkg,
        `package.json drifted from ${SOT} — run \`npm run gen-palette\``);
});

test('media/ipm-preview.css palette block matches the palette source of truth', () => {
    const onDisk = fs.readFileSync(path.join(ROOT, 'media', 'ipm-preview.css'), 'utf8');
    assert.equal(onDisk, generateAll().css,
        `media/ipm-preview.css drifted from ${SOT} — run \`npm run gen-palette\``);
});

test('src/palette.gen.ts matches the palette source of truth', () => {
    const onDisk = fs.readFileSync(path.join(ROOT, 'src', 'palette.gen.ts'), 'utf8');
    assert.equal(onDisk, generateAll().paletteGen,
        `src/palette.gen.ts drifted from ${SOT} — run \`npm run gen-palette\``);
});

// The byte-for-byte drift checks above only catch edits to the *generated*
// files. They can't catch a token type that exists in the palette but was
// never declared in package.json's hand-maintained `semanticTokenTypes`
// legend (or vice versa) — the LSP server emits that type, but VS Code has
// no contribution to theme it. Assert the two sets are equal in BOTH
// directions so adding a palette type without registering it (or removing a
// registered type from the palette) fails here.
test('package.json semanticTokenTypes equals the palette token-type set', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
    const declared: string[] = pkg.contributes.semanticTokenTypes.map(
        (t: { id: string }) => t.id,
    );
    const paletteTypes = Object.keys(PALETTE);

    const declaredSet = new Set(declared);
    const paletteSet = new Set(paletteTypes);

    const missingFromPackage = paletteTypes.filter((t) => !declaredSet.has(t));
    const missingFromPalette = declared.filter((t) => !paletteSet.has(t));

    assert.deepEqual(
        missingFromPackage,
        [],
        `palette token types not declared in package.json semanticTokenTypes: ${missingFromPackage.join(', ')} ` +
            `— add them to contributes.semanticTokenTypes`,
    );
    assert.deepEqual(
        missingFromPalette,
        [],
        `package.json semanticTokenTypes not present in the palette: ${missingFromPalette.join(', ')} ` +
            `— remove them or add to ${SOT}`,
    );
    // Belt-and-braces: equal sets (catches duplicates / count mismatches too).
    assert.deepEqual(
        [...declaredSet].sort(),
        [...paletteSet].sort(),
        'package.json semanticTokenTypes set must equal the palette token-type set',
    );
});
