// Generates the vscode-side palette files from the SOURCE OF TRUTH, which
// lives in the ipm-tools repo: ../ipm-tools/pkg/ipmtokens/palette.json.
//
// Outputs (all generated from palette.json; kept in lock-step here):
//   - src/palette.gen.ts: PALETTE / CLASS_SUFFIX / MODIFIER_NAMES data
//     (the hand-written helpers in src/palette.ts import from this).
//   - package.json: editor.semanticTokenColorCustomizations.rules
//   - media/ipm-preview.css: token color classes (between GEN markers)
//
// ipm-tools owns its own Go-side artifacts (pkg/ipmtokens embeds palette.json
// directly, pkg/mdhtml composes its CSS at runtime) — this script no longer
// writes anything into ipm-tools, so the dependency is one-directional.
//
// Usage:
//   npm run gen-palette       — write to disk
//   npm run gen-palette:check — exit non-zero if disk differs from generated
//                               (used by tests and CI)

import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '..');
const PKG_PATH = path.join(ROOT, 'package.json');
const CSS_PATH = path.join(ROOT, 'media', 'ipm-preview.css');
const PALETTE_GEN_PATH = path.join(ROOT, 'src', 'palette.gen.ts');

// The palette source of truth in the sibling ipm-tools repo.
// IPM_TOOLS_DIR points at another ipm-tools checkout (a worktree, say).
const IPM_TOOLS_DIR = process.env.IPM_TOOLS_DIR
    ? path.resolve(process.env.IPM_TOOLS_DIR)
    : path.resolve(ROOT, '..', 'ipm-tools');
const PALETTE_JSON = path.join(IPM_TOOLS_DIR, 'pkg', 'ipmtokens', 'palette.json');
const PALETTE_JSON_REL = '../ipm-tools/pkg/ipmtokens/palette.json';

const CSS_GEN_START = '/* GEN-START palette — do not edit; run `npm run gen-palette` */';
const CSS_GEN_END = '/* GEN-END palette */';

// Stable emission/grouping order for the generated output (the editor
// rules, the CSS block, MODIFIER_NAMES, and the TokenStyleSet fields).
// This is purely cosmetic ordering and is intentionally independent of —
// NOT a mirror of — the LSP bit-index legend SemanticTokenModifiers in
// ipm-tools/pkg/ipmtokens/tokens.go (where the indices encode wire bits).
const MOD_ORDER = ['alias', 'hasAlias', 'leadsTo', 'partOf', 'expresses', 'nearTo', 'marker'] as const;

interface PaletteRule {
    type: string;
    mod?: string;
    class: string;
    fg: string; // dark themes
    fgLight: string; // light themes
    bold?: boolean;
    italic?: boolean;
}

// The TextMate scope the grammar (syntaxes/ipmt.tmLanguage.json) gives each
// palette class, for the fallback colours that work with semantic
// highlighting off. The alias classes share their title's scope, and the
// dimmed `-aliased` titles have none: only the language server knows a node
// has an alias.
const TEXTMATE_SCOPE: Record<string, string> = {
    'e-title': 'entity.name.type.event.ipmt',
    't-title': 'entity.name.type.thing.ipmt',
    'c-title': 'entity.name.type.concept.ipmt',
    'e-marker': 'storage.type.node.event.ipmt',
    't-marker': 'storage.type.node.thing.ipmt',
    'c-marker': 'storage.type.node.concept.ipmt',
    'arrow': 'keyword.operator.arrow.ipmt',
    'L': 'keyword.operator.arrow.leadsTo.ipmt',
    'P': 'keyword.operator.arrow.partOf.ipmt',
    'X': 'keyword.operator.arrow.expresses.ipmt',
    'N': 'keyword.operator.arrow.nearTo.ipmt',
    'type-marker': 'storage.type.node.ipmt',
    'relation': 'storage.type.relation.ipmt',
    'comment': 'comment.line.number-sign.ipmt',
    'string': 'string.quoted.double.ipmt',
    'tooltip': 'string.quoted.double.tooltip.ipmt',
    'unresolved': 'comment.unresolved.ipmt',
};

// VS Code applies a `[name]` block inside editor.tokenColorCustomizations /
// editor.semanticTokenColorCustomizations to themes whose name matches; `*`
// is a wildcard. The base values are the dark ones, `[*Light*]` overrides them.
const LIGHT_THEMES = '[*Light*]';

function loadRules(): PaletteRule[] {
    if (!fs.existsSync(PALETTE_JSON)) {
        console.error(`palette source not found: ${PALETTE_JSON} — clone https://github.com/infinite-pm/ipm-tools next to this repo (../ipm-tools)`);
        process.exit(1);
    }
    const doc = JSON.parse(fs.readFileSync(PALETTE_JSON, 'utf8'));
    return doc.rules as PaletteRule[];
}

