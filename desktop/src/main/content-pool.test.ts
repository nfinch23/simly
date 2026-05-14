import { describe, expect, it } from 'vitest';
import {
  CLASS_ID_BY_NAME,
  SPEC_ID_BY_KEY,
  getItemMeta,
  isItemRelevant,
  maxIlvlForTrack,
  resolveContentPool,
  resolveSpecId,
} from './content-pool';
import { CONTENT_PREFS_DEFAULTS, type ContentPrefs } from './settings';

describe('CLASS_ID_BY_NAME / SPEC_ID_BY_KEY', () => {
  it('maps standard class names to ids 1-13', () => {
    expect(CLASS_ID_BY_NAME.warrior).toBe(1);
    expect(CLASS_ID_BY_NAME.warlock).toBe(9);
    expect(CLASS_ID_BY_NAME.evoker).toBe(13);
  });

  it('maps common specs to Blizzard specIds', () => {
    expect(SPEC_ID_BY_KEY.demonology).toBe(266);
    expect(SPEC_ID_BY_KEY.arms).toBe(71);
    expect(SPEC_ID_BY_KEY.devastation).toBe(1467);
  });
});

describe('resolveSpecId', () => {
  it('returns the simple key for unambiguous specs', () => {
    expect(resolveSpecId('demonology', 9)).toBe(266);
    expect(resolveSpecId('Demonology', 9)).toBe(266); // case-insensitive
  });

  it('disambiguates "frost" by class (mage=64, DK=251)', () => {
    expect(resolveSpecId('frost', 8)).toBe(64);
    expect(resolveSpecId('frost', 6)).toBe(251);
  });

  it('disambiguates "protection" by class (warrior=73, paladin=66)', () => {
    expect(resolveSpecId('protection', 1)).toBe(73);
    expect(resolveSpecId('protection', 2)).toBe(66);
  });

  it('disambiguates "holy" between paladin and priest', () => {
    expect(resolveSpecId('holy', 2)).toBe(65);
    expect(resolveSpecId('holy', 5)).toBe(257);
  });

  it('disambiguates "restoration" between shaman and druid', () => {
    expect(resolveSpecId('restoration', 7)).toBe(264);
    expect(resolveSpecId('restoration', 11)).toBe(105);
  });

  it('returns undefined for unknown specs', () => {
    expect(resolveSpecId('not_a_spec', 1)).toBeUndefined();
  });
});

describe('maxIlvlForTrack', () => {
  it('returns the last (max) ilvl per track', () => {
    expect(maxIlvlForTrack('dungeon', 'champion')).toBe(263);
    expect(maxIlvlForTrack('dungeon', 'hero')).toBe(276);
    expect(maxIlvlForTrack('dungeon', 'greatvault')).toBe(289);
    expect(maxIlvlForTrack('raid', 'lfr')).toBe(250);
    expect(maxIlvlForTrack('raid', 'normal')).toBe(263);
    expect(maxIlvlForTrack('raid', 'heroic')).toBe(276);
    expect(maxIlvlForTrack('raid', 'mythic')).toBe(289);
  });

  it('returns undefined for unknown tracks', () => {
    expect(maxIlvlForTrack('dungeon', 'made_up')).toBeUndefined();
    expect(maxIlvlForTrack('raid', 'made_up')).toBeUndefined();
  });
});

describe('isItemRelevant', () => {
  it('returns true when the item lists the class+spec', () => {
    // 249275 is an off-hand for class 1 (warrior) spec 73, class 2 specs 65/66, class 7 specs 262/264.
    expect(isItemRelevant(249275, 1, 73)).toBe(true);
    expect(isItemRelevant(249275, 2, 65)).toBe(true);
    expect(isItemRelevant(249275, 7, 262)).toBe(true);
  });

  it('returns false when the spec is not in the gating list', () => {
    expect(isItemRelevant(249275, 1, 71)).toBe(false); // warrior arms not gated
    expect(isItemRelevant(249275, 9, 266)).toBe(false); // wrong class entirely
  });

  it('returns false for unknown items', () => {
    expect(isItemRelevant(999999999, 1, 71)).toBe(false);
  });
});

