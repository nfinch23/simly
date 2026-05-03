import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  IgnoreListStore,
  computeItemObservations,
  makeIgnoreKey,
} from './ignore-list';

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'simly-ignore-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function freshStore(): IgnoreListStore {
  return new IgnoreListStore({ cwd: tmp, name: `t-${Math.random().toString(36).slice(2)}` });
}

describe('makeIgnoreKey', () => {
  it('joins character + scenario + identity with a separator', () => {
    const k = makeIgnoreKey('Felfriend-Zuljin-us', 'single_target_patchwerk', '12345:1/2/3:');
    expect(k).toBe('Felfriend-Zuljin-us|single_target_patchwerk|12345:1/2/3:');
  });
});

describe('IgnoreListStore.recordObservation', () => {
  it('writes a row when delta_pct is past the threshold', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Old Helm',
      slot: 'head',
      delta_pct: -5, // threshold default 3, so -5 lands.
    });
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      item_id: 100,
      times_simmed: 1,
      best_delta_pct: -5,
    });
  });

  it('skips writes when delta_pct is within keep window', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Close Helm',
      slot: 'head',
      delta_pct: -1, // within default 3% threshold — not a loser
    });
    expect(store.list()).toHaveLength(0);
  });

  it('respects a custom ignore_threshold_pct', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Helm',
      slot: 'head',
      delta_pct: -2,
      ignore_threshold_pct: 1, // tighter — -2 now counts as losing
    });
    expect(store.list()).toHaveLength(1);
  });

  it('increments times_simmed on repeat observations', () => {
    const store = freshStore();
    const base = {
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Helm',
      slot: 'head',
    };
    store.recordObservation({ ...base, delta_pct: -5 });
    store.recordObservation({ ...base, delta_pct: -7 });
    store.recordObservation({ ...base, delta_pct: -4 });
    const entries = store.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]!.times_simmed).toBe(3);
    // best_delta_pct is least-negative (closest to winner) — i.e., -4.
    expect(entries[0]!.best_delta_pct).toBe(-4);
  });
});

describe('IgnoreListStore.list / get / clear / markManuallyRemoved', () => {
  it('filters by character + scenario', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'A-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '1:::',
      item_id: 1,
      name: 'A',
      slot: 'head',
      delta_pct: -10,
    });
    store.recordObservation({
      character_key: 'B-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '2:::',
      item_id: 2,
      name: 'B',
      slot: 'head',
      delta_pct: -10,
    });
    expect(store.list()).toHaveLength(2);
    expect(store.list({ character_key: 'A-S-us' })).toHaveLength(1);
    expect(store.list({ scenario: 'single_target_patchwerk' })).toHaveLength(2);
  });

  it('get() returns the row by composite key', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Helm',
      slot: 'head',
      delta_pct: -5,
    });
    expect(store.get('F-S-us', 'single_target_patchwerk', '100:::')?.item_id).toBe(100);
    expect(store.get('F-S-us', 'single_target_patchwerk', 'missing')).toBeUndefined();
  });

  it('markManuallyRemoved sets the flag on existing rows; no-op for missing', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Helm',
      slot: 'head',
      delta_pct: -5,
    });
    store.markManuallyRemoved('F-S-us', 'single_target_patchwerk', '100:::');
    expect(store.get('F-S-us', 'single_target_patchwerk', '100:::')?.manually_removed).toBe(true);
    // No-op for missing rows.
    store.markManuallyRemoved('F-S-us', 'single_target_patchwerk', 'missing');
    expect(store.list()).toHaveLength(1);
  });

  it('clear() empties the store', () => {
    const store = freshStore();
    store.recordObservation({
      character_key: 'F-S-us',
      scenario: 'single_target_patchwerk',
      item_identity: '100:::',
      item_id: 100,
      name: 'Helm',
      slot: 'head',
      delta_pct: -5,
    });
    store.clear();
    expect(store.list()).toHaveLength(0);
  });
});

describe('computeItemObservations', () => {
  it('returns one row per unique item identity, with its best (least-negative) delta', () => {
    const A = { item_id: 1, name: 'A', identity: 'idA' };
    const B = { item_id: 2, name: 'B', identity: 'idB' };
    const C = { item_id: 3, name: 'C', identity: 'idC' };
    const combos = [
      { delta_pct: 0, items: [{ slot: 'head', item: A }, { slot: 'chest', item: B }] }, // winner: A,B
      { delta_pct: -2, items: [{ slot: 'head', item: A }, { slot: 'chest', item: C }] }, // A's best is 0
      { delta_pct: -5, items: [{ slot: 'head', item: C }, { slot: 'chest', item: B }] }, // C's best is -2
    ];
    const obs = computeItemObservations(combos);
    const byId = new Map(obs.map((o) => [o.item_id, o]));
    expect(byId.get(1)?.delta_pct).toBe(0); // A — appears in winning combo
    expect(byId.get(2)?.delta_pct).toBe(0); // B — appears in winning combo
    expect(byId.get(3)?.delta_pct).toBe(-2); // C — best of -2 / -5
  });

  it('excludes trinkets (4c handles trinket eliminations separately)', () => {
    const T1 = { item_id: 200, name: 'T1', identity: 'idT1' };
    const T2 = { item_id: 201, name: 'T2', identity: 'idT2' };
    const A = { item_id: 1, name: 'A', identity: 'idA' };
    const combos = [
      {
        delta_pct: 0,
        items: [
          { slot: 'trinket1', item: T1 },
          { slot: 'trinket2', item: T2 },
          { slot: 'head', item: A },
        ],
      },
    ];
    const obs = computeItemObservations(combos);
    expect(obs.map((o) => o.item_id).sort()).toEqual([1]);
  });

  it('returns empty for empty input', () => {
    expect(computeItemObservations([])).toEqual([]);
  });
});
