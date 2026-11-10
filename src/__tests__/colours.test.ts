// Colours: every node kind has an accessible light and dark colour, the
// TextMate fallback rules and the semantic rules agree per kind, token spans
// never get a background, and semantic highlighting cannot be switched off
// by the theme for our languages. See README.md#colours.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const defaults = pkg.contributes.configurationDefaults;

const LIGHT_BG = '#ffffff';
const DARK_BG = '#1f1f1f';
const AA = 4.5;

function luminance(hex: string): number {
    const c = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
        .map((v) => (v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4)));
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
}
function contrast(a: string, b: string): number {
    const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
}

interface Kind { name: string; semantic: string; title: string; marker: string; }
const KINDS: Kind[] = [
    { name: 'thing', semantic: 'ipmThing', title: 'entity.name.type.thing.ipmt', marker: 'storage.type.node.thing.ipmt' },
    { name: 'event', semantic: 'ipmEvent', title: 'entity.name.type.event.ipmt', marker: 'storage.type.node.event.ipmt' },
    { name: 'concept', semantic: 'ipmConcept', title: 'entity.name.type.concept.ipmt', marker: 'storage.type.node.concept.ipmt' },
];

const tm = defaults['editor.tokenColorCustomizations'];
const sem = defaults['editor.semanticTokenColorCustomizations'];
const darkTm: Array<{ scope: string; settings: { foreground: string; fontStyle?: string; background?: string } }> = tm.textMateRules;
const lightTm: typeof darkTm = tm['[*Light*]'].textMateRules;
const darkSem: Record<string, { foreground: string }> = sem.rules;
const lightSem: Record<string, { foreground: string }> = sem['[*Light*]'].rules;

function fg(rules: typeof darkTm, scope: string): string {
    const hit = rules.find((r) => r.scope === scope);
    assert.ok(hit, `no textMateRule for ${scope}`);
    return hit.settings.foreground;
}