// Walk rules grouped by token type (preserving first-seen type order, then
// base rule followed by its modifier rules in MOD_ORDER) — the stable order
// both the editor rules and the CSS block emit in.
function orderedRules(rules: PaletteRule[]): PaletteRule[] {
    const types: string[] = [];
    const byType = new Map<string, PaletteRule[]>();
    for (const r of rules) {
        if (!byType.has(r.type)) { byType.set(r.type, []); types.push(r.type); }
        byType.get(r.type)!.push(r);
    }
    const out: PaletteRule[] = [];
    for (const t of types) {
        const group = byType.get(t)!;
        const base = group.find(r => !r.mod);
        if (base) out.push(base);
        for (const m of MOD_ORDER) {
            const hit = group.find(r => r.mod === m);
            if (hit) out.push(hit);
        }
    }
    return out;
}

function ruleName(r: PaletteRule): string {
    return r.mod ? `${r.type}.${r.mod}` : r.type;
}

// ---- package.json semantic-token rules --------------------------------------

interface SemanticTokenRule { foreground: string; italic?: boolean; bold?: boolean; }

function generatePackageJsonRules(rules: PaletteRule[], light: boolean): Record<string, SemanticTokenRule> {
    const out: Record<string, SemanticTokenRule> = {};
    for (const r of orderedRules(rules)) {
        const rule: SemanticTokenRule = { foreground: light ? r.fgLight : r.fg };
        if (r.italic) rule.italic = true;
        if (r.bold) rule.bold = true;
        out[ruleName(r)] = rule;
    }
    return out;
}

interface TextMateRule { scope: string; settings: { foreground: string; fontStyle?: string }; }

function generateTextMateRules(rules: PaletteRule[], light: boolean): TextMateRule[] {
    const out: TextMateRule[] = [];
    for (const r of orderedRules(rules)) {
        const scope = TEXTMATE_SCOPE[r.class];
        if (!scope) continue;
        const settings: TextMateRule['settings'] = { foreground: light ? r.fgLight : r.fg };
        const style = [r.bold ? 'bold' : '', r.italic ? 'italic' : ''].filter(Boolean).join(' ');
        if (style) settings.fontStyle = style;
        out.push({ scope, settings });
    }
    return out;
}

function rewritePackageJson(rules: PaletteRule[]): string {
    const pkg = JSON.parse(fs.readFileSync(PKG_PATH, 'utf8'));
    const defaults = pkg.contributes.configurationDefaults;
    defaults['editor.semanticTokenColorCustomizations'] = {
        rules: generatePackageJsonRules(rules, false),
        [LIGHT_THEMES]: { rules: generatePackageJsonRules(rules, true) },
    };
    defaults['editor.tokenColorCustomizations'] = {
        textMateRules: generateTextMateRules(rules, false),
        [LIGHT_THEMES]: { textMateRules: generateTextMateRules(rules, true) },
    };
    return JSON.stringify(pkg, null, 2) + '\n';
}

// ---- media/ipm-preview.css --------------------------------------------------

