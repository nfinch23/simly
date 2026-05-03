import { describe, expect, it } from 'vitest';
import {
  buildSwapTestScript,
  parseSwapTestResult,
  swapTargetSlots,
} from './swap-test';
import {
  makeItemIdentity,
  type ParsedItem,
  type SlotName,
} from './simc-export-parser';
import type { SimcRunResult } from './simc-runner';
import type { BestLoadoutSlot } from './gear-catalog';

function fakeItem(opts: { slot: SlotName; item_id: number; ilvl?: number; bonus_ids?: number[] }): ParsedItem {
  const bonus_ids = opts.bonus_ids ?? [];
  return {
    slot: opts.slot,
    item_id: opts.item_id,
    name: `Item ${opts.item_id}`,
    ilvl: opts.ilvl ?? 272,
    bonus_ids,
    is_equipped: false,
    identity: makeItemIdentity(opts.item_id, bonus_ids, undefined),
    extras: {},
  };
}

function bestSlot(item: ParsedItem): BestLoadoutSlot {
  return {
    slot: item.slot,
    item_id: item.item_id,
    name: item.name,
    identity: item.identity,
    ilvl: item.ilvl,
  };
}

function fakeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abc',
    buildDate: '2026-05-02',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 100,
      iterations: 2000,
    })),
    rawJsonPath: '/tmp/x.json',
    rawJson: {},
  };
}

describe('swapTargetSlots', () => {
  it('returns both finger slots for rings', () => {
    expect(swapTargetSlots('finger1')).toEqual(['finger1', 'finger2']);
    expect(swapTargetSlots('finger2')).toEqual(['finger1', 'finger2']);
  });
  it('returns both trinket slots for trinkets', () => {
    expect(swapTargetSlots('trinket1')).toEqual(['trinket1', 'trinket2']);
  });
  it('returns the same slot for normal gear', () => {
    expect(swapTargetSlots('head')).toEqual(['head']);
    expect(swapTargetSlots('main_hand')).toEqual(['main_hand']);
  });
  it('returns empty for tabard/shirt', () => {
    expect(swapTargetSlots('tabard')).toEqual([]);
    expect(swapTargetSlots('shirt')).toEqual([]);
  });
});

describe('buildSwapTestScript', () => {
  it('emits a baseline profileset spelling out every best slot', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const chest = fakeItem({ slot: 'chest', item_id: 2 });
    const newHead = fakeItem({ slot: 'head', item_id: 3 });
    const build = buildSwapTestScript(
      { head: bestSlot(head), chest: bestSlot(chest) },
      { head, chest },
      [newHead],
    );
    expect(build.script).toContain('profileset."swap_baseline"+="head=,id=1"');
    expect(build.script).toContain('profileset."swap_baseline"+="chest=,id=2"');
  });

  it('emits one candidate profileset per slot the new item can target', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const newHead = fakeItem({ slot: 'head', item_id: 2 });
    const build = buildSwapTestScript({ head: bestSlot(head) }, { head }, [newHead]);
    expect(build.candidates).toHaveLength(1);
    expect(build.candidates[0]!.profileset_names).toHaveLength(1);
  });

  it('emits two candidate profilesets for a ring (finger1 + finger2)', () => {
    const f1 = fakeItem({ slot: 'finger1', item_id: 100 });
    const f2 = fakeItem({ slot: 'finger2', item_id: 101 });
    const newRing = fakeItem({ slot: 'finger1', item_id: 102 });
    const build = buildSwapTestScript(
      { finger1: bestSlot(f1), finger2: bestSlot(f2) },
      { finger1: f1, finger2: f2 },
      [newRing],
    );
    expect(build.candidates[0]!.profileset_names).toHaveLength(2);
  });

  it('candidate profilesets override only the target slot, keep others as baseline', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const chest = fakeItem({ slot: 'chest', item_id: 2 });
    const newHead = fakeItem({ slot: 'head', item_id: 3 });
    const build = buildSwapTestScript(
      { head: bestSlot(head), chest: bestSlot(chest) },
      { head, chest },
      [newHead],
    );
    const swapName = build.candidates[0]!.profileset_names[0]!;
    // Candidate's head line uses the new item; chest line keeps the baseline.
    expect(build.script).toContain(`profileset."${swapName}"+="head=,id=3"`);
    expect(build.script).toContain(`profileset."${swapName}"+="chest=,id=2"`);
    // No "head=,id=1" inside the candidate's profileset (only in baseline).
    expect(build.script).not.toMatch(new RegExp(`profileset\\."${swapName}"\\+="head=,id=1`));
  });
});

