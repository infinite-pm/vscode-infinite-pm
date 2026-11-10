// The LSP semantic-token legend is a contract between two repositories, and
// its wire form is a pair of INDEXES: the server sends a token type as an index
// into its own list, and a set of modifiers as a bitmask where bit N is the Nth
// entry of another list. Nothing in either repo checks that the two ends agree
// on those orders.
//
// So a silent renumber — inserting a modifier in the middle of the Go slice,
// say — recolours every fence in the preview and every token in the editor, and
// no test anywhere fails. The palette drift check next door catches renamed
// *colours*; this catches renamed *positions*.
//
// Reading the Go source directly is the same arrangement paletteConsistency
// already relies on: `npm test` requires the sibling ../ipm-tools clone (see
// CONTRIBUTING.md), and CI checks it out beside this repo. IPM_TOOLS_DIR names
// another checkout, the same variable scripts/gen-palette.ts reads.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const IPM_TOOLS_DIR = process.env.IPM_TOOLS_DIR
    ? path.resolve(process.env.IPM_TOOLS_DIR)
    : path.resolve(ROOT, '..', 'ipm-tools');
const TOKENS_GO = path.join(IPM_TOOLS_DIR, 'pkg', 'ipmtokens', 'tokens.go');

function goStringSlice(name: string): string[] {
    const src = fs.readFileSync(TOKENS_GO, 'utf8');
    const start = src.indexOf(`var ${name} = []string{`);
    assert.notEqual(start, -1,
        `${name} not found in ${TOKENS_GO} — the server's legend moved or was renamed`);
    const body = src.slice(start, src.indexOf('}', start));
    return [...body.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
}

test('the modifier bit positions match the server, in order', () => {
    const server = goStringSlice('SemanticTokenModifiers');

    // previewHighlight.ts encodes the same list as bit constants. Read them
    // rather than importing, so the test sees the literal a human edits.
    const src = fs.readFileSync(path.join(ROOT, 'src', 'extension', 'previewHighlight.ts'), 'utf8');
    const bits = new Map<string, number>();
    for (const m of src.matchAll(/const MOD_([A-Z]+)\s*=\s*1 << (\d+);/g)) {
        bits.set(m[1].toLowerCase(), Number(m[2]));
    }
    assert.ok(bits.size > 0, 'no MOD_* constants found in previewHighlight.ts');

    const mismatched = server
        .map((name, index) => ({ name, index, bit: bits.get(name.toLowerCase()) }))
        .filter((e) => e.bit !== e.index);

    assert.deepEqual(mismatched, [],
        `the extension decodes modifier bits in a different order than ipm-rpc sends them.\n` +
        `  server order: ${server.join(', ')}\n` +
        'Bit N must be the Nth entry. A mismatch recolours every fence and every token, silently.');
});

test('the manifest declares the same modifiers as the server', () => {
    const server = goStringSlice('SemanticTokenModifiers');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        contributes: { semanticTokenModifiers: Array<{ id: string }>; semanticTokenTypes: Array<{ id: string }> };
    };
    assert.deepEqual(
        pkg.contributes.semanticTokenModifiers.map((m) => m.id),
        server,
        'contributes.semanticTokenModifiers must list exactly what the server sends, in its order — ' +
        'VS Code themes address them by name, and the editor decodes them by position',
    );
});

test('the manifest declares the same token types as the server', () => {
    const server = goStringSlice('SemanticTokenTypes');
    const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
        contributes: { semanticTokenTypes: Array<{ id: string }> };
    };
    assert.deepEqual(
        pkg.contributes.semanticTokenTypes.map((t) => t.id),
        server,
        'contributes.semanticTokenTypes must list exactly what the server sends, in its order — ' +
        'a type the manifest does not declare cannot be themed, and one it declares in the ' +
        'wrong position is themed as its neighbour',
    );
});
