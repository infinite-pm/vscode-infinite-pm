// Contribution-shape checks for package.json. Nothing here runs extension
// code — these guard the declarations VS Code reads at install time, which no
// other test covers and which fail silently in the UI (a menu entry that
// points at a misspelled command simply does nothing).
//
// The title-bar assertions mirror markdown-language-features, which puts TWO
// preview buttons on a markdown editor and distinguishes them by icon:
//
//   navigation@1  markdown.showPreviewToSide   $(open-preview)
//   navigation@2  markdown.reopenAsPreview     $(preview)
//
// Ours pair up the same way. What made the original pair read as one control
// duplicated was never the count — it was giving both buttons preview-shaped
// artwork that looks alike at 16px, so the icons are what these tests pin.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..', '..');

interface MenuItem {
    command: string;
    alt?: string;
    group?: string;
    when?: string;
}

const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const commands: Array<{ command: string; title: string; icon?: unknown }> =
    pkg.contributes.commands;
const menus: Record<string, MenuItem[]> = pkg.contributes.menus;
const keybindings: Array<{ command: string; key: string; when?: string }> =
    pkg.contributes.keybindings;

const declared = new Set(commands.map((c) => c.command));

// A menu entry (or an `alt`, or a keybinding) naming a command that isn't
// contributed is dead weight: VS Code drops it without complaint.
test('every command referenced by a menu, alt or keybinding is contributed', () => {
    const referenced: string[] = [];
    for (const [menu, items] of Object.entries(menus)) {
        for (const item of items) {
            referenced.push(`${menu}:${item.command}`);
            if (item.alt) referenced.push(`${menu}:${item.alt}`);
        }
    }
    for (const kb of keybindings) referenced.push(`keybindings:${kb.command}`);

    const dangling = referenced.filter((ref) => !declared.has(ref.split(':')[1]));
    assert.deepEqual(dangling, [], 'referenced but not in contributes.commands');
});

test('the .ipmt editor title bar pairs the two preview buttons like markdown', () => {
    const ipmtNav = menus['editor/title'].filter(
        (item) => item.group?.startsWith('navigation') && item.when?.includes('editorLangId == ipmt'),
    );

    assert.deepEqual(
        ipmtNav.map((item) => `${item.group} ${item.command}`),
        [
            'navigation@1 infinite.pm.openPreviewToSide',
            'navigation@2 infinite.pm.openPreview',
        ],
        'to-the-side first, then open-as-preview — the order markdown uses',
    );
});

// The icons are the whole point: two preview buttons are fine, two buttons
// wearing the same preview glyph are not. These are the exact codicons
// markdown-language-features gives its own pair.
test('the two preview buttons wear different icons', () => {
    const iconOf = (id: string) => {
        const cmd = commands.find((c) => c.command === id);
        assert.ok(cmd, `${id} is not contributed`);
        assert.ok(cmd.icon, `${id} needs an icon: it renders in the editor title bar`);
        return cmd.icon;
    };

    const side = iconOf('infinite.pm.openPreviewToSide');
    const inPlace = iconOf('infinite.pm.openPreview');

    assert.equal(side, '$(open-preview)', 'markdown.showPreviewToSide uses this');
    assert.equal(inPlace, '$(preview)', 'markdown.reopenAsPreview uses this');
    assert.notDeepEqual(side, inPlace,
        'side-by-side buttons with the same glyph read as one control duplicated');
});

// Markdown's own bindings, but scoped to ipmt: shift+ctrl+v in place,
// ctrl+k v to the side. The `when` clause is what keeps them off markdown
// editors, where markdown-language-features claims the same chords.
test('preview keybindings match markdown and are scoped to .ipmt editors', () => {
    const expected: Record<string, string> = {
        'infinite.pm.openPreview': 'shift+ctrl+v',
        'infinite.pm.openPreviewToSide': 'ctrl+k v',
    };

    for (const [command, key] of Object.entries(expected)) {
        const kb = keybindings.find((b) => b.command === command);
        assert.ok(kb, `${command} has no keybinding`);
        assert.equal(kb.key, key);
        assert.match(
            kb.when ?? '',
            /editorLangId == ipmt/,
            `${command} must be scoped to .ipmt editors or it hijacks the markdown binding`,
        );
    }
});
