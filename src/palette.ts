// Helpers over the ipmt palette. The DATA (PALETTE, CLASS_SUFFIX,
// MODIFIER_NAMES, types) is generated into ./palette.gen.ts from the source
// of truth in the ipm-tools repo (../ipm-tools/pkg/ipmtokens/palette.json) by
// scripts/gen-palette.ts. Edit the palette there and run `npm run gen-palette`;
// CI enforces the generated files stay in sync via paletteConsistency.test.ts.
//
// This file holds only the pure naming/iteration helpers — no palette data.

import { PALETTE, CLASS_SUFFIX, MODIFIER_NAMES } from './palette.gen';
import type { TokenStyle, TokenEntry, ModifierName } from './palette.gen';

export { PALETTE, CLASS_SUFFIX, MODIFIER_NAMES };
export type { TokenStyle, TokenEntry, ModifierName };

// cssClassFor returns the CSS class name (without leading `.`) for a
// (semantic-token-type, modifier) pair — `ipm-<suffix>`.
//
//   ipmEvent           → ipm-e-title
//   ipmEvent.alias     → ipm-e-alias
//   ipmArrow.leadsTo   → ipm-L
export function cssClassFor(tokenType: string, modifier?: ModifierName): string {
    if (!tokenType.startsWith('ipm')) {
        throw new Error(`unexpected token type: ${tokenType}`);
    }
    const key = modifier ? `${tokenType}.${modifier}` : tokenType;
    const suffix = CLASS_SUFFIX[key];
    if (suffix === undefined) {
        throw new Error(`no CSS class suffix for ${key}`);
    }
    return `ipm-${suffix}`;
}

// semanticTokenRuleNameFor returns the dotted name used in
// `editor.semanticTokenColorCustomizations.rules`:
//
//   (ipmEvent, undefined)   → "ipmEvent"
//   (ipmEvent, "alias")     → "ipmEvent.alias"
export function semanticTokenRuleNameFor(tokenType: string, modifier?: ModifierName): string {
    return modifier ? `${tokenType}.${modifier}` : tokenType;
}

// allRules iterates every (token-type, modifier?, style) tuple in the
// palette in a stable order (base, then MODIFIER_NAMES order).
export function allRules(): Array<{
    tokenType: string;
    modifier?: ModifierName;
    style: TokenStyle;
}> {
    const out: Array<{ tokenType: string; modifier?: ModifierName; style: TokenStyle }> = [];
    for (const [tokenType, entry] of Object.entries(PALETTE)) {
        out.push({ tokenType, style: entry.base });
        for (const mod of MODIFIER_NAMES) {
            const style = entry[mod];
            if (style) out.push({ tokenType, modifier: mod, style });
        }
    }
    return out;
}
