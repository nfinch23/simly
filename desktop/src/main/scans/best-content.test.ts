import { describe, expect, it } from 'vitest';
import type { ParsedItem } from '../simc-export-parser';
import type { ProfilesetResult, SimcRunResult } from '../simc-runner';
import type { ContentPrefs } from '../settings';
import { CONTENT_PREFS_DEFAULTS } from '../settings';
import {
  MAX_BEST_CONTENT_COMBOS,
  PROFILESET_PREFIX,
  buildBestContentProfilesets,
  groupContentBySource,
  parseBestContentResult,
  runBestContentScan,
  selectContentCandidates,
} from './best-content';
import type { ContentOpportunity } from '@simly/shared';

function mkOp(overrides: Partial<ContentOpportunity> = {}): ContentOpportunity {
  return {
    item_id: 1,
    name: 'Mock',
    slot: 'head',
    target_ilvl: 290,
    source_label: 'Mythic raid',
    source_category: 'raid',
    current_dps: 100_000,
    upgraded_dps: 101_000,
    delta_dps: 1000,
    delta_pct: 1.0,
    ...overrides,
  };
}

function mkItem(slot: ParsedItem['slot'], overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    slot,
    item_id: 100000,
    name: `${slot}-item`,
    ilvl: 250,
    bonus_ids: [1, 2, 3],
    is_equipped: true,
    identity: `${slot}-id`,
    extras: {},
    ...overrides,
  };
}

function mkRun(profilesets: ProfilesetResult[]): SimcRunResult {
  return {
    simcVersion: 'test',
    gitRevision: 'test',
    buildDate: 'test',
    profilesets,
    rawJsonPath: '/dev/null',
    rawJson: {},
  };
}

function mkPs(name: string, mean: number): ProfilesetResult {
  return { name, mean, stddev: 0, iterations: 3000 };
}

// Pin a deterministic prefs snapshot — all-on (defaults).
const prefsAllOn: ContentPrefs = CONTENT_PREFS_DEFAULTS;

describe('selectContentCandidates', () => {
  it('returns no candidates when class/spec are unknown', () => {
    const result = selectContentCandidates({
      prefs: prefsAllOn,
      className: 'definitely_not_a_class',
      specKey: 'demonology',
      composedGear: { head: mkItem('head') },
    });
    expect(result.selected).toEqual([]);
    expect(result.totalConsidered).toBe(0);
  });

  it('returns demonology warlock candidates from real data, all upgrades over baseline', () => {
    // Equip felfriend at all-low ilvl so every Midnight drop is an upgrade.
    const baseline = 100;
    const composedGear: Record<string, ParsedItem> = {};
    for (const slot of ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2', 'main_hand']) {
      composedGear[slot] = mkItem(slot as ParsedItem['slot'], { ilvl: baseline });
    }
    const result = selectContentCandidates({
      prefs: prefsAllOn,
      className: 'warlock',
      specKey: 'demonology',
      composedGear,
    });
    expect(result.selected.length).toBeGreaterThan(0);
    expect(result.selected.length).toBeLessThanOrEqual(MAX_BEST_CONTENT_COMBOS);
    expect(result.totalConsidered).toBeGreaterThan(result.selected.length);
    // Every selected candidate must beat the baseline ilvl.
    for (const c of result.selected) {
      expect(c.target_ilvl).toBeGreaterThan(baseline);
    }
    // Sorted desc by target_ilvl.
    for (let i = 1; i < result.selected.length; i++) {
      expect(result.selected[i - 1]!.target_ilvl).toBeGreaterThanOrEqual(
        result.selected[i]!.target_ilvl,
      );
    }
  });

  it('filters out candidates that do not beat the equipped ilvl', () => {
    // Equip at the Myth ceiling — everything from M+/raid is <= 289.
    const composedGear: Record<string, ParsedItem> = {};
    for (const slot of ['head', 'neck', 'shoulder', 'back', 'chest', 'wrist', 'hands', 'waist', 'legs', 'feet', 'finger1', 'finger2', 'trinket1', 'trinket2', 'main_hand']) {
      composedGear[slot] = mkItem(slot as ParsedItem['slot'], { ilvl: 300 });
    }
    const result = selectContentCandidates({
      prefs: prefsAllOn,
      className: 'warlock',
      specKey: 'demonology',
      composedGear,
    });
    expect(result.selected).toEqual([]);
    expect(result.totalConsidered).toBeGreaterThan(0);
  });

  it('respects content prefs — disabling M+ + raids returns no candidates', () => {
    const allOff: ContentPrefs = {
      raids: {
        voidspire: { lfr: false, normal: false, heroic: false, mythic: false },
        dreamrift: { lfr: false, normal: false, heroic: false, mythic: false },
        march_on_queldanas: { lfr: false, normal: false, heroic: false, mythic: false },
      },
      mplus: { enabled: false, max_level: 10 },
      world: { enabled: false, max_delve_tier: 11, max_ritual_tier: 5 },
    };
    const composedGear: Record<string, ParsedItem> = {
      head: mkItem('head', { ilvl: 100 }),
    };
    const result = selectContentCandidates({
      prefs: allOff,
      className: 'warlock',
      specKey: 'demonology',
      composedGear,
    });
    expect(result.selected).toEqual([]);
  });

  it('resolves ambiguous finger/trinket slot to the weaker side', () => {
    const composedGear: Record<string, ParsedItem> = {
      finger1: mkItem('finger1', { ilvl: 280 }),
      finger2: mkItem('finger2', { ilvl: 250 }), // weaker
      trinket1: mkItem('trinket1', { ilvl: 250 }), // weaker
      trinket2: mkItem('trinket2', { ilvl: 280 }),
    };
    const result = selectContentCandidates({
      prefs: prefsAllOn,
      className: 'warlock',
      specKey: 'demonology',
      composedGear,
    });
    const ringCandidates = result.selected.filter((c) => c.slot === 'finger');
    const trinketCandidates = result.selected.filter((c) => c.slot === 'trinket');
    if (ringCandidates.length > 0) {
      // All ring candidates should target finger2 (the weaker side).
      for (const c of ringCandidates) expect(c.simc_slot).toBe('finger2');
    }
    if (trinketCandidates.length > 0) {
      for (const c of trinketCandidates) expect(c.simc_slot).toBe('trinket1');
    }
  });
});

