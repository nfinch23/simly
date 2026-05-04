import { describe, expect, it } from 'vitest';
import { parseGearRerankResult, selectSurvivors } from './gear-rerank';
import {
  makeItemIdentity,
  type ParsedItem,
  type SlotName,
} from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';
import type { GearCombo } from './gear-pruner';
import type { GearComboResult } from '@simly/shared';

function fakeItem(slot: SlotName, item_id: number): ParsedItem {
  return {
    slot,
    item_id,
    name: `Item ${item_id}`,
    ilvl: 272,
    bonus_ids: [],
    is_equipped: false,
    identity: makeItemIdentity(item_id, [], undefined),
    extras: {},
  };
}

function fakeCombo(id: string, headId: number): GearCombo {
  return { id, slots: { head: fakeItem('head', headId) } };
}

function fakeComboResult(id: string, mean_dps: number): GearComboResult {
  return {
    combo_id: id,
    items: [{ slot: 'head', item: { item_id: 1, name: 'Item 1', ilvl: 272, identity: '1::' } }],
    mean_dps,
    delta_pct: 0,
  };
}

function fakeRun(profilesets: Array<{ name: string; mean: number }>): SimcRunResult {
  return {
    simcVersion: '1205-01',
    gitRevision: 'abc',
    buildDate: '2026-05-04',
    profilesets: profilesets.map((p) => ({
      name: p.name,
      mean: p.mean,
      stddev: 100,
      iterations: 3000,
    })),
    rawJsonPath: '/tmp/x.json',
    rawJson: {},
  };
}

describe('parseGearRerankResult', () => {
  it('sorts combos desc by mean_dps and computes delta_pct vs winner', () => {
    const combosByName = new Map<string, GearCombo>([
      ['r_0000', fakeCombo('r_0000', 1)],
      ['r_0001', fakeCombo('r_0001', 2)],
      ['r_0002', fakeCombo('r_0002', 3)],
    ]);
    const run = fakeRun([
      { name: 'r_0000', mean: 100_000 },
      { name: 'r_0001', mean: 105_000 },
      { name: 'r_0002', mean: 95_000 },
    ]);
    const result = parseGearRerankResult(run, combosByName, 3000, 'refined test');
    expect(result.combos).toHaveLength(3);
    expect(result.winner?.combo_id).toBe('r_0001');
    expect(result.combos[0]!.delta_pct).toBe(0);
    expect(result.combos[1]!.delta_pct).toBeLessThan(0);
    expect(result.combos[2]!.delta_pct).toBeLessThan(result.combos[1]!.delta_pct);
    expect(result.iterations).toBe(3000);
    expect(result.label).toBe('refined test');
  });

  it('returns empty result when no profilesets matched', () => {
    const result = parseGearRerankResult(fakeRun([]), new Map(), 3000, 'empty');
    expect(result.combos).toEqual([]);
    expect(result.winner).toBeUndefined();
  });

  it('drops profilesets without a matching combo', () => {
    const combosByName = new Map<string, GearCombo>([['r_0000', fakeCombo('r_0000', 1)]]);
    const run = fakeRun([
      { name: 'r_0000', mean: 100_000 },
      { name: 'unrelated_profile', mean: 999_999 },
    ]);
    const result = parseGearRerankResult(run, combosByName, 3000, 'test');
    expect(result.combos).toHaveLength(1);
    expect(result.combos[0]!.combo_id).toBe('r_0000');
  });
});

describe('selectSurvivors', () => {
  it('returns combos within keep_threshold_pct of the winner', () => {
    // Winner 100k, threshold 1% → cutoff at 99k.
    const combos = [
      fakeComboResult('g_0000', 100_000),
      fakeComboResult('g_0001', 99_500),  // -0.5% — kept
      fakeComboResult('g_0002', 99_000),  // -1.0% — at cutoff, kept
      fakeComboResult('g_0003', 98_900),  // -1.1% — dropped
    ];
    const byName = new Map<string, GearCombo>(combos.map((c) => [c.combo_id, fakeCombo(c.combo_id, 1)]));
    const survivors = selectSurvivors(combos, byName, 1);
    expect(survivors.size).toBe(3);
    expect(survivors.has('g_0000')).toBe(true);
    expect(survivors.has('g_0001')).toBe(true);
    expect(survivors.has('g_0002')).toBe(true);
    expect(survivors.has('g_0003')).toBe(false);
  });

  it('returns the single winner when only one combo exists', () => {
    const combos = [fakeComboResult('g_0000', 100_000)];
    const byName = new Map<string, GearCombo>([['g_0000', fakeCombo('g_0000', 1)]]);
    const survivors = selectSurvivors(combos, byName, 1);
    expect(survivors.size).toBe(1);
  });

  it('returns empty for empty input', () => {
    expect(selectSurvivors([], new Map(), 1).size).toBe(0);
  });

  it('drops combos whose source GearCombo is not in the byName map (defensive)', () => {
    const combos = [
      fakeComboResult('g_0000', 100_000),
      fakeComboResult('g_0001', 99_500),
    ];
    const byName = new Map<string, GearCombo>([['g_0000', fakeCombo('g_0000', 1)]]);
    const survivors = selectSurvivors(combos, byName, 1);
    expect(survivors.size).toBe(1);
    expect(survivors.has('g_0000')).toBe(true);
  });

  it('respects a tighter threshold (0.5% for refined → final transition)', () => {
    const combos = [
      fakeComboResult('g_0000', 100_000),
      fakeComboResult('g_0001', 99_700),  // -0.3% — kept
      fakeComboResult('g_0002', 99_400),  // -0.6% — dropped at 0.5%
    ];
    const byName = new Map<string, GearCombo>(combos.map((c) => [c.combo_id, fakeCombo(c.combo_id, 1)]));
    const survivors = selectSurvivors(combos, byName, 0.5);
    expect(survivors.size).toBe(2);
    expect(survivors.has('g_0002')).toBe(false);
  });
});
