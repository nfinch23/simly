import { describe, expect, it } from 'vitest';
import {
  applyComboToLoadout,
  buildBreakpointDiagnostics,
  buildBreakpointScript,
  generateCombos,
  loadoutToBestLoadoutSlots,
  predictComboScore,
  prioritizeCombos,
  type BreakpointCombo,
} from './breakpoint-search';
import type { ParsedItem, SlotName } from '../simc-export-parser';
import type { StatWeightsLike } from './pruner-diagnostic';

function makeItem(
  slot: SlotName,
  identity: string,
  ilvl = 270,
  raw_stats?: NonNullable<ParsedItem['raw_stats']>,
): ParsedItem {
  return {
    slot,
    item_id: 1,
    name: `Item ${identity}`,
    ilvl,
    bonus_ids: [],
    is_equipped: false,
    identity,
    extras: {},
    raw_stats,
  };
}

/** Helper for weapon items — carries the `simly_equip_loc` extras
 *  that classifyWeapon / canPairAsOH / locksOffHand check.
 */
function makeWeapon(opts: {
  slot: 'main_hand' | 'off_hand';
  identity: string;
  equipLoc: string;
  ilvl?: number;
  raw_stats?: NonNullable<ParsedItem['raw_stats']>;
}): ParsedItem {
  return {
    slot: opts.slot,
    item_id: 1,
    name: `Item ${opts.identity}`,
    ilvl: opts.ilvl ?? 270,
    bonus_ids: [],
    is_equipped: false,
    identity: opts.identity,
    extras: { simly_equip_loc: opts.equipLoc },
    raw_stats: opts.raw_stats,
  };
}

function rawStats(over: Partial<NonNullable<ParsedItem['raw_stats']>> = {}): NonNullable<ParsedItem['raw_stats']> {
  return {
    intellect: 0,
    strength: 0,
    agility: 0,
    haste_rating: 0,
    crit_rating: 0,
    mastery_rating: 0,
    versatility_rating: 0,
    ...over,
  };
}

describe('generateCombos', () => {
  it('returns no combos for empty input', () => {
    expect(generateCombos([])).toEqual([]);
  });

  it('returns no combos for a single item (need at least 2)', () => {
    expect(generateCombos([makeItem('chest', 'A')])).toEqual([]);
  });

  it('generates a single 2-item combo for two different-slot items', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('legs', 'B'),
    ]);
    // Pair only (only 2 items so no triples possible).
    expect(combos).toHaveLength(1);
    expect(combos[0]!.id).toMatch(/^bp2_/);
    expect(combos[0]!.swaps).toEqual({
      chest: expect.objectContaining({ identity: 'A' }),
      legs: expect.objectContaining({ identity: 'B' }),
    });
  });

  it('rejects same-slot pairs for non-paired slots', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('chest', 'B'),
    ]);
    expect(combos).toEqual([]);
  });

  it('allows ring pairs to occupy finger1 + finger2', () => {
    const combos = generateCombos([
      makeItem('finger1', 'A'),
      makeItem('finger2', 'B'),
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.swaps).toHaveProperty('finger1');
    expect(combos[0]!.swaps).toHaveProperty('finger2');
  });

  it('allows trinket pairs to occupy trinket1 + trinket2', () => {
    const combos = generateCombos([
      makeItem('trinket1', 'A'),
      makeItem('trinket1', 'B'),
    ]);
    expect(combos).toHaveLength(1);
    expect(combos[0]!.swaps).toHaveProperty('trinket1');
    expect(combos[0]!.swaps).toHaveProperty('trinket2');
  });

  it('generates pairs AND triples for 3 different-slot items', () => {
    const combos = generateCombos([
      makeItem('chest', 'A'),
      makeItem('legs', 'B'),
      makeItem('hands', 'C'),
    ]);
    // C(3,2)=3 pairs + C(3,3)=1 triple = 4 total
    expect(combos.filter((c) => c.id.startsWith('bp2_'))).toHaveLength(3);
    expect(combos.filter((c) => c.id.startsWith('bp3_'))).toHaveLength(1);
  });

  it('produces deterministic combo ids regardless of input order', () => {
    const a = makeItem('chest', 'A');
    const b = makeItem('legs', 'B');
    const c1 = generateCombos([a, b]);
    const c2 = generateCombos([b, a]);
    expect(c1[0]!.id).toBe(c2[0]!.id);
  });

  it('skips triples when rejected pool size > 15', () => {
    const items: ParsedItem[] = [];
    // 16 items in different slots — 16 > MAX_REJECTED_FOR_TRIPLES (15)
    const slots: SlotName[] = [
      'head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist',
      'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2', 'main_hand', 'off_hand',
    ];
    for (let i = 0; i < 16; i++) items.push(makeItem(slots[i]!, `id${i}`));
    const combos = generateCombos(items);
    // Should only have pairs.
    expect(combos.every((c) => c.id.startsWith('bp2_'))).toBe(true);
  });
});