describe('buildBestContentProfilesets', () => {
  it('emits baseline + variants with ilevel overrides', () => {
    const head = mkItem('head', { ilvl: 250, item_id: 50000, bonus_ids: [1, 2] });
    const candidates = [
      { item_id: 60001, slot: 'head', simc_slot: 'head', target_ilvl: 276, source_label: 'Heroic raid', source_category: 'raid' as const, key: 'head_60001' },
      { item_id: 60002, slot: 'head', simc_slot: 'head', target_ilvl: 289, source_label: 'Mythic raid', source_category: 'raid' as const, key: 'head_60002' },
    ];
    const lines = buildBestContentProfilesets(candidates, { head });
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_baseline"+="head=,id=50000,bonus_id=1/2"`);
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_head_60001"+="head=,id=60001,ilevel=276"`);
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_head_60002"+="head=,id=60002,ilevel=289"`);
  });

  it('returns empty when there are no candidates', () => {
    expect(buildBestContentProfilesets([], {})).toBe('');
  });
});

describe('parseBestContentResult', () => {
  it('ranks opportunities descending by delta_dps', () => {
    const candidates = [
      { item_id: 1, slot: 'head', simc_slot: 'head', target_ilvl: 276, source_label: 'Heroic', source_category: 'raid' as const, key: 'head_1' },
      { item_id: 2, slot: 'chest', simc_slot: 'chest', target_ilvl: 263, source_label: 'M+ +10', source_category: 'mplus' as const, key: 'chest_2' },
      { item_id: 3, slot: 'legs', simc_slot: 'legs', target_ilvl: 289, source_label: 'Mythic', source_category: 'raid' as const, key: 'legs_3' },
    ];
    const run = mkRun([
      mkPs(`${PROFILESET_PREFIX}_baseline`, 100000),
      mkPs(`${PROFILESET_PREFIX}_head_1`, 100300),
      mkPs(`${PROFILESET_PREFIX}_chest_2`, 100150),
      mkPs(`${PROFILESET_PREFIX}_legs_3`, 100800),
    ]);
    const result = parseBestContentResult(run, candidates, 25);
    expect(result.candidates_evaluated).toBe(25);
    expect(result.baseline_dps).toBe(100000);
    expect(result.opportunities.map((o) => o.item_id)).toEqual([3, 1, 2]);
    expect(result.opportunities[0]!.delta_dps).toBe(800);
    expect(result.opportunities[0]!.delta_pct).toBeCloseTo(0.8, 2);
  });

  it('skips candidates with no matching profileset (defensive)', () => {
    const candidates = [
      { item_id: 1, slot: 'head', simc_slot: 'head', target_ilvl: 276, source_label: 'Heroic', source_category: 'raid' as const, key: 'head_1' },
    ];
    const run = mkRun([mkPs(`${PROFILESET_PREFIX}_baseline`, 100000)]);
    const result = parseBestContentResult(run, candidates, 1);
    expect(result.opportunities).toEqual([]);
  });
});