test('every node kind has textMate rules for title and marker, light and dark', () => {
    for (const k of KINDS) {
        for (const scope of [k.title, k.marker]) {
            assert.match(fg(darkTm, scope), /^#[0-9a-f]{6}$/, `${k.name} dark ${scope}`);
            assert.match(fg(lightTm, scope), /^#[0-9a-f]{6}$/, `${k.name} light ${scope}`);
        }
    }
});

test('node kinds are told apart: three distinct colours in each mode', () => {
    assert.equal(new Set(KINDS.map((k) => fg(darkTm, k.title))).size, 3);
    assert.equal(new Set(KINDS.map((k) => fg(lightTm, k.title))).size, 3);
});

test('every dark colour meets WCAG AA (4.5:1) on the dark editor background', () => {
    for (const r of darkTm) {
        assert.ok(contrast(r.settings.foreground, DARK_BG) >= AA, `dark ${r.scope} ${r.settings.foreground} on ${DARK_BG}`);
    }
    for (const [name, r] of Object.entries(darkSem)) {
        assert.ok(contrast(r.foreground, DARK_BG) >= AA, `dark ${name} ${r.foreground}`);
    }
});

// On white there is one set of colours for everything: a light editor, the
// pages md-html writes, the figures. It is the look of the figures and of the
// diagrams, so the source in a light editor reads as the diagram beside it.
// It is not a contrast rule: an orange dark enough for 4.5:1 on white is a
// brown. ipm-tools pins the whole set (TestPalette_LightColoursDoNotMove);
// this pins the three kinds as the extension ships them.
const ON_WHITE: Record<string, string> = { event: '#ff8000', thing: '#4d8a3a', concept: '#6c8ebf' };

test('in a light theme a node kind is the colour its figures and diagrams have', () => {
    for (const k of KINDS) {
        assert.equal(fg(lightTm, k.title), ON_WHITE[k.name], `light ${k.name} title`);
        assert.equal(fg(lightTm, k.marker), ON_WHITE[k.name], `light ${k.name} marker`);
        assert.equal(lightSem[k.semantic].foreground, ON_WHITE[k.name], `light ${k.name} semantic`);
    }
    assert.equal(fg(darkTm, KINDS.find((k) => k.name === 'event')!.title), ON_WHITE.event, 'an event is the same orange in dark');
});

test('semantic rules and textMate rules agree per kind', () => {
    for (const k of KINDS) {
        assert.equal(darkSem[k.semantic].foreground, fg(darkTm, k.title), `${k.name} dark title`);
        assert.equal(lightSem[k.semantic].foreground, fg(lightTm, k.title), `${k.name} light title`);
        assert.equal(darkSem[`${k.semantic}.marker`].foreground, fg(darkTm, k.marker), `${k.name} dark marker`);
        assert.equal(lightSem[`${k.semantic}.marker`].foreground, fg(lightTm, k.marker), `${k.name} light marker`);
        // the title of a node is the colour of its kind, with or without an
        // alias; the alias itself is one step softer, so the two read apart
        assert.equal(darkSem[`${k.semantic}.hasAlias`].foreground, darkSem[k.semantic].foreground);
        assert.equal(lightSem[`${k.semantic}.hasAlias`].foreground, lightSem[k.semantic].foreground);
        assert.notEqual(darkSem[`${k.semantic}.alias`].foreground, darkSem[k.semantic].foreground);
        assert.notEqual(lightSem[`${k.semantic}.alias`].foreground, lightSem[k.semantic].foreground);
        assert.equal(darkSem[`${k.semantic}.marker`].foreground, darkSem[k.semantic].foreground);
        assert.equal(lightSem[`${k.semantic}.marker`].foreground, lightSem[k.semantic].foreground);
    }
});

test('arrows by relation use the kind colours (leads-to event, part-of thing, expresses concept)', () => {
    assert.equal(darkSem['ipmArrow.leadsTo'].foreground, darkSem.ipmEvent.foreground);
    assert.equal(darkSem['ipmArrow.partOf'].foreground, darkSem.ipmThing.foreground);
    assert.equal(darkSem['ipmArrow.expresses'].foreground, darkSem.ipmConcept.foreground);
    assert.equal(lightSem['ipmArrow.leadsTo'].foreground, lightSem.ipmEvent.foreground);
    assert.equal(lightSem['ipmArrow.partOf'].foreground, lightSem.ipmThing.foreground);
    assert.equal(lightSem['ipmArrow.expresses'].foreground, lightSem.ipmConcept.foreground);
});

test('token spans never get a background', () => {
    for (const r of [...darkTm, ...lightTm]) {
        assert.equal(r.settings.background, undefined, `textMate rule ${r.scope}`);
    }
    const css = fs.readFileSync(path.join(ROOT, 'media', 'ipm-preview.css'), 'utf8');
    for (const line of css.split('\n').filter((l) => /\.ipm-/.test(l))) {
        assert.ok(!/background/.test(line), `preview token rule has a background: ${line}`);
    }
});

test('preview CSS has a light colour for every kind title', () => {
    const css = fs.readFileSync(path.join(ROOT, 'media', 'ipm-preview.css'), 'utf8');
    for (const [cls, k] of [['e-title', KINDS[1]], ['t-title', KINDS[0]], ['c-title', KINDS[2]]] as const) {
        assert.ok(css.includes(`.ipm-${cls}         { color: ${darkSem[k.semantic].foreground};`), `dark rule for ${cls}`);
        assert.ok(css.includes(`.vscode-light .ipm-${cls}, .vscode-high-contrast-light .ipm-${cls} { color: ${lightSem[k.semantic].foreground}; }`),
            `light rule for ${cls}`);
    }
});

test('semantic highlighting is forced on for ipmt and markdown', () => {
    assert.equal(defaults['[ipmt]']['editor.semanticHighlighting.enabled'], true);
    assert.equal(defaults['[markdown]']['editor.semanticHighlighting.enabled'], true);
});

test('the grammar scopes used by the textMate rules exist in the grammar', () => {
    const grammar = fs.readFileSync(path.join(ROOT, 'syntaxes', 'ipmt.tmLanguage.json'), 'utf8');
    for (const k of KINDS) {
        assert.ok(grammar.includes(k.title), `${k.title} in grammar`);
        assert.ok(grammar.includes(k.marker), `${k.marker} in grammar`);
    }
});
