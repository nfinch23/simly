import { describe, expect, it } from 'vitest';
import type { ParsedItem } from '../simc-export-parser';
import type { SimcRunResult, ProfilesetResult } from '../simc-runner';
import {
  ILVL_PER_TIER,
  MYTH_CEILING,
  PROFILESET_PREFIX,
  buildUpgradePriorityProfilesets,
  parseUpgradePriorityResult,
  runUpgradePriorityScan,
} from './upgrade-priority';

function mkItem(slot: ParsedItem['slot'], overrides: Partial<ParsedItem> = {}): ParsedItem {
  return {
    slot,
    item_id: 100000 + Math.floor(Math.random() * 1000),
    name: `${slot}-item`,
    ilvl: 250,
    bonus_ids: [1, 2, 3],
    is_equipped: true,
    identity: `${slot}-id`,
    extras: {},
    ...overrides,
  };
}

function mkProfileset(name: string, mean: number): ProfilesetResult {
  return { name, mean, stddev: 0, iterations: 3000 };
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

describe('buildUpgradePriorityProfilesets', () => {
  it('emits one variant per non-maxed slot + a baseline anchor', () => {
    const gear = {
      head: mkItem('head', { ilvl: 250 }),
      chest: mkItem('chest', { ilvl: 263 }),
      legs: mkItem('legs', { ilvl: MYTH_CEILING }), // skipped (at ceiling)
    };
    const { lines, candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates.map((c) => c.slot)).toEqual(['head', 'chest']);
    expect(candidates[0]!.next_ilvl).toBe(250 + ILVL_PER_TIER);
    expect(candidates[1]!.next_ilvl).toBe(263 + ILVL_PER_TIER);
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_baseline"+=`);
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_head"+=`);
    expect(lines).toContain(`profileset."${PROFILESET_PREFIX}_chest"+=`);
    expect(lines).not.toContain(`profileset."${PROFILESET_PREFIX}_legs"+=`);
  });

  it('embeds ilevel=<current+13> override on the item line', () => {
    const gear = { head: mkItem('head', { ilvl: 250, item_id: 12345, bonus_ids: [1, 2] }) };
    const { lines } = buildUpgradePriorityProfilesets(gear);
    expect(lines).toMatch(/head=,id=12345,bonus_id=1\/2,ilevel=263/);
  });

  it('skips items at the Myth ceiling', () => {
    const gear = { head: mkItem('head', { ilvl: MYTH_CEILING }) };
    const { candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(0);
  });

  it('skips items above the Myth ceiling (defensive)', () => {
    const gear = { head: mkItem('head', { ilvl: MYTH_CEILING + 5 }) };
    const { candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(0);
  });

  it('skips items with non-positive ilvl (broken export)', () => {
    const gear = { head: mkItem('head', { ilvl: 0 }) };
    const { candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(0);
  });

  it('returns no candidates when every slot is at ceiling — empty result is the signal', () => {
    const gear = {
      head: mkItem('head', { ilvl: MYTH_CEILING }),
      chest: mkItem('chest', { ilvl: MYTH_CEILING }),
    };
    const { lines, candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(0);
    expect(lines).toBe('');
  });

  it('uses real bonus_id rewriting when the item has a track marker (Champion 3/6 → 4/6)', () => {
    // bonus_id 12787 = Champion rank 3 (ilvl 253); rank 4 = 12788 (ilvl 256).
    // The +1 rank delta is +3 ilvl, not +13. This is the headline correctness fix.
    const gear = {
      head: mkItem('head', {
        ilvl: 253,
        item_id: 99999,
        bonus_ids: [9876, 12787, 5555],
      }),
    };
    const { lines, candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(1);
    const cand = candidates[0]!;
    expect(cand.next_ilvl).toBe(256); // not 253+13=266 from the fallback
    expect(cand.rewritten_bonus_ids).toEqual([9876, 12788, 5555]);
    expect(cand.track_label).toBe('champion 4/6');
    // The emitted line should swap the bonus_id, not append an ilevel.
    expect(lines).toMatch(/head=,id=99999,bonus_id=9876\/12788\/5555/);
    expect(lines).not.toContain('ilevel=');
  });

  it('skips items at the track ceiling (e.g. Champion 6/6 with bonus_id 12790)', () => {
    const gear = {
      head: mkItem('head', {
        ilvl: 263,
        bonus_ids: [12790], // Champion 6/6
      }),
    };
    const { candidates } = buildUpgradePriorityProfilesets(gear);
    // Track ceiling: bonus_id rewrite returns null. Falls through to the
    // fallback +13 ilvl path — still surfaces as a candidate so the user
    // sees "next upgrade tier" even when cross-track. Acceptable since
    // 263 < MYTH_CEILING (289), so the slot-level ceiling check still
    // gates real Myth 6/6 (289) items.
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rewritten_bonus_ids).toBeNull();
    expect(candidates[0]!.next_ilvl).toBe(263 + 13); // fallback path
  });

  it('falls back to ilvl=N override when item has no track marker', () => {
    const gear = {
      head: mkItem('head', {
        ilvl: 250,
        item_id: 88888,
        bonus_ids: [6652, 13440], // none are upgrade-track markers
      }),
    };
    const { lines, candidates } = buildUpgradePriorityProfilesets(gear);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.rewritten_bonus_ids).toBeNull();
    expect(candidates[0]!.next_ilvl).toBe(263); // 250 + 13 fallback
    expect(lines).toMatch(/head=,id=88888,bonus_id=6652\/13440,ilevel=263/);
  });
});

describe('parseUpgradePriorityResult', () => {
  it('sorts opportunities descending by delta_dps', () => {
    const head = mkItem('head', { ilvl: 250, item_id: 1 });
    const chest = mkItem('chest', { ilvl: 260, item_id: 2 });
    const legs = mkItem('legs', { ilvl: 240, item_id: 3 });
    const candidates = [
      { key: 'head', slot: 'head', item: head, next_ilvl: 263, rewritten_bonus_ids: null, track_label: null },
      { key: 'chest', slot: 'chest', item: chest, next_ilvl: 273, rewritten_bonus_ids: null, track_label: null },
      { key: 'legs', slot: 'legs', item: legs, next_ilvl: 253, rewritten_bonus_ids: null, track_label: null },
    ];
    const run = mkRun([
      mkProfileset(`${PROFILESET_PREFIX}_baseline`, 100000),
      mkProfileset(`${PROFILESET_PREFIX}_head`, 100500), // +500
      mkProfileset(`${PROFILESET_PREFIX}_chest`, 100200), // +200
      mkProfileset(`${PROFILESET_PREFIX}_legs`, 101000), // +1000 — biggest gain
    ]);
    const result = parseUpgradePriorityResult(run, candidates);
    expect(result.opportunities.map((o) => o.slot)).toEqual(['legs', 'head', 'chest']);
    expect(result.baseline_dps).toBe(100000);
    expect(result.ilvl_per_tier).toBe(ILVL_PER_TIER);
    expect(result.opportunities[0]!.delta_dps).toBe(1000);
    expect(result.opportunities[0]!.delta_pct).toBeCloseTo(1.0, 2);
  });

  it('skips candidates whose profileset is missing from the run (defensive)', () => {
    const head = mkItem('head', { ilvl: 250 });
    const candidates = [{ key: 'head', slot: 'head', item: head, next_ilvl: 263, rewritten_bonus_ids: null, track_label: null }];
    const run = mkRun([mkProfileset(`${PROFILESET_PREFIX}_baseline`, 100000)]);
    const result = parseUpgradePriorityResult(run, candidates);
    expect(result.opportunities).toHaveLength(0);
    expect(result.baseline_dps).toBe(100000);
  });

  it('computes delta_pct as 0 when baseline is 0 (zero-divide guard)', () => {
    const head = mkItem('head', { ilvl: 250 });
    const candidates = [{ key: 'head', slot: 'head', item: head, next_ilvl: 263, rewritten_bonus_ids: null, track_label: null }];
    const run = mkRun([
      mkProfileset(`${PROFILESET_PREFIX}_baseline`, 0),
      mkProfileset(`${PROFILESET_PREFIX}_head`, 100),
    ]);
    const result = parseUpgradePriorityResult(run, candidates);
    expect(result.opportunities[0]!.delta_pct).toBe(0);
    expect(result.opportunities[0]!.delta_dps).toBe(100);
  });
});

describe('runUpgradePriorityScan', () => {
  it('short-circuits with an empty opportunities list when no candidates exist', async () => {
    const result = await runUpgradePriorityScan({
      paths: { binPath: '/nope', scratchDir: '/nope' },
      baseProfile: 'warlock="X"',
      composedGear: { head: mkItem('head', { ilvl: MYTH_CEILING }) },
      runOverride: async () => {
        throw new Error('should not be invoked');
      },
    });
    expect(result.opportunities).toHaveLength(0);
    expect(result.baseline_dps).toBe(0);
    expect(result.ilvl_per_tier).toBe(ILVL_PER_TIER);
  });

  it('passes the assembled profile to runOverride and returns a parsed result', async () => {
    let capturedProfile = '';
    const result = await runUpgradePriorityScan({
      paths: { binPath: '/nope', scratchDir: '/nope' },
      baseProfile: 'warlock="X"',
      composedGear: { head: mkItem('head', { ilvl: 250, item_id: 999 }) },
      runOverride: async (script) => {
        capturedProfile = script;
        return mkRun([
          mkProfileset(`${PROFILESET_PREFIX}_baseline`, 100000),
          mkProfileset(`${PROFILESET_PREFIX}_head`, 100300),
        ]);
      },
    });
    expect(capturedProfile).toContain('warlock="X"');
    expect(capturedProfile).toContain('iterations=3000');
    expect(capturedProfile).toContain(`profileset."${PROFILESET_PREFIX}_head"+=`);
    expect(result.opportunities).toHaveLength(1);
    expect(result.opportunities[0]!.delta_dps).toBe(300);
    expect(result.opportunities[0]!.next_ilvl).toBe(263);
  });
});