describe('runBestContentScan', () => {
  it('short-circuits with empty result when no candidates qualify', async () => {
    const composedGear: Record<string, ParsedItem> = {
      head: mkItem('head', { ilvl: 300 }), // higher than any Midnight track
    };
    const result = await runBestContentScan({
      paths: { binPath: '/nope', scratchDir: '/nope' },
      baseProfile: 'warlock="X"',
      className: 'warlock',
      specKey: 'demonology',
      prefs: prefsAllOn,
      composedGear,
      runOverride: async () => {
        throw new Error('should not call SimC');
      },
    });
    expect(result.opportunities).toEqual([]);
    expect(result.baseline_dps).toBe(0);
    expect(result.candidates_evaluated).toBeGreaterThan(0); // pool was non-empty
  });

  it('routes through runOverride for tests', async () => {
    const composedGear: Record<string, ParsedItem> = {};
    for (const slot of ['head', 'chest', 'legs']) {
      composedGear[slot] = mkItem(slot as ParsedItem['slot'], { ilvl: 100 });
    }
    let captured = '';
    const result = await runBestContentScan({
      paths: { binPath: '/nope', scratchDir: '/nope' },
      baseProfile: 'warlock="X"',
      className: 'warlock',
      specKey: 'demonology',
      prefs: prefsAllOn,
      composedGear,
      maxCombos: 5,
      runOverride: async (script) => {
        captured = script;
        return mkRun([mkPs(`${PROFILESET_PREFIX}_baseline`, 90000)]);
      },
    });
    expect(captured).toContain('warlock="X"');
    expect(captured).toContain('iterations=3000');
    expect(captured).toContain(`profileset."${PROFILESET_PREFIX}_baseline"+=`);
    expect(result.baseline_dps).toBe(90000);
  });
});

describe('groupContentBySource', () => {
  it('groups opportunities by source_label', () => {
    const ops = [
      mkOp({ source_label: 'Mythic raid', delta_dps: 500 }),
      mkOp({ source_label: 'Mythic raid', delta_dps: 300, slot: 'neck' }),
      mkOp({ source_label: 'M+ +12', source_category: 'mplus', delta_dps: 800 }),
    ];
    const groups = groupContentBySource(ops);
    expect(groups).toHaveLength(2);
    const mplus = groups.find((g) => g.source_label === 'M+ +12');
    const raid = groups.find((g) => g.source_label === 'Mythic raid');
    expect(mplus?.upgrade_count).toBe(1);
    expect(raid?.upgrade_count).toBe(2);
  });

  it('totals delta_dps per source', () => {
    const ops = [
      mkOp({ source_label: 'X', delta_dps: 500 }),
      mkOp({ source_label: 'X', delta_dps: 300, slot: 'neck' }),
    ];
    const groups = groupContentBySource(ops);
    expect(groups[0]!.total_potential_dps).toBe(800);
  });

  it('drops non-upgrades (delta_dps <= 0)', () => {
    const ops = [
      mkOp({ source_label: 'X', delta_dps: 500 }),
      mkOp({ source_label: 'X', delta_dps: 0, slot: 'neck' }),
      mkOp({ source_label: 'X', delta_dps: -100, slot: 'back' }),
    ];
    const groups = groupContentBySource(ops);
    expect(groups[0]!.upgrade_count).toBe(1);
    expect(groups[0]!.total_potential_dps).toBe(500);
  });

  it('drops sources with no upgrades entirely', () => {
    const ops = [mkOp({ source_label: 'AllDowngrades', delta_dps: -50 })];
    const groups = groupContentBySource(ops);
    expect(groups).toHaveLength(0);
  });

  it('sorts groups desc by total_potential_dps', () => {
    const ops = [
      mkOp({ source_label: 'Small', delta_dps: 100 }),
      mkOp({ source_label: 'Big', delta_dps: 5000 }),
      mkOp({ source_label: 'Medium', delta_dps: 1000 }),
    ];
    const groups = groupContentBySource(ops);
    expect(groups.map((g) => g.source_label)).toEqual(['Big', 'Medium', 'Small']);
  });

  it('sorts opportunities within a group desc by delta_dps', () => {
    const ops = [
      mkOp({ source_label: 'X', delta_dps: 200, slot: 'head' }),
      mkOp({ source_label: 'X', delta_dps: 800, slot: 'neck' }),
      mkOp({ source_label: 'X', delta_dps: 500, slot: 'back' }),
    ];
    const groups = groupContentBySource(ops);
    const dpsOrdered = groups[0]!.opportunities.map((o) => o.delta_dps);
    expect(dpsOrdered).toEqual([800, 500, 200]);
  });
});
