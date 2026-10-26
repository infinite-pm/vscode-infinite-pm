// A quote is not a bracket. VS Code's bracket-pair colourisation paints every
// character declared in `brackets` with its own colour (red when "unexpected"),
// which made the quotes of every node title red at the edges whatever the kind.
// Quotes still auto-close and surround through autoClosingPairs/surroundingPairs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const cfg = JSON.parse(
    fs.readFileSync(path.resolve(__dirname, '..', '..', 'language-configuration.json'), 'utf8'),
);

test('brackets declare no quote character', () => {
    const flat = ((cfg.brackets ?? []) as string[][]).flat();
    for (const b of flat) {
        assert.ok(!/["'`]/.test(b), `quote in brackets: ${b}`);
    }
    assert.equal(cfg.colorizedBracketPairs, undefined);
});

test('double quote still auto-closes and surrounds', () => {
    assert.deepEqual(cfg.autoClosingPairs, [['"', '"']]);
    assert.deepEqual(cfg.surroundingPairs, [['"', '"']]);
});