describe('generateCombos (weapon-aware)', () => {
  it('pairs a non-weapon with a 1H main_hand by carrying the converged off_hand', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeWeapon({ slot: 'main_hand', identity: 'NEW_MH', equipLoc: 'INVTYPE_WEAPON' }),
      ],
      converged,
    );
    expect(combos).toHaveLength(1);
    const swaps = combos[0]!.swaps;
    expect(swaps['chest']!.identity).toBe('NEW_C');
    expect(swaps['main_hand']!.identity).toBe('NEW_MH');
    // OH carried from converged so the profileset reflects the real 1H+OH context.
    expect(swaps['off_hand']!.identity).toBe('EQ_OH');
    expect(combos[0]!.clearOffHand).toBeUndefined();
  });

  it('pairs a non-weapon with a 2H main_hand by setting clearOffHand', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeWeapon({ slot: 'main_hand', identity: 'NEW_2H', equipLoc: 'INVTYPE_2HWEAPON' }),
      ],
      converged,
    );
    expect(combos).toHaveLength(1);
    expect(combos[0]!.clearOffHand).toBe(true);
    expect(combos[0]!.swaps['main_hand']!.identity).toBe('NEW_2H');
    expect(combos[0]!.swaps['off_hand']).toBeUndefined();
  });

  it('pairs a non-weapon with a pure off_hand by carrying the converged main_hand context', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeWeapon({ slot: 'off_hand', identity: 'NEW_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      ],
      converged,
    );
    expect(combos).toHaveLength(1);
    expect(combos[0]!.swaps['off_hand']!.identity).toBe('NEW_OH');
    expect(combos[0]!.swaps['main_hand']).toBeUndefined(); // MH stays in converged
  });

  it('drops 1H main_hand combos when the converged off_hand is missing or not OH-eligible', () => {
    // converged has no off_hand → 1H MH can't be paired.
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeWeapon({ slot: 'main_hand', identity: 'NEW_1H', equipLoc: 'INVTYPE_WEAPON' }),
      ],
      converged,
    );
    expect(combos).toEqual([]);
  });

  it('drops pure-OH combos when the converged main_hand is a 2H (slot locked out)', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_2H', equipLoc: 'INVTYPE_2HWEAPON' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeWeapon({ slot: 'off_hand', identity: 'NEW_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      ],
      converged,
    );
    expect(combos).toEqual([]);
  });

  it('drops combos containing two weapon items (v1 scope — defer multi-weapon combos)', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
    };
    const combos = generateCombos(
      [
        makeWeapon({ slot: 'main_hand', identity: 'NEW_MH', equipLoc: 'INVTYPE_WEAPON' }),
        makeWeapon({ slot: 'off_hand', identity: 'NEW_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      ],
      converged,
    );
    expect(combos).toEqual([]);
  });

  it('generates a triple combining 2 non-weapons + a 1H MH (with paired OH)', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
    };
    const combos = generateCombos(
      [
        makeItem('chest', 'NEW_C'),
        makeItem('legs', 'NEW_L'),
        makeWeapon({ slot: 'main_hand', identity: 'NEW_MH', equipLoc: 'INVTYPE_WEAPON' }),
      ],
      converged,
    );
    // pairs: (chest, legs), (chest, mh), (legs, mh) + triple = 4 combos
    expect(combos.filter((c) => c.id.startsWith('bp3_'))).toHaveLength(1);
    const triple = combos.find((c) => c.id.startsWith('bp3_'))!;
    expect(triple.swaps['chest']!.identity).toBe('NEW_C');
    expect(triple.swaps['legs']!.identity).toBe('NEW_L');
    expect(triple.swaps['main_hand']!.identity).toBe('NEW_MH');
    expect(triple.swaps['off_hand']!.identity).toBe('EQ_OH'); // carried from converged
  });

  it('omits weapon combos entirely when converged is not provided (backward-compat default {})', () => {
    // No converged → weapons can't be paired → only non-weapon-only combos remain.
    const combos = generateCombos([
      makeItem('chest', 'NEW_C'),
      makeWeapon({ slot: 'main_hand', identity: 'NEW_MH', equipLoc: 'INVTYPE_WEAPON' }),
    ]);
    expect(combos).toEqual([]);
  });
});

