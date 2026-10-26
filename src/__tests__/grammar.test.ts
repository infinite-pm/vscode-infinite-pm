// The TextMate grammar is the colour fallback when semantic highlighting is
// off (or before the language server answers): the WHOLE node — quoted or
// bare title, alias and kind marker — must carry its kind scope, so the
// shipped textMateRules colour it by kind. An unmarked title is an event.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

const ROOT = path.resolve(__dirname, '..', '..');

let registryPromise: Promise<vsctm.IGrammar> | undefined;

function loadGrammar(): Promise<vsctm.IGrammar> {
    if (!registryPromise) {
        const wasm = fs.readFileSync(path.join(ROOT, 'node_modules', 'vscode-oniguruma', 'release', 'onig.wasm'));
        const onigLib = oniguruma.loadWASM(wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer).then(() => ({
            createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
            createOnigString: (s: string) => new oniguruma.OnigString(s),
        }));
        const registry = new vsctm.Registry({
            onigLib,
            loadGrammar: async (scopeName) => {
                if (scopeName !== 'source.ipmt') return null;
                const file = path.join(ROOT, 'syntaxes', 'ipmt.tmLanguage.json');
                return vsctm.parseRawGrammar(fs.readFileSync(file, 'utf8'), file);
            },
        });
        registryPromise = registry.loadGrammar('source.ipmt').then((g) => {
            if (!g) throw new Error('grammar source.ipmt did not load');
            return g;
        });
    }
    return registryPromise;
}

interface Span { text: string; scopes: string[]; }

// Tokenise the lines and merge neighbours with identical scopes into spans.
async function spans(src: string): Promise<Span[]> {
    const grammar = await loadGrammar();
    const out: Span[] = [];
    let state = vsctm.INITIAL;
    for (const line of src.split('\n')) {
        const r = grammar.tokenizeLine(line, state);
        for (const t of r.tokens) {
            const text = line.slice(t.startIndex, t.endIndex);
            const prev = out[out.length - 1];
            if (prev && prev.scopes.join(' ') === t.scopes.join(' ')) prev.text += text;
            else out.push({ text, scopes: t.scopes });
        }
        state = r.ruleStack;
    }
    return out;
}

// scopeOf returns the scopes of the n-th (0-based) span whose trimmed text is `text`.
function scopeOf(all: Span[], text: string, n = 0): string[] {
    const hits = all.filter((s) => s.text.trim() === text);
    assert.ok(hits.length > n, `no span "${text}" #${n} in ${JSON.stringify(all.map((s) => s.text))}`);
    return hits[n].scopes;
}

const THING = 'entity.name.type.thing.ipmt';
const EVENT = 'entity.name.type.event.ipmt';
const CONCEPT = 'entity.name.type.concept.ipmt';
const NODE_STRING = 'string.quoted.double.ipmt';

test('thing line: quoted titles and ::t markers carry the thing scopes', async () => {
    const all = await spans('"the JA stream" ::t --> "ja-hub" ::t');
    assert.ok(scopeOf(all, '"the JA stream"').includes(THING));
    assert.ok(scopeOf(all, '"ja-hub"').includes(THING));
    assert.ok(scopeOf(all, '::t', 0).includes('storage.type.node.thing.ipmt'));
    assert.ok(scopeOf(all, '::t', 1).includes('storage.type.node.thing.ipmt'));
    assert.ok(scopeOf(all, '-->').includes('keyword.operator.arrow.ipmt'));
});

test('event line: ::e title and marker carry the event scopes', async () => {
    const all = await spans('"a" ::e');
    assert.ok(scopeOf(all, '"a"').includes(EVENT));
    assert.ok(scopeOf(all, '::e').includes('storage.type.node.event.ipmt'));
});

test('concept line: ::c title and marker carry the concept scopes', async () => {
    const all = await spans('"b" ::c');
    assert.ok(scopeOf(all, '"b"').includes(CONCEPT));
    assert.ok(scopeOf(all, '::c').includes('storage.type.node.concept.ipmt'));
});

test('bare titles: marked by kind, unmarked is an event', async () => {
    const all = await spans('Patrick wears black ::e --> black shirt ::t --> motion ::c --> plain --> other');
    assert.ok(scopeOf(all, 'Patrick wears black').includes(EVENT));
    assert.ok(scopeOf(all, 'black shirt').includes(THING));
    assert.ok(scopeOf(all, 'motion').includes(CONCEPT));
    assert.ok(scopeOf(all, 'plain').includes(EVENT), 'unmarked bare title is an event');
    assert.ok(scopeOf(all, 'other').includes(EVENT), 'unmarked bare title is an event');
});

test('unmarked quoted title is an event, not a string', async () => {
    const all = await spans('"just a label" --> other');
    assert.ok(scopeOf(all, '"just a label"').includes(EVENT));
});

test('alias takes the node kind, before or after the marker', async () => {
    const before = await spans('x::a "long title" ::t');
    assert.ok(scopeOf(before, 'x').includes(THING));
    assert.ok(scopeOf(before, '"long title"').includes(THING));
    const after = await spans('black shirt ::t bs::a --::P--> wearB');
    assert.ok(scopeOf(after, 'bs').includes(THING));
    const concept = await spans('change ::c chg::a');
    assert.ok(scopeOf(concept, 'chg').includes(CONCEPT));
});

test('relations: explicit arrows carry their relation scope', async () => {
    const all = await spans('a ::t --::P--> b ::t --::L--> c --::X--> d ::c --::N-- e');
    assert.ok(scopeOf(all, '--::P-->').includes('keyword.operator.arrow.partOf.ipmt'));
    assert.ok(scopeOf(all, '--::L-->').includes('keyword.operator.arrow.leadsTo.ipmt'));
    assert.ok(scopeOf(all, '--::X-->').includes('keyword.operator.arrow.expresses.ipmt'));
    assert.ok(scopeOf(all, '--::N--').includes('keyword.operator.arrow.nearTo.ipmt'));
});

test('tooltips keep their own scope, and no node title is a generic string', async () => {
    const all = await spans('bs --"during"--> swapT\nswapT "a quick move" ::tip\n"x" ::t --> "y" ::e --> "z"');
    assert.ok(scopeOf(all, '"during"').includes('string.quoted.double.tooltip.ipmt'));
    assert.ok(scopeOf(all, '"a quick move"').includes('string.quoted.double.tooltip.ipmt'));
    for (const s of all) {
        assert.ok(!s.scopes.includes(NODE_STRING), `"${s.text}" must not be a generic string`);
    }
});