function generateCssBlock(rules: PaletteRule[]): string {
    const ordered = orderedRules(rules);
    const lines: string[] = [CSS_GEN_START];
    const widest = Math.max(...ordered.map(r => ('ipm-' + r.class).length));
    for (const r of ordered) {
        const cls = '.ipm-' + r.class;
        const pad = ' '.repeat(Math.max(1, widest + 2 - cls.length));
        const decls: string[] = [`color: ${r.fg};`];
        if (r.italic) decls.push('font-style: italic;');
        if (r.bold) decls.push('font-weight: bold;');
        lines.push(`${cls}${pad}{ ${decls.join(' ')} }`);
    }
    // Light themes: VS Code puts vscode-light / vscode-high-contrast-light on
    // the preview body.
    for (const r of ordered) {
        const cls = '.ipm-' + r.class;
        lines.push(`.vscode-light ${cls}, .vscode-high-contrast-light ${cls} { color: ${r.fgLight}; }`);
    }
    lines.push(CSS_GEN_END);
    return lines.join('\n');
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function rewriteCss(rules: PaletteRule[]): string {
    const existing = fs.existsSync(CSS_PATH) ? fs.readFileSync(CSS_PATH, 'utf8') : '';
    const block = generateCssBlock(rules);
    if (existing.includes(CSS_GEN_START) && existing.includes(CSS_GEN_END)) {
        const re = new RegExp(`${escapeRe(CSS_GEN_START)}[\\s\\S]*?${escapeRe(CSS_GEN_END)}`, 'g');
        return existing.replace(re, block);
    }
    return buildFreshCss(block);
}

function buildFreshCss(genBlock: string): string {
    return `/* Syntax highlighting for \`\`\`ipmt\`\`\` blocks in the VS Code markdown
 * preview. Colors MIRROR the editor-side
 * \`editor.semanticTokenColorCustomizations\` defaults in package.json so
 * both panes use the exact same palette.
 *
 * The token color rules below are GENERATED from the palette source of
 * truth (${PALETTE_JSON_REL}) by scripts/gen-palette.ts. Edit the palette
 * there and run \`npm run gen-palette\` — do not hand-edit between the GEN
 * markers.
 *
 * The non-generated rules (\`pre.ipmt-block\` background etc.) are
 * preserved across generator runs.
 */

/* Match the editor pane's background + default foreground for ipmt
 * code blocks. Sourcing from VS Code's CSS variables keeps the match
 * across themes and theme switches. */
pre.ipmt-block {
    background: var(--vscode-editor-background);
    color: var(--vscode-editor-foreground);
}
pre.ipmt-block > code.language-ipmt {
    background: transparent;
    color: inherit;
}

/* Inline ipmt (\`<!--ipmt-->\` + backtick code span in prose): drop the
 * inline-code grey background so simultaneous contrast doesn't shift
 * the per-token colors away from how the same tokens look in the
 * editor pane / fenced blocks. */
code.language-ipmt {
    background: transparent;
    padding: 0;
    border-radius: 0;
}

${genBlock}
`;
}

// ---- src/palette.gen.ts (data module consumed by src/palette.ts) ------------

function tsStyle(r: PaletteRule): string {
    const parts = [`fg: '${r.fg}'`, `fgLight: '${r.fgLight}'`];
    if (r.italic) parts.push('italic: true');
    if (r.bold) parts.push('bold: true');
    return `{ ${parts.join(', ')} }`;
}

function generatePaletteGen(rules: PaletteRule[]): string {
    const types: string[] = [];
    const byType = new Map<string, PaletteRule[]>();
    for (const r of rules) {
        if (!byType.has(r.type)) { byType.set(r.type, []); types.push(r.type); }
        byType.get(r.type)!.push(r);
    }

    const L: string[] = [];
    L.push(`// Code generated from ${PALETTE_JSON_REL} by scripts/gen-palette.ts — DO NOT EDIT.`);
    L.push('// The source of truth for the ipmt palette lives in the ipm-tools repo.');
    L.push('// Run `npm run gen-palette` to regenerate. Hand-written helpers that');
    L.push('// consume this data live in ./palette.ts.');
    L.push('');
    L.push('export interface TokenStyle {');
    L.push('    fg: string; // dark themes, hex `#rrggbb`, lowercase');
    L.push('    fgLight: string; // light themes');
    L.push('    italic?: boolean;');
    L.push('    bold?: boolean;');
    L.push('}');
    L.push('');
    L.push('export interface TokenEntry {');
    L.push('    base: TokenStyle;');
    for (const m of MOD_ORDER) L.push(`    ${m}?: TokenStyle;`);
    L.push('}');
    L.push('');
    L.push(`export const MODIFIER_NAMES = [${MOD_ORDER.map(m => `'${m}'`).join(', ')}] as const;`);
    L.push('export type ModifierName = (typeof MODIFIER_NAMES)[number];');
    L.push('');
    L.push('// PALETTE keys match the semanticTokenTypes in');
    L.push('// ../ipm-tools/pkg/ipmtokens/tokens.go.');
    L.push('export const PALETTE: Record<string, TokenEntry> = {');
    for (const t of types) {
        const group = byType.get(t)!;
        const base = group.find(r => !r.mod)!;
        const fields = [`base: ${tsStyle(base)}`];
        for (const m of MOD_ORDER) {
            const hit = group.find(r => r.mod === m);
            if (hit) fields.push(`${m}: ${tsStyle(hit)}`);
        }
        L.push(`    ${t}: { ${fields.join(', ')} },`);
    }
    L.push('};');
    L.push('');
    L.push('// CLASS_SUFFIX maps a dotted rule name (`ipmEvent.alias`) or a bare type');
    L.push('// to its `ipm-<suffix>` CSS class suffix.');
    L.push('export const CLASS_SUFFIX: Record<string, string> = {');
    for (const r of orderedRules(rules)) {
        L.push(`    '${ruleName(r)}': '${r.class}',`);
    }
    L.push('};');
    L.push('');
    return L.join('\n');
}

// ---- driver -----------------------------------------------------------------

interface GeneratedContent { pkg: string; css: string; paletteGen: string; }

export function generateAll(): GeneratedContent {
    const rules = loadRules();
    return {
        pkg: rewritePackageJson(rules),
        css: rewriteCss(rules),
        paletteGen: generatePaletteGen(rules),
    };
}

function main(): void {
    const mode = process.argv[2] === '--check' ? 'check' : 'write';
    const gen = generateAll();
    const targets: Array<[string, string]> = [
        [PKG_PATH, gen.pkg],
        [CSS_PATH, gen.css],
        [PALETTE_GEN_PATH, gen.paletteGen],
    ];
    if (mode === 'check') {
        let drift = false;
        for (const [p, want] of targets) {
            const have = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
            if (have !== want) {
                drift = true;
                console.error(`drift: ${path.relative(ROOT, p)} differs from ${PALETTE_JSON_REL}`);
            }
        }
        if (drift) {
            console.error('run `npm run gen-palette` to regenerate');
            process.exit(1);
        }
        console.log('palette files are up to date');
        return;
    }
    for (const [p, content] of targets) {
        fs.writeFileSync(p, content);
        console.log('wrote', path.relative(ROOT, p));
    }
}

if (require.main === module) main();