describe('applyComboToLoadout', () => {
  it('applies the combo swaps to the loadout', () => {
    const loadout: Record<string, ParsedItem> = {
      chest: makeItem('chest', 'EQ_C', 270),
      legs: makeItem('legs', 'EQ_L', 270),
      hands: makeItem('hands', 'EQ_G', 270),
    };
    const combo = {
      id: 'bp2_xyz',
      swaps: {
        chest: makeItem('chest', 'NEW_C', 280),
        legs: makeItem('legs', 'NEW_L', 285),
      },
    };
    const out = applyComboToLoadout(loadout, combo);
    expect(out['chest']!.identity).toBe('NEW_C');
    expect(out['legs']!.identity).toBe('NEW_L');
    expect(out['hands']!.identity).toBe('EQ_G'); // untouched
  });

  it('does not mutate the input loadout', () => {
    const loadout: Record<string, ParsedItem> = {
      chest: makeItem('chest', 'EQ_C'),
    };
    const combo = {
      id: 'bp_x',
      swaps: { chest: makeItem('chest', 'NEW') },
    };
    applyComboToLoadout(loadout, combo);
    expect(loadout['chest']!.identity).toBe('EQ_C');
  });

  it('deletes off_hand from the result when clearOffHand is set (2H combo)', () => {
    const loadout: Record<string, ParsedItem> = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      chest: makeItem('chest', 'EQ_C'),
    };
    const combo = {
      id: 'bp2_2h',
      swaps: {
        main_hand: makeWeapon({ slot: 'main_hand', identity: 'NEW_2H', equipLoc: 'INVTYPE_2HWEAPON' }),
        chest: makeItem('chest', 'NEW_C'),
      },
      clearOffHand: true,
    };
    const out = applyComboToLoadout(loadout, combo);
    expect(out['main_hand']!.identity).toBe('NEW_2H');
    expect(out['chest']!.identity).toBe('NEW_C');
    expect(out['off_hand']).toBeUndefined();
  });
});

