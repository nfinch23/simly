import { describe, expect, it } from 'vitest';
import {
  buildRingProfilesetScript,
  pairKey,
  parseRingPreScanResult,
} from './ring-pre-scan';
import {
  makeItemIdentity,
  type ParsedItem,
  type SlotName,
} from '../simc-export-parser';
import type { SimcRunResult } from '../simc-runner';

function fakeRing(opts: {
  item_id: number;
  name: string;
  ilvl: number;
  bonus_ids?: number[];
  slot?: SlotName;
}): ParsedItem {
  const bonus_ids = opts.bonus_ids ?? [];
  return {
    slot: opts.slot ?? 'finger1',
    item_id: opts.item_id,
    name: opts.name,
    ilvl: opts.ilvl,
    bonus_ids,
    is_equipped: false,
    identity: makeItemIdentity(opts.item_id, bonus_ids, undefined),
    extras: {},
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
      stddev: 10,
      iterations: 3000,
    })),
    rawJsonPath: '/tmp/x.json',
    rawJson: {},
  };
}

describe('buildRingProfilesetScript', () => {
  it('emits one profileset per unordered pair (n choose 2)', () => {
    const A = fakeRing({ item_id: 1, name: 'A', ilvl: 250 });
    const B = fakeRing({ item_id: 2, name: 'B', ilvl: 260 });
    const C = fakeRing({ item_id: 3, name: 'C', ilvl: 270 });
    const { script, pairsByName } = buildRingProfilesetScript([A, B, C]);
    const lines = script.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(6);
    expect(pairsByName.size).toBe(3);
    expect(pairsByName.has(pairKey(A, B))).toBe(true);
    expect(pairsByName.has(pairKey(A, C))).toBe(true);
    expect(pairsByName.has(pairKey(B, C))).toBe(true);
  });

  it('pair name is identity-stable: pairKey(A, B) === pairKey(B, A)', () => {
    const A = fakeRing({ item_id: 1, name: 'A', ilvl: 250 });
    const B = fakeRing({ item_id: 2, name: 'B', ilvl: 260 });
    expect(pairKey(A, B)).toBe(pairKey(B, A));
  });

  it('writes both finger1 and finger2 lines per pair using the profileset += syntax', () => {
    const A = fakeRing({ item_id: 100, name: 'A', ilvl: 250, bonus_ids: [42] });
    const B = fakeRing({ item_id: 200, name: 'B', ilvl: 260, bonus_ids: [99] });
    const { script } = buildRingProfilesetScript([A, B]);
    const key = pairKey(A, B);
    expect(script).toContain(`profileset."${key}"+="finger1=,id=100,bonus_id=42"`);
    expect(script).toContain(`profileset."${key}"+="finger2=,id=200,bonus_id=99"`);
  });

  it('produces an empty script for a one-ring pool (no pairs possible)', () => {
    const { script, pairsByName } = buildRingProfilesetScript([
      fakeRing({ item_id: 1, name: 'A', ilvl: 250 }),
    ]);
    expect(script).toBe('');
    expect(pairsByName.size).toBe(0);
  });
});

describe('parseRingPreScanResult', () => {
  it('maps profileset names back to ring pairs and ranks by mean DPS', () => {
    const A = fakeRing({ item_id: 1, name: 'Alpha', ilvl: 250 });
    const B = fakeRing({ item_id: 2, name: 'Beta', ilvl: 260 });
    const C = fakeRing({ item_id: 3, name: 'Gamma', ilvl: 270 });
    const { pairsByName } = buildRingProfilesetScript([A, B, C]);
    const run = fakeRun([
      { name: pairKey(A, B), mean: 100000 },
      { name: pairKey(A, C), mean: 110000 },
      { name: pairKey(B, C), mean: 105000 },
    ]);
    const result = parseRingPreScanResult(run, pairsByName);
    expect(result.pairs).toHaveLength(3);
    expect(result.winner?.pair_id).toBe(pairKey(A, C));
    const winnerNames = [result.winner?.finger1.name, result.winner?.finger2.name].sort();
    expect(winnerNames).toEqual(['Alpha', 'Gamma']);
    expect(result.winner?.delta_pct).toBe(0);
    expect(result.pairs[1]!.pair_id).toBe(pairKey(B, C));
    expect(result.pairs[1]!.delta_pct).toBeLessThan(0);
    expect(result.pairs[2]!.delta_pct).toBeLessThan(result.pairs[1]!.delta_pct);
  });

  it('ignores profileset entries that do not match a known pair name', () => {
    const A = fakeRing({ item_id: 1, name: 'A', ilvl: 250 });
    const B = fakeRing({ item_id: 2, name: 'B', ilvl: 260 });
    const { pairsByName } = buildRingProfilesetScript([A, B]);
    const run = fakeRun([
      { name: pairKey(A, B), mean: 100000 },
      { name: 'flask_blood_knights', mean: 99999 },
    ]);
    const result = parseRingPreScanResult(run, pairsByName);
    expect(result.pairs).toHaveLength(1);
    const names = [result.pairs[0]!.finger1.name, result.pairs[0]!.finger2.name].sort();
    expect(names).toEqual(['A', 'B']);
  });

  it('returns an empty pair list (no winner) when SimC produced nothing', () => {
    const result = parseRingPreScanResult(fakeRun([]), new Map());
    expect(result.pairs).toEqual([]);
    expect(result.winner).toBeUndefined();
  });
});