describe('getItemMeta', () => {
  it('returns metadata for known items', () => {
    const meta = getItemMeta(249275);
    expect(meta).toBeDefined();
    expect(meta!.slot_id).toBe(11); // INVTYPE_WEAPONOFFHAND (0-based KeystoneLoot index)
    expect(meta!.slot_name).toBe('off_hand');
  });

  it('returns undefined for unknown items', () => {
    expect(getItemMeta(999999999)).toBeUndefined();
  });
});

describe('resolveContentPool', () => {
  const allOn = CONTENT_PREFS_DEFAULTS;

  it('returns empty for unknown class', () => {
    const pool = resolveContentPool({
      prefs: allOn,
      className: 'fake_class',
      specKey: 'demonology',
    });
    expect(pool).toEqual([]);
  });

  it('returns empty for unknown spec', () => {
    const pool = resolveContentPool({
      prefs: allOn,
      className: 'warlock',
      specKey: 'fake_spec',
    });
    expect(pool).toEqual([]);
  });

  it('produces a non-trivial pool for demonology warlock with all-on prefs', () => {
    const pool = resolveContentPool({
      prefs: allOn,
      className: 'warlock',
      specKey: 'demonology',
    });
    expect(pool.length).toBeGreaterThan(50);
    // sorted desc by target_ilvl
    for (let i = 1; i < pool.length; i++) {
      expect(pool[i - 1]!.target_ilvl).toBeGreaterThanOrEqual(pool[i]!.target_ilvl);
    }
    // Mythic raid drops at 289; should be at or near the top.
    expect(pool[0]!.target_ilvl).toBe(289);
  });

  it('dedupes items appearing in multiple sources by keeping the highest ilvl', () => {
    const pool = resolveContentPool({
      prefs: allOn,
      className: 'warlock',
      specKey: 'demonology',
    });
    const ids = pool.map((c) => c.item_id);
    expect(new Set(ids).size).toBe(ids.length); // no duplicates
  });

  it('shrinks when raid difficulties are disabled', () => {
    const allRaidsOff: ContentPrefs = {
      ...allOn,
      raids: {
        voidspire: { lfr: false, normal: false, heroic: false, mythic: false },
        dreamrift: { lfr: false, normal: false, heroic: false, mythic: false },
        march_on_queldanas: { lfr: false, normal: false, heroic: false, mythic: false },
      },
    };
    const poolFull = resolveContentPool({
      prefs: allOn,
      className: 'warlock',
      specKey: 'demonology',
    });
    const poolMplusOnly = resolveContentPool({
      prefs: allRaidsOff,
      className: 'warlock',
      specKey: 'demonology',
    });
    expect(poolMplusOnly.length).toBeLessThan(poolFull.length);
    // Every result should be M+ only.
    for (const c of poolMplusOnly) expect(c.source_category).toBe('mplus');
  });

  it('shrinks when M+ is disabled', () => {
    const mplusOff: ContentPrefs = {
      ...allOn,
      mplus: { ...allOn.mplus, enabled: false },
    };
    const pool = resolveContentPool({
      prefs: mplusOff,
      className: 'warlock',
      specKey: 'demonology',
    });
    for (const c of pool) expect(c.source_category).toBe('raid');
  });

  it('M+ end-of-run drops scale with key level (+5 → Champion 263, +10 → Hero 276)', () => {
    // Vault rewards (Greatvault track 272-289) aren't modeled yet — separate
    // future slice. This test pins the current end-of-run-only behavior.
    const lowKey: ContentPrefs = { ...allOn, mplus: { enabled: true, max_level: 5 } };
    const highKey: ContentPrefs = { ...allOn, mplus: { enabled: true, max_level: 10 } };
    const allRaidsOff = {
      voidspire: { lfr: false, normal: false, heroic: false, mythic: false },
      dreamrift: { lfr: false, normal: false, heroic: false, mythic: false },
      march_on_queldanas: { lfr: false, normal: false, heroic: false, mythic: false },
    };
    const lowPool = resolveContentPool({
      prefs: { ...lowKey, raids: allRaidsOff },
      className: 'warlock',
      specKey: 'demonology',
    });
    const highPool = resolveContentPool({
      prefs: { ...highKey, raids: allRaidsOff },
      className: 'warlock',
      specKey: 'demonology',
    });
    for (const c of lowPool) expect(c.target_ilvl).toBeLessThanOrEqual(263);
    for (const c of highPool) expect(c.target_ilvl).toBeLessThanOrEqual(276);
    expect(highPool[0]!.target_ilvl).toBe(276);
  });
});