describe('buildBreakpointScript (weapon-aware)', () => {
  it('emits an empty `off_hand=` line for clearOffHand combos (2H lockout)', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      chest: makeItem('chest', 'EQ_C'),
    };
    const combos: BreakpointCombo[] = [{
      id: 'bp_2h',
      swaps: {
        main_hand: makeWeapon({ slot: 'main_hand', identity: 'NEW_2H', equipLoc: 'INVTYPE_2HWEAPON' }),
      },
      clearOffHand: true,
    }];
    const out = buildBreakpointScript(converged, combos);
    expect(out.script).toContain('profileset."bp_2h"+="off_hand="');
    // The "real" off_hand line (with EQ_OH) must NOT be emitted for this combo.
    expect(out.script).not.toMatch(/profileset\."bp_2h"\+=".*off_hand.*EQ_OH/);
  });

  it('emits both main_hand and off_hand lines for a 1H+paired-OH combo', () => {
    const converged = {
      main_hand: makeWeapon({ slot: 'main_hand', identity: 'EQ_MH', equipLoc: 'INVTYPE_WEAPON' }),
      off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      chest: makeItem('chest', 'EQ_C'),
    };
    const combos: BreakpointCombo[] = [{
      id: 'bp_1h',
      swaps: {
        main_hand: makeWeapon({ slot: 'main_hand', identity: 'NEW_1H', equipLoc: 'INVTYPE_WEAPON' }),
        off_hand: makeWeapon({ slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE' }),
      },
    }];
    const out = buildBreakpointScript(converged, combos);
    expect(out.script).toMatch(/profileset\."bp_1h"\+=".*main_hand.*"/);
    expect(out.script).toMatch(/profileset\."bp_1h"\+=".*off_hand.*"/);
    // No bare clear line.
    expect(out.script).not.toContain('profileset."bp_1h"+="off_hand="');
  });
});

describe('buildBreakpointDiagnostics', () => {
  // Helpers to assemble the shape buildBreakpointDiagnostics expects:
  // a list of { combo, mean_dps, delta_pct } entries from a parsed sim,
  // plus a converged baseline loadout.
  function makeComboEntry(swaps: BreakpointCombo['swaps'], mean_dps: number, baseline_dps: number) {
    const id = `bp_${Object.keys(swaps).sort().join('+')}`;
    const delta_pct = ((mean_dps - baseline_dps) / baseline_dps) * 100;
    return { combo: { id, swaps }, mean_dps, delta_pct };
  }

  const WEIGHTS: StatWeightsLike = { intellect: 5, haste: 1.2 };

  it('emits stat-vector diagnostic when weights + raw_stats are present everywhere', () => {
    const baseline_dps = 100_000;
    const inc = makeItem('chest', 'EQ_C', 270, rawStats({ intellect: 100, haste_rating: 50 }));
    const cand = makeItem('chest', 'NEW_C', 280, rawStats({ intellect: 150, haste_rating: 80 }));
    const incL = makeItem('legs', 'EQ_L', 270, rawStats({ intellect: 100, haste_rating: 0 }));
    const candL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 140, haste_rating: 30 }));
    const entry = makeComboEntry({ chest: cand, legs: candL }, 102_000, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entry],
      baseline_dps,
      winnerId: undefined,
      converged: { chest: inc, legs: incL },
      weights: WEIGHTS,
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags).toHaveLength(1);
    expect(diags[0]!.predicted_pct_stat_vector).toBeDefined();
    expect(diags[0]!.unexplained_pp).toBeDefined();
    // Stat-vector prediction: (50+40)*5 + (30+30)*1.2 = 450 + 72 = 522 dps → +0.522pp
    expect(diags[0]!.predicted_delta_dps_stat_vector).toBeCloseTo(522, 0);
    // actual = +2000 dps = +2pp; unexplained_pp = actual - stat_vector = +2 - +0.522 ≈ +1.478
    expect(diags[0]!.unexplained_pp).toBeCloseTo(1.478, 2);
    expect(diags[0]!.outcome).toBe('accepted');
    expect(diags[0]!.label).toContain('breakpoint pair');
  });

  it('falls back to ilvl-proxy when weights are not provided', () => {
    const baseline_dps = 100_000;
    const inc = makeItem('chest', 'EQ_C', 270, rawStats({ intellect: 100 }));
    const cand = makeItem('chest', 'NEW_C', 280, rawStats({ intellect: 150 }));
    const incL = makeItem('legs', 'EQ_L', 270, rawStats({ intellect: 100 }));
    const candL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 140 }));
    const entry = makeComboEntry({ chest: cand, legs: candL }, 102_000, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entry],
      baseline_dps,
      winnerId: undefined,
      converged: { chest: inc, legs: incL },
      // weights omitted on purpose
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags[0]!.predicted_pct_stat_vector).toBeUndefined();
    expect(diags[0]!.unexplained_pp).toBeUndefined();
    // ilvl proxy: total_ilvl_delta=20, predicted_pct=6%, predicted_delta_dps=6000
    expect(diags[0]!.predicted_delta_dps).toBeCloseTo(6_000, 0);
  });

  it('falls back to ilvl-proxy when any candidate is missing raw_stats', () => {
    const baseline_dps = 100_000;
    const inc = makeItem('chest', 'EQ_C', 270, rawStats({ intellect: 100 }));
    const cand = makeItem('chest', 'NEW_C', 280); // no raw_stats
    const incL = makeItem('legs', 'EQ_L', 270, rawStats({ intellect: 100 }));
    const candL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 140 }));
    const entry = makeComboEntry({ chest: cand, legs: candL }, 102_000, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entry],
      baseline_dps,
      winnerId: undefined,
      converged: { chest: inc, legs: incL },
      weights: WEIGHTS,
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags[0]!.predicted_pct_stat_vector).toBeUndefined();
  });

  it('falls back to ilvl-proxy when any incumbent is missing raw_stats', () => {
    const baseline_dps = 100_000;
    const inc = makeItem('chest', 'EQ_C', 270); // no raw_stats
    const cand = makeItem('chest', 'NEW_C', 280, rawStats({ intellect: 150 }));
    const incL = makeItem('legs', 'EQ_L', 270, rawStats({ intellect: 100 }));
    const candL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 140 }));
    const entry = makeComboEntry({ chest: cand, legs: candL }, 102_000, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entry],
      baseline_dps,
      winnerId: undefined,
      converged: { chest: inc, legs: incL },
      weights: WEIGHTS,
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags[0]!.predicted_pct_stat_vector).toBeUndefined();
  });

  it('decides per-combo: mixed batch keeps stat-vector where available, ilvl elsewhere', () => {
    const baseline_dps = 100_000;
    // Combo A: full raw_stats coverage → stat-vector
    const incA = makeItem('chest', 'EQ_C', 270, rawStats({ intellect: 100 }));
    const candA = makeItem('chest', 'NEW_C', 280, rawStats({ intellect: 150 }));
    const incAL = makeItem('legs', 'EQ_L', 270, rawStats({ intellect: 100 }));
    const candAL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 140 }));
    // Combo B: missing raw_stats on one item → ilvl proxy
    const candB = makeItem('hands', 'NEW_H', 280); // no raw_stats
    const incB = makeItem('hands', 'EQ_H', 270, rawStats({ intellect: 100 }));

    const entryA = makeComboEntry({ chest: candA, legs: candAL }, 102_000, baseline_dps);
    const entryB = makeComboEntry({ hands: candB }, 101_500, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entryA, entryB],
      baseline_dps,
      winnerId: undefined,
      converged: { chest: incA, legs: incAL, hands: incB },
      weights: WEIGHTS,
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags).toHaveLength(2);
    expect(diags[0]!.predicted_pct_stat_vector).toBeDefined(); // A: stat-vector
    expect(diags[1]!.predicted_pct_stat_vector).toBeUndefined(); // B: ilvl proxy
  });

  it('marks the winning combo with outcome=winner', () => {
    const baseline_dps = 100_000;
    const incA = makeItem('chest', 'EQ_C', 270, rawStats());
    const candA = makeItem('chest', 'NEW_C', 280, rawStats({ intellect: 100 }));
    const incAL = makeItem('legs', 'EQ_L', 270, rawStats());
    const candAL = makeItem('legs', 'NEW_L', 280, rawStats({ intellect: 80 }));
    const entry = makeComboEntry({ chest: candA, legs: candAL }, 102_000, baseline_dps);

    const diags = buildBreakpointDiagnostics({
      combos: [entry],
      baseline_dps,
      winnerId: entry.combo.id,
      converged: { chest: incA, legs: incAL },
      weights: WEIGHTS,
      dpsPerIlvlPct: 0.3,
      tieWindowPct: 0.1,
    });

    expect(diags[0]!.outcome).toBe('winner');
  });
});

