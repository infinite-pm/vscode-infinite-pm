// Code generated from ../ipm-tools/pkg/ipmtokens/palette.json by scripts/gen-palette.ts — DO NOT EDIT.
// The source of truth for the ipmt palette lives in the ipm-tools repo.
// Run `npm run gen-palette` to regenerate. Hand-written helpers that
// consume this data live in ./palette.ts.

export interface TokenStyle {
    fg: string; // dark themes, hex `#rrggbb`, lowercase
    fgLight: string; // light themes
    italic?: boolean;
    bold?: boolean;
}

export interface TokenEntry {
    base: TokenStyle;
    alias?: TokenStyle;
    hasAlias?: TokenStyle;
    leadsTo?: TokenStyle;
    partOf?: TokenStyle;
    expresses?: TokenStyle;
    nearTo?: TokenStyle;
    marker?: TokenStyle;
}

export const MODIFIER_NAMES = ['alias', 'hasAlias', 'leadsTo', 'partOf', 'expresses', 'nearTo', 'marker'] as const;
export type ModifierName = (typeof MODIFIER_NAMES)[number];

// PALETTE keys match the semanticTokenTypes in
// ../ipm-tools/pkg/ipmtokens/tokens.go.
export const PALETTE: Record<string, TokenEntry> = {
    ipmEvent: { base: { fg: '#ff8000', fgLight: '#a65300' }, alias: { fg: '#ff8000', fgLight: '#a65300' }, hasAlias: { fg: '#ffaa55', fgLight: '#b35900' }, marker: { fg: '#ff8000', fgLight: '#a65300', bold: true } },
    ipmThing: { base: { fg: '#6fc24f', fgLight: '#2d6e1f' }, alias: { fg: '#6fc24f', fgLight: '#2d6e1f' }, hasAlias: { fg: '#82b366', fgLight: '#3c7a2a' }, marker: { fg: '#6fc24f', fgLight: '#2d6e1f', bold: true } },
    ipmConcept: { base: { fg: '#6c8ebf', fgLight: '#1a5f9e' }, alias: { fg: '#6c8ebf', fgLight: '#1a5f9e' }, hasAlias: { fg: '#9bb4d6', fgLight: '#2877bd' }, marker: { fg: '#6c8ebf', fgLight: '#1a5f9e', bold: true } },
    ipmArrow: { base: { fg: '#d4d4d4', fgLight: '#404040', bold: true }, leadsTo: { fg: '#ff8000', fgLight: '#a65300', bold: true }, partOf: { fg: '#6fc24f', fgLight: '#2d6e1f', bold: true }, expresses: { fg: '#6c8ebf', fgLight: '#1a5f9e', bold: true }, nearTo: { fg: '#aaaaaa', fgLight: '#6b6b6b', bold: true } },
    ipmTypeMarker: { base: { fg: '#b08fff', fgLight: '#7e57c2' } },
    ipmRelation: { base: { fg: '#b08fff', fgLight: '#7e57c2' } },
    ipmComment: { base: { fg: '#8c8c8c', fgLight: '#6b6b6b', italic: true } },
    ipmString: { base: { fg: '#ce9178', fgLight: '#a31515' } },
    ipmTooltip: { base: { fg: '#b58900', fgLight: '#8a6d00', italic: true } },
    ipmUnresolved: { base: { fg: '#8a8a8a', fgLight: '#767676' } },
};

// CLASS_SUFFIX maps a dotted rule name (`ipmEvent.alias`) or a bare type
// to its `ipm-<suffix>` CSS class suffix.
export const CLASS_SUFFIX: Record<string, string> = {
    'ipmEvent': 'e-title',
    'ipmEvent.alias': 'e-alias',
    'ipmEvent.hasAlias': 'e-title-aliased',
    'ipmEvent.marker': 'e-marker',
    'ipmThing': 't-title',
    'ipmThing.alias': 't-alias',
    'ipmThing.hasAlias': 't-title-aliased',
    'ipmThing.marker': 't-marker',
    'ipmConcept': 'c-title',
    'ipmConcept.alias': 'c-alias',
    'ipmConcept.hasAlias': 'c-title-aliased',
    'ipmConcept.marker': 'c-marker',
    'ipmArrow': 'arrow',
    'ipmArrow.leadsTo': 'L',
    'ipmArrow.partOf': 'P',
    'ipmArrow.expresses': 'X',
    'ipmArrow.nearTo': 'N',
    'ipmTypeMarker': 'type-marker',
    'ipmRelation': 'relation',
    'ipmComment': 'comment',
    'ipmString': 'string',
    'ipmTooltip': 'tooltip',
    'ipmUnresolved': 'unresolved',
};
