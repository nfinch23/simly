import { describe, expect, it } from 'vitest';
import type { ParsedExport, ParsedItem } from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import {
  ENCHANT_CANDIDATES_BY_SLOT,
  buildEnchantsProfilesetLines,
  parseBestEnchants,
  rewriteItemEnchant,
  synthesizeItemLineWithEnchant,
} from './best-enchants';

function mkRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'd6f091a0000000000000000000000000',
    buildDate: '2026-04-30',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 10,
      iterations: 1000,
    })),
    rawJsonPath: '/tmp/fake.json',
    rawJson: {},
  };
}

function mkItem(slot: ParsedItem['slot'], overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    slot,
    item_id: 250059,
    name: 'Item',
    ilvl: 280,
    bonus_ids: [1, 2, 3],
    is_equipped: true,
    identity: `${slot}-id`,
    extras: { enchant_id: '7935' },
    ...overrides,
  };
}

function mkExport(equipped: ParsedItem[]): ParsedExport {
  return {
    character: { class: 'mage' },
    equipped,
    bag: [],
    poolBySlot: {} as ParsedExport['poolBySlot'],
    equipped_talents: null,
    saved_loadouts: [],
  };
}

describe('ENCHANT_CANDIDATES_BY_SLOT', () => {
  it('covers legs + main_hand in v1', () => {
    expect(ENCHANT_CANDIDATES_BY_SLOT).toHaveProperty('legs');
    expect(ENCHANT_CANDIDATES_BY_SLOT).toHaveProperty('main_hand');
  });

  it('has at least 4 leg enchants and 4 weapon enchants', () => {
    expect(ENCHANT_CANDIDATES_BY_SLOT['legs']!.length).toBeGreaterThanOrEqual(4);
    expect(ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.length).toBeGreaterThanOrEqual(4);
  });

  it('every candidate has a positive enchant_id + non-empty name', () => {
    for (const candidates of Object.values(ENCHANT_CANDIDATES_BY_SLOT)) {
      for (const c of candidates) {
        expect(c.enchant_id).toBeGreaterThan(0);
        expect(c.name.length).toBeGreaterThan(0);
      }
    }
  });
});

describe('rewriteItemEnchant', () => {
  it('replaces an existing enchant_id', () => {
    const line = 'legs=,id=250059,enchant_id=7935,bonus_id=1';
    expect(rewriteItemEnchant(line, 8159)).toBe(
      'legs=,id=250059,enchant_id=8159,bonus_id=1',
    );
  });

  it('appends an enchant_id when missing', () => {
    const line = 'legs=,id=250059,bonus_id=1';
    expect(rewriteItemEnchant(line, 8159)).toBe(
      'legs=,id=250059,enchant_id=8159,bonus_id=1',
    );
  });
});

describe('synthesizeItemLineWithEnchant', () => {
  it('overrides enchant_id while preserving bonus_id', () => {
    const item = mkItem('legs');
    const out = synthesizeItemLineWithEnchant(item, 8159);
    expect(out).toContain('enchant_id=8159');
    expect(out).toContain('bonus_id=1/2/3');
    expect(out).not.toContain('enchant_id=7935');
  });

  it('preserves gem_id from extras when present', () => {
    const item = mkItem('legs', { extras: { enchant_id: '7935', gem_id: '240898/240898' } });
    const out = synthesizeItemLineWithEnchant(item, 8159);
    expect(out).toContain('gem_id=240898/240898');
  });
});

describe('buildEnchantsProfilesetLines', () => {
  it('skips slots the player does not have equipped', () => {
    const xport = mkExport([mkItem('head')]); // no legs / main_hand equipped
    expect(buildEnchantsProfilesetLines(xport)).toBe('');
  });

  it('emits one profileset per (slot, candidate)', () => {
    const xport = mkExport([
      mkItem('legs'),
      mkItem('main_hand', { item_id: 258218 }),
    ]);
    const out = buildEnchantsProfilesetLines(xport);
    const lines = out.split('\n').filter((l) => l.length > 0);
    const legsCount = ENCHANT_CANDIDATES_BY_SLOT['legs']!.length;
    const mhCount = ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.length;
    expect(lines).toHaveLength(legsCount + mhCount);
    for (const c of ENCHANT_CANDIDATES_BY_SLOT['legs']!) {
      expect(out).toContain(`profileset."enchant_legs_${c.key}"+="legs`);
    }
    for (const c of ENCHANT_CANDIDATES_BY_SLOT['main_hand']!) {
      expect(out).toContain(`profileset."enchant_main_hand_${c.key}"+="main_hand`);
    }
  });
});

describe('parseBestEnchants', () => {
  it('groups results by slot and picks per-slot winner', () => {
    const run = mkRun([
      { name: 'enchant_legs_sunfire_silk', mean: 700 },
      { name: 'enchant_legs_arcanoweave', mean: 650 },
      { name: 'enchant_main_hand_acuity_rendorei', mean: 720 },
      { name: 'enchant_main_hand_arcane_mastery', mean: 715 },
    ]);
    const result = parseBestEnchants(run);
    expect(result?.per_slot['legs']!.best.name).toBe('Sunfire Silk Spellthread');
    expect(result?.per_slot['main_hand']!.best.name).toBe("Acuity of the Ren'dorei");
  });

  it('returns undefined when no enchant profilesets matched', () => {
    expect(parseBestEnchants(mkRun([{ name: 'flask_X', mean: 999 }]))).toBeUndefined();
  });

  it('handles a slot with only one matched candidate (winner, no alternatives)', () => {
    const run = mkRun([
      { name: 'enchant_legs_sunfire_silk', mean: 700 },
    ]);
    const result = parseBestEnchants(run);
    expect(result?.per_slot['legs']!.best.name).toBe('Sunfire Silk Spellthread');
    expect(result?.per_slot['legs']!.alternatives).toEqual([]);
  });
});
