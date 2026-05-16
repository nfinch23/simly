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

describe('ENCHANT_CANDIDATES_BY_SLOT (Raidbots Q2 DPS whitelist)', () => {
  it('covers legs + main_hand + off_hand + chest + finger1 + finger2', () => {
    expect(ENCHANT_CANDIDATES_BY_SLOT['legs']!.length).toBe(6);
    expect(ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.length).toBe(7);
    expect(ENCHANT_CANDIDATES_BY_SLOT['off_hand']!.length).toBe(7);
    expect(ENCHANT_CANDIDATES_BY_SLOT['chest']!.length).toBe(4);
    expect(ENCHANT_CANDIDATES_BY_SLOT['finger1']!.length).toBe(9);
    expect(ENCHANT_CANDIDATES_BY_SLOT['finger2']!.length).toBe(9);
  });

  it('leaves head/shoulder/back/wrist/hands/feet empty (no Q2 DPS enchants)', () => {
    for (const slot of ['head', 'shoulder', 'back', 'wrist', 'hands', 'feet']) {
      expect(ENCHANT_CANDIDATES_BY_SLOT[slot]).toEqual([]);
    }
  });

  it('every candidate has a positive enchant_id + non-empty name', () => {
    for (const candidates of Object.values(ENCHANT_CANDIDATES_BY_SLOT)) {
      for (const c of candidates) {
        expect(c.enchant_id).toBeGreaterThan(0);
        expect(c.name.length).toBeGreaterThan(0);
      }
    }
  });

  it('includes the canonical Raidbots names with apostrophes', () => {
    const ringNames = ENCHANT_CANDIDATES_BY_SLOT['finger1']!.map((c) => c.name);
    expect(ringNames).toContain("Nature's Fury");
    expect(ringNames).toContain("Zul'jin's Mastery");
    const weaponNames = ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.map((c) => c.name);
    expect(weaponNames).toContain("Acuity of the Ren'dorei");
    expect(weaponNames).toContain("Berserker's Rage");
  });
});

describe('rewriteItemEnchant', () => {
  it('replaces an existing enchant_id', () => {
    const line = 'legs=,id=250059,enchant_id=7935,bonus_id=1';
    expect(rewriteItemEnchant(line, 8160)).toBe(
      'legs=,id=250059,enchant_id=8160,bonus_id=1',
    );
  });

  it('appends an enchant_id when missing', () => {
    const line = 'legs=,id=250059,bonus_id=1';
    expect(rewriteItemEnchant(line, 8160)).toBe(
      'legs=,id=250059,enchant_id=8160,bonus_id=1',
    );
  });
});

describe('synthesizeItemLineWithEnchant', () => {
  it('overrides enchant_id while preserving bonus_id', () => {
    const item = mkItem('legs');
    const out = synthesizeItemLineWithEnchant(item, 8160);
    expect(out).toContain('enchant_id=8160');
    expect(out).toContain('bonus_id=1/2/3');
    expect(out).not.toContain('enchant_id=7935');
  });

  it('preserves gem_id from extras when present', () => {
    const item = mkItem('legs', { extras: { enchant_id: '7935', gem_id: '240898/240898' } });
    const out = synthesizeItemLineWithEnchant(item, 8160);
    expect(out).toContain('gem_id=240898/240898');
  });
});

describe('buildEnchantsProfilesetLines', () => {
  it('skips slots the player does not have equipped', () => {
    const xport = mkExport([mkItem('head')]); // no legs / main_hand equipped, head has no Q2 DPS enchants
    expect(buildEnchantsProfilesetLines(xport)).toBe('');
  });

  it('emits one profileset per (slot, candidate) for covered slots', () => {
    const xport = mkExport([
      mkItem('legs'),
      mkItem('main_hand', { item_id: 258218 }),
      mkItem('finger1', { item_id: 193708 }),
    ]);
    const out = buildEnchantsProfilesetLines(xport);
    const lines = out.split('\n').filter((l) => l.length > 0);
    const legsCount = ENCHANT_CANDIDATES_BY_SLOT['legs']!.length;
    const mhCount = ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.length;
    const ringCount = ENCHANT_CANDIDATES_BY_SLOT['finger1']!.length;
    expect(lines).toHaveLength(legsCount + mhCount + ringCount);
    for (const c of ENCHANT_CANDIDATES_BY_SLOT['legs']!) {
      expect(out).toContain(`profileset."enchant_legs_${c.key}"+="legs`);
    }
  });
});

describe('parseBestEnchants', () => {
  it('groups results by slot and picks per-slot winner', () => {
    // Pull two real candidates from the loaded data for each slot.
    const legsKeys = ENCHANT_CANDIDATES_BY_SLOT['legs']!.slice(0, 2);
    const mhKeys = ENCHANT_CANDIDATES_BY_SLOT['main_hand']!.slice(0, 2);
    const run = mkRun([
      { name: `enchant_legs_${legsKeys[0]!.key}`, mean: 700 },
      { name: `enchant_legs_${legsKeys[1]!.key}`, mean: 650 },
      { name: `enchant_main_hand_${mhKeys[0]!.key}`, mean: 720 },
      { name: `enchant_main_hand_${mhKeys[1]!.key}`, mean: 715 },
    ]);
    const result = parseBestEnchants(run);
    expect(result?.per_slot['legs']!.best.name).toBe(legsKeys[0]!.name);
    expect(result?.per_slot['main_hand']!.best.name).toBe(mhKeys[0]!.name);
  });

  it('returns undefined when no enchant profilesets matched', () => {
    expect(parseBestEnchants(mkRun([{ name: 'flask_X', mean: 999 }]))).toBeUndefined();
  });

  it('handles a slot with only one matched candidate (winner, no alternatives)', () => {
    const sunfire = ENCHANT_CANDIDATES_BY_SLOT['legs']!.find(
      (c) => c.name === 'Sunfire Silk Spellthread',
    );
    expect(sunfire).toBeDefined();
    const run = mkRun([
      { name: `enchant_legs_${sunfire!.key}`, mean: 700 },
    ]);
    const result = parseBestEnchants(run);
    expect(result?.per_slot['legs']!.best.name).toBe('Sunfire Silk Spellthread');
    expect(result?.per_slot['legs']!.alternatives).toEqual([]);
  });
});
