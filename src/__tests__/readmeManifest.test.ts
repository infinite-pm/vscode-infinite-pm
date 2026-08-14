// The README documents the commands and settings; package.json defines them.
// Nothing kept the two in step, and by 0.4.3 the README named a palette entry
// that did not exist ("Open Preview" — the manifest says "Open as Preview") and
// an icon that had been replaced two releases earlier. A reader trusting either
// line would have looked for a command they could not find.
//
// These tests parse the README's own tables and compare them with the manifest
// in both directions, so documenting a command is part of contributing one and
// renaming a command breaks the build rather than the docs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')) as {
    contributes: {
        commands: Array<{ command: string; title: string; category?: string }>;
        configuration: { properties: Record<string, { default?: unknown }> };
    };
};

// A Commands row looks like:  | **infinite.pm: Open as Preview** | what it does |
function readmeCommandTitles(): string[] {
    return [...readme.matchAll(/^\|\s*\*\*infinite\.pm:\s*(.+?)\*\*\s*\|/gm)].map((m) => m[1].trim());
}

// A Settings row looks like:  | `ipm.liveRefresh` | `true` | what it does |
function readmeSettings(): Array<{ id: string; def: string }> {
    return [...readme.matchAll(/^\|\s*`(ipm\.[A-Za-z]+)`\s*\|\s*`([^`]*)`\s*\|/gm)]
        .map((m) => ({ id: m[1], def: m[2] }));
}

test('every command in the README exists in the manifest, by exact title', () => {
    const manifest = new Set(
        pkg.contributes.commands
            .filter((c) => c.category === 'infinite.pm')
            .map((c) => c.title),
    );
    const undocumented = readmeCommandTitles().filter((t) => !manifest.has(t));
    assert.deepEqual(undocumented, [],
        'the README names palette entries the manifest does not contribute — ' +
        `manifest titles are: ${[...manifest].join(', ')}`);
});

test('every command in the manifest appears in the README', () => {
    const documented = new Set(readmeCommandTitles());
    const missing = pkg.contributes.commands
        .filter((c) => c.category === 'infinite.pm')
        .map((c) => c.title)
        .filter((t) => !documented.has(t));
    assert.deepEqual(missing, [],
        'these commands ship undocumented — add a row to the README Commands table');
});

test('every setting in the README exists in the manifest, with the same default', () => {
    const props = pkg.contributes.configuration.properties;
    for (const { id, def } of readmeSettings()) {
        assert.ok(props[id], `README documents ${id}, which the manifest does not contribute`);
        // The README writes defaults as they read: `true`, `0`, `""`.
        const actual = JSON.stringify(props[id].default ?? null);
        const documented = def === '""' ? '""' : def;
        assert.equal(actual, documented,
            `${id}: README says the default is ${documented}, manifest says ${actual}`);
    }
});

test('every setting in the manifest appears in the README', () => {
    const documented = new Set(readmeSettings().map((s) => s.id));
    const missing = Object.keys(pkg.contributes.configuration.properties)
        .filter((id) => !documented.has(id));
    assert.deepEqual(missing, [],
        'these settings ship undocumented — add a row to the README Settings table');
});

// The icon claim is prose, so it cannot be parsed the way a table row can. Pin
// the two the README actually names: a stale icon sentence is what made the
// "Open Preview" row wrong in two ways at once.
test('the README does not describe icons the manifest no longer uses', () => {
    const iconOf = (id: string) => pkg.contributes.commands.find((c) => c.command === id)?.icon;
    const inPlace = iconOf('infinite.pm.openPreview');
    const toSide = iconOf('infinite.pm.openPreviewToSide');

    const commandsSection = readme.slice(readme.indexOf('## Commands'));
    if (typeof inPlace === 'string') {
        assert.ok(commandsSection.includes(inPlace),
            `the in-place preview uses ${inPlace}; the README Commands table does not mention it`);
    }
    if (typeof toSide === 'string') {
        assert.ok(commandsSection.includes(toSide),
            `the side preview uses ${toSide}; the README Commands table does not mention it`);
    }
    assert.ok(!/bundled SVG \(`media\/preview-\{light,dark\}\.svg`\)/.test(commandsSection),
        'the README still describes the preview button icon as a bundled SVG; ' +
        'those files are the preview TAB icon (ipmtPreview.ts), not the button');
});