describe('parseSwapTestResult', () => {
  it('computes delta_pct vs baseline and flags upgrades', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const newHead = fakeItem({ slot: 'head', item_id: 2 });
    const build = buildSwapTestScript({ head: bestSlot(head) }, { head }, [newHead]);
    const swapName = build.candidates[0]!.profileset_names[0]!;
    const run = fakeRun([
      { name: 'swap_baseline', mean: 100_000 },
      { name: swapName, mean: 102_000 },
    ]);
    const result = parseSwapTestResult(run, build);
    expect(result.baseline_dps).toBe(100_000);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]!.delta_pct).toBeCloseTo(2, 1);
    expect(result.results[0]!.is_upgrade).toBe(true);
    expect(result.any_upgrade).toBe(true);
  });

  it('flags no_upgrade when all candidates are within tie window', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const newHead = fakeItem({ slot: 'head', item_id: 2 });
    const build = buildSwapTestScript({ head: bestSlot(head) }, { head }, [newHead]);
    const swapName = build.candidates[0]!.profileset_names[0]!;
    const run = fakeRun([
      { name: 'swap_baseline', mean: 100_000 },
      { name: swapName, mean: 99_900 }, // -0.1% delta
    ]);
    const result = parseSwapTestResult(run, build);
    expect(result.any_upgrade).toBe(false);
    expect(result.results[0]!.is_upgrade).toBe(false);
  });

  it('uses the BEST of two ring positions for ring candidates', () => {
    const f1 = fakeItem({ slot: 'finger1', item_id: 100 });
    const f2 = fakeItem({ slot: 'finger2', item_id: 101 });
    const newRing = fakeItem({ slot: 'finger1', item_id: 102 });
    const build = buildSwapTestScript(
      { finger1: bestSlot(f1), finger2: bestSlot(f2) },
      { finger1: f1, finger2: f2 },
      [newRing],
    );
    const [name1, name2] = build.candidates[0]!.profileset_names;
    const run = fakeRun([
      { name: 'swap_baseline', mean: 100_000 },
      { name: name1!, mean: 99_000 }, // worse in finger1
      { name: name2!, mean: 101_500 }, // better in finger2
    ]);
    const result = parseSwapTestResult(run, build);
    expect(result.results[0]!.delta_pct).toBeCloseTo(1.5, 1);
    expect(result.results[0]!.is_upgrade).toBe(true);
    expect(result.results[0]!.position_deltas).toHaveLength(2);
  });

  it('handles compound slot names like main_hand without splitting them', () => {
    // Regression guard: an earlier draft split profileset names on '_'
    // which broke for main_hand / off_hand. Verify the position_slot
    // comes back intact.
    const mh = fakeItem({ slot: 'main_hand', item_id: 1 });
    const newMh = fakeItem({ slot: 'main_hand', item_id: 2 });
    const build = buildSwapTestScript(
      { main_hand: bestSlot(mh) },
      { main_hand: mh },
      [newMh],
    );
    const name = build.candidates[0]!.profileset_names[0]!;
    const run = fakeRun([
      { name: 'swap_baseline', mean: 100_000 },
      { name, mean: 110_000 },
    ]);
    const result = parseSwapTestResult(run, build);
    expect(result.results[0]!.position_deltas[0]!.position_slot).toBe('main_hand');
  });

  it('skips candidates whose profileset is missing from the run', () => {
    const head = fakeItem({ slot: 'head', item_id: 1 });
    const newHead = fakeItem({ slot: 'head', item_id: 2 });
    const build = buildSwapTestScript({ head: bestSlot(head) }, { head }, [newHead]);
    // Run only has the baseline, no candidate result.
    const run = fakeRun([{ name: 'swap_baseline', mean: 100_000 }]);
    const result = parseSwapTestResult(run, build);
    expect(result.results).toHaveLength(0);
    expect(result.any_upgrade).toBe(false);
  });
});
