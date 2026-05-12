import { describe, expect, it } from 'vitest';
import { pickBestOHForMH, pickCloseOHsForMH } from './oh-pairing';
import type { ParsedItem, SlotName } from '../simc-export-parser';

function item(opts: {
  slot: SlotName;
  identity: string;
  ilvl?: number;
  equipLoc?: string;
  raw_stats?: ParsedItem['raw_stats'];
}): ParsedItem {
  const extras: Record<string, string> = {};
  if (opts.equipLoc) extras['simly_equip_loc'] = opts.equipLoc;
  return {
    slot: opts.slot,
    item_id: 1,
    name: `Item ${opts.identity}`,
    ilvl: opts.ilvl ?? 270,
    bonus_ids: [],
    is_equipped: false,
    identity: opts.identity,
    extras,
    ...(opts.raw_stats ? { raw_stats: opts.raw_stats } : {}),
  };
}

const stats = (overrides: Partial<NonNullable<ParsedItem['raw_stats']>>): NonNullable<ParsedItem['raw_stats']> => ({
  intellect: 0, strength: 0, agility: 0,
  haste_rating: 0, crit_rating: 0, mastery_rating: 0, versatility_rating: 0,
  ...overrides,
});

describe('pickBestOHForMH', () => {
  it('returns null bestOH when MH is 2H (slot locked out)', () => {
    const mh = item({
      slot: 'main_hand', identity: 'STAFF', equipLoc: 'INVTYPE_2HWEAPON',
      raw_stats: stats({ intellect: 350 }),
    });
    const oh = item({
      slot: 'off_hand', identity: 'OH1', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100 }),
    });
    const r = pickBestOHForMH({ mh, ohCandidates: [oh], weights: { intellect: 33 } });
    expect(r.bestOH).toBeNull();
    expect(r.rankedScores).toEqual([]);
  });

  it('picks the OH with highest predicted contribution among eligible candidates', () => {
    const mh = item({
      slot: 'main_hand', identity: '1H', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohLow = item({
      slot: 'off_hand', identity: 'OH_low', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100, haste_rating: 50 }),
    });
    const ohHigh = item({
      slot: 'off_hand', identity: 'OH_high', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 150, haste_rating: 100 }),
    });
    const r = pickBestOHForMH({
      mh,
      ohCandidates: [ohLow, ohHigh],
      weights: { intellect: 33, haste: 15 },
    });
    expect(r.bestOH?.identity).toBe('OH_high');
    expect(r.rankedScores).toHaveLength(2);
    expect(r.rankedScores[0]!.oh.identity).toBe('OH_high');
  });

  it('filters out non-OH-eligible items (e.g. 2H weapons accidentally in candidate list)', () => {
    const mh = item({
      slot: 'main_hand', identity: '1H', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const accidentally2H = item({
      slot: 'main_hand', identity: 'STAFF', equipLoc: 'INVTYPE_2HWEAPON',
      raw_stats: stats({ intellect: 350 }),
    });
    const validOH = item({
      slot: 'off_hand', identity: 'OH1', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100 }),
    });
    const r = pickBestOHForMH({
      mh,
      ohCandidates: [accidentally2H, validOH],
      weights: { intellect: 33 },
    });
    expect(r.bestOH?.identity).toBe('OH1');
    expect(r.rankedScores).toHaveLength(1);
  });

  it('considers 1H_DUAL items as valid OH options (dual-wield specs)', () => {
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const dualWield1H = item({
      slot: 'main_hand', identity: 'DUAL', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 180, haste_rating: 80 }),
    });
    const r = pickBestOHForMH({
      mh,
      ohCandidates: [dualWield1H],
      weights: { intellect: 33, haste: 15 },
    });
    expect(r.bestOH?.identity).toBe('DUAL');
  });

  it('returns null when no eligible OH exists', () => {
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const r = pickBestOHForMH({ mh, ohCandidates: [], weights: { intellect: 33 } });
    expect(r.bestOH).toBeNull();
  });

  it('falls back to highest-ilvl OH when none of the candidates have raw_stats', () => {
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
    });
    const ohLow = item({
      slot: 'off_hand', identity: 'OH_low', ilvl: 250, equipLoc: 'INVTYPE_HOLDABLE',
    });
    const ohHigh = item({
      slot: 'off_hand', identity: 'OH_high', ilvl: 280, equipLoc: 'INVTYPE_HOLDABLE',
    });
    const r = pickBestOHForMH({
      mh,
      ohCandidates: [ohLow, ohHigh],
      weights: { intellect: 33 },
    });
    expect(r.bestOH?.identity).toBe('OH_high');
  });
});