describe('loadoutToBestLoadoutSlots', () => {
  it('converts ParsedItem map to BestLoadoutSlot map', () => {
    const loadout = {
      chest: makeItem('chest', 'A', 280),
    };
    const out = loadoutToBestLoadoutSlots(loadout);
    expect(out['chest']).toEqual({
      slot: 'chest',
      item_id: 1,
      name: 'Item A',
      identity: 'A',
      ilvl: 280,
    });
  });
});

describe('predictComboScore', () => {
  const weights: StatWeightsLike = {
    intellect: 1,
    haste: 1,
    crit: 1,
    mastery: 1,
    versatility: 1,
  };

  it('returns stat-vector delta when every item has raw_stats and weights are given', () => {
    const converged = {
      chest: makeItem('chest', 'CHEST_OLD', 270, rawStats({ intellect: 100 })),
      legs: makeItem('legs', 'LEGS_OLD', 270, rawStats({ intellect: 100 })),
    };
    const combo: BreakpointCombo = {
      id: 'bp2_test',
      swaps: {
        chest: makeItem('chest', 'CHEST_NEW', 280, rawStats({ intellect: 150 })),
        legs: makeItem('legs', 'LEGS_NEW', 280, rawStats({ intellect: 120 })),
      },
    };
    const score = predictComboScore({
      combo, converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    // Stat-vector delta = (150 + 120) - (100 + 100) = 70 int × 1 dps_per_int.
    expect(score).toBeCloseTo(70, 6);
  });

  it('falls back to ilvl-proxy when any item is missing raw_stats', () => {
    const converged = {
      chest: makeItem('chest', 'CHEST_OLD', 270, rawStats({ intellect: 100 })),
    };
    const combo: BreakpointCombo = {
      id: 'bp1_test',
      swaps: {
        // No raw_stats on candidate → must fall back.
        chest: makeItem('chest', 'CHEST_NEW', 280),
      },
    };
    const score = predictComboScore({
      combo, converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    // Ilvl-proxy: +10 ilvl × 0.05% × 100k = 500.
    expect(score).toBeCloseTo(500, 6);
  });

  it('falls back to ilvl-proxy when weights are not given', () => {
    const converged = {
      chest: makeItem('chest', 'CHEST_OLD', 270, rawStats({ intellect: 100 })),
    };
    const combo: BreakpointCombo = {
      id: 'bp1_test',
      swaps: {
        chest: makeItem('chest', 'CHEST_NEW', 280, rawStats({ intellect: 150 })),
      },
    };
    const score = predictComboScore({
      combo, converged, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    expect(score).toBeCloseTo(500, 6);
  });

  it('subtracts the converged off_hand stats when clearOffHand is set (2H lockout)', () => {
    // Going 1H+OH (100 int + 50 int = 150) → 2H (200 int) means NET stat
    // delta of +50 int even though the 2H has more int than the 1H alone.
    const converged = {
      main_hand: makeWeapon({
        slot: 'main_hand', identity: 'EQ_1H', equipLoc: 'INVTYPE_WEAPON', ilvl: 270,
        raw_stats: rawStats({ intellect: 100 }),
      }),
      off_hand: makeWeapon({
        slot: 'off_hand', identity: 'EQ_OH', equipLoc: 'INVTYPE_HOLDABLE', ilvl: 270,
        raw_stats: rawStats({ intellect: 50 }),
      }),
    };
    const combo: BreakpointCombo = {
      id: 'bp_2h',
      swaps: {
        main_hand: makeWeapon({
          slot: 'main_hand', identity: 'NEW_2H', equipLoc: 'INVTYPE_2HWEAPON', ilvl: 280,
          raw_stats: rawStats({ intellect: 200 }),
        }),
      },
      clearOffHand: true,
    };
    const score = predictComboScore({
      combo, converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    // Candidates: [200 int]. Incumbents: [100 int (MH), 50 int (OH)] = 150 int.
    // Net delta = 200 - 150 = 50.
    expect(score).toBeCloseTo(50, 6);
  });
});

describe('prioritizeCombos', () => {
  const weights: StatWeightsLike = { intellect: 1 };

  function ringCombo(id: string, intGainPerRing: number): BreakpointCombo {
    return {
      id,
      swaps: {
        finger1: makeItem('finger1', `${id}_r1`, 280, rawStats({ intellect: intGainPerRing })),
        finger2: makeItem('finger2', `${id}_r2`, 280, rawStats({ intellect: intGainPerRing })),
      },
    };
  }

  const converged = {
    finger1: makeItem('finger1', 'F1_OLD', 270, rawStats({ intellect: 0 })),
    finger2: makeItem('finger2', 'F2_OLD', 270, rawStats({ intellect: 0 })),
  };

  it('sorts combos descending by predicted score', () => {
    const out = prioritizeCombos({
      combos: [ringCombo('weak', 5), ringCombo('strong', 100), ringCombo('mid', 50)],
      converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    expect(out.map((p) => p.combo.id)).toEqual(['strong', 'mid', 'weak']);
  });

  it('truncates to maxCombos (predicted weakest dropped first)', () => {
    const out = prioritizeCombos({
      combos: [ringCombo('weak', 5), ringCombo('strong', 100), ringCombo('mid', 50)],
      converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
      maxCombos: 2,
    });
    expect(out).toHaveLength(2);
    expect(out.map((p) => p.combo.id)).toEqual(['strong', 'mid']);
  });

  it('returns empty array when given no combos', () => {
    const out = prioritizeCombos({
      combos: [], converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    expect(out).toEqual([]);
  });

  it('annotates each returned entry with its predicted_score', () => {
    const out = prioritizeCombos({
      combos: [ringCombo('a', 10)],
      converged, weights, dpsPerIlvlPct: 0.05, baseline_dps: 100_000,
    });
    // Two ring slots, each gaining +10 int × 1 dps_per_int = 20 total.
    expect(out[0]!.predicted_score).toBeCloseTo(20, 6);
  });
});
