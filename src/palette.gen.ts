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
    ipmEvent: { base: { fg: '#ff8000', fgLight: '#ff8000' }, alias: { fg: '#ffaa55', fgLight: '#ffaa55' }, hasAlias: { fg: '#ff8000', fgLight: '#ff8000' }, marker: { fg: '#ff8000', fgLight: '#ff8000', bold: true } },
    ipmThing: { base: { fg: '#6fc24f', fgLight: '#4d8a3a' }, alias: { fg: '#82b366', fgLight: '#82b366' }, hasAlias: { fg: '#6fc24f', fgLight: '#4d8a3a' }, marker: { fg: '#6fc24f', fgLight: '#4d8a3a', bold: true } },
    ipmConcept: { base: { fg: '#6c8ebf', fgLight: '#6c8ebf' }, alias: { fg: '#9bb4d6', fgLight: '#7f9dc9' }, hasAlias: { fg: '#6c8ebf', fgLight: '#6c8ebf' }, marker: { fg: '#6c8ebf', fgLight: '#6c8ebf', bold: true } },
    ipmArrow: { base: { fg: '#d4d4d4', fgLight: '#404040', bold: true }, leadsTo: { fg: '#ff8000', fgLight: '#ff8000', bold: true }, partOf: { fg: '#6fc24f', fgLight: '#4d8a3a', bold: true }, expresses: { fg: '#6c8ebf', fgLight: '#6c8ebf', bold: true }, nearTo: { fg: '#aaaaaa', fgLight: '#aaaaaa', bold: true } },
    ipmTypeMarker: { base: { fg: '#b08fff', fgLight: '#b08fff' } },
    ipmRelation: { base: { fg: '#b08fff', fgLight: '#b08fff' } },
    ipmComment: { base: { fg: '#8c8c8c', fgLight: '#808080', italic: true } },
    ipmString: { base: { fg: '#ce9178', fgLight: '#ce9178' } },
    ipmTooltip: { base: { fg: '#b58900', fgLight: '#b58900', italic: true } },
    ipmUnresolved: { base: { fg: '#8a8a8a', fgLight: '#8a8a8a' } },
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