describe('pickCloseOHsForMH', () => {
  it('returns the single best OH when scores are decisive (top well ahead)', () => {
    // OH_high predicted_score ≈ intellect*33 + haste*15 = 150*33+100*15 = 6450
    // OH_low predicted_score ≈ 100*33+50*15 = 4050 → 37% gap, well outside 1% tie
    const mh = item({
      slot: 'main_hand', identity: '1H', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohLow = item({
      slot: 'off_hand', identity: 'OH_low', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100, haste_rating: 50 }),
    });
    const ohHigh = item({
      slot: 'off_hand', identity: 'OH_high', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 150, haste_rating: 100 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [ohLow, ohHigh],
      weights: { intellect: 33, haste: 15 },
    });
    expect(r.partners.map((p) => p.identity)).toEqual(['OH_high']);
  });

  it('returns multiple partners when their predicted scores cluster within the tie window', () => {
    // Three OHs all scoring within ~0.5% of each other; default tie 1% keeps all 3.
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohA = item({
      slot: 'off_hand', identity: 'OH_A', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100, haste_rating: 100 }),
    });
    const ohB = item({
      slot: 'off_hand', identity: 'OH_B', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 99, haste_rating: 102 }),
    });
    const ohC = item({
      slot: 'off_hand', identity: 'OH_C', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 101, haste_rating: 98 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [ohA, ohB, ohC],
      weights: { intellect: 33, haste: 15 },
    });
    expect(r.partners).toHaveLength(3);
    // Order is best-first.
    expect(r.partners[0]!.identity).toBe(r.rankedScores[0]!.oh.identity);
  });

  it('caps the partner list at maxPartners', () => {
    // Four OHs all clustered; maxPartners=2 should trim to 2.
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohs = [1, 2, 3, 4].map((i) =>
      item({
        slot: 'off_hand', identity: `OH${i}`, equipLoc: 'INVTYPE_HOLDABLE',
        raw_stats: stats({ intellect: 100 + i * 0.1 }),
      }),
    );
    const r = pickCloseOHsForMH({
      mh, ohCandidates: ohs,
      weights: { intellect: 33 },
      maxPartners: 2,
    });
    expect(r.partners).toHaveLength(2);
  });

  it('drops OHs whose predicted score falls outside the tie window', () => {
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohClose = item({
      slot: 'off_hand', identity: 'OH_close', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100 }),
    });
    const ohFar = item({
      slot: 'off_hand', identity: 'OH_far', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 50 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [ohClose, ohFar],
      weights: { intellect: 33 },
      tieWindowPct: 1.0,
    });
    expect(r.partners.map((p) => p.identity)).toEqual(['OH_close']);
  });

  it('returns no partners when MH is 2H (slot locked out)', () => {
    const mh = item({
      slot: 'main_hand', identity: 'STAFF', equipLoc: 'INVTYPE_2HWEAPON',
      raw_stats: stats({ intellect: 350 }),
    });
    const oh = item({
      slot: 'off_hand', identity: 'OH', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [oh],
      weights: { intellect: 33 },
    });
    expect(r.partners).toEqual([]);
  });

  it('returns no partners when the OH pool is empty', () => {
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [],
      weights: { intellect: 33 },
    });
    expect(r.partners).toEqual([]);
  });

  it('returns just the best when a tighter tieWindowPct excludes the rest', () => {
    // Same cluster as the "multiple partners" test, but tieWindowPct=0.01% only
    // admits the top-ranked OH.
    const mh = item({
      slot: 'main_hand', identity: 'MH', equipLoc: 'INVTYPE_WEAPON',
      raw_stats: stats({ intellect: 200 }),
    });
    const ohA = item({
      slot: 'off_hand', identity: 'OH_A', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 100, haste_rating: 100 }),
    });
    const ohB = item({
      slot: 'off_hand', identity: 'OH_B', equipLoc: 'INVTYPE_HOLDABLE',
      raw_stats: stats({ intellect: 99, haste_rating: 102 }),
    });
    const r = pickCloseOHsForMH({
      mh, ohCandidates: [ohA, ohB],
      weights: { intellect: 33, haste: 15 },
      tieWindowPct: 0.01,
    });
    expect(r.partners).toHaveLength(1);
  });
});
