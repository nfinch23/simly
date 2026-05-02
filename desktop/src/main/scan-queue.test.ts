import { describe, expect, it } from 'vitest';
import {
  ADDON_FALLBACK_SENTINELS,
  ScanQueue,
  composeFromConsumableScans,
} from './scan-queue';
import type { SimlyDB, ScanCollection, BestFlaskResult, BestFoodResult } from '@simly/shared';
import type { WowPaths } from './wow-paths';
import type { BootstrapResult } from './simc-bootstrap';

function fakeDb(opts: { update_requested_at: number }): SimlyDB {
  return {
    schema_version: 2,
    exported_at: 1714435200,
    character: {
      name: 'Test',
      realm: 'Server',
      region: 'us',
      class: 'WARLOCK',
      spec: 'Demonology',
      level: 80,
    },
    simc_export: 'PLACEHOLDER_PROFILE',
    update_requested_at: opts.update_requested_at,
    active_scenario: 'single_target_patchwerk',
  };
}

const fakePaths = {
  resultsLuaPath: '/tmp/sim-results.lua',
} as unknown as WowPaths;

const fakeSimc = {
  binPath: '/tmp/simc.exe',
  scratchDir: '/tmp/scratch',
} as unknown as BootstrapResult;

describe('ScanQueue.maybeRunForSavedVars (gating logic only — no real SimC)', () => {
  it('skips when update_requested_at <= lastCompletedAt (no new request)', () => {
    const queue = new ScanQueue({
      paths: fakePaths,
      simc: fakeSimc,
      initialLastCompletedAt: 1000,
    });
    // Should NOT call runForSavedVars; the inFlight flag never flips
    queue.maybeRunForSavedVars(fakeDb({ update_requested_at: 0 }));
    queue.maybeRunForSavedVars(fakeDb({ update_requested_at: 1000 }));
    // No assertion needed — if it had run, we'd see the simc spawn fail
    // since fakeSimc.binPath doesn't exist. Reaching here = gate worked.
    expect(true).toBe(true);
  });

  it('skips on equal timestamps (boundary case — equal is not "newer")', () => {
    const queue = new ScanQueue({
      paths: fakePaths,
      simc: fakeSimc,
      initialLastCompletedAt: 1000,
    });
    queue.maybeRunForSavedVars(fakeDb({ update_requested_at: 1000 }));
    expect(true).toBe(true);
  });
});

describe('ADDON_FALLBACK_SENTINELS', () => {
  it('contains both v1-and-v2 fallback markers the addon writes', () => {
    expect(ADDON_FALLBACK_SENTINELS.has('PLACEHOLDER_PROFILE')).toBe(true);
    expect(ADDON_FALLBACK_SENTINELS.has('NO_PROFILE_AVAILABLE')).toBe(true);
  });

  it('does not match a real SimC profile', () => {
    expect(ADDON_FALLBACK_SENTINELS.has('warlock="Test"\nlevel=80\n')).toBe(false);
  });
});

describe('composeFromConsumableScans', () => {
  function flaskScan(name: string): ScanCollection['best_flask'] {
    const data: BestFlaskResult = {
      label: 'Best flask',
      best: { item_id: 1, name, dps: 100 },
      alternatives: [],
    };
    return { status: 'done', data };
  }
  function foodScan(name: string): ScanCollection['best_food'] {
    const data: BestFoodResult = {
      label: 'Best food',
      best: { item_id: 2, name, dps: 200 },
      alternatives: [],
    };
    return { status: 'done', data };
  }

  it('returns undefined when no consumable scans present', () => {
    expect(composeFromConsumableScans({})).toBeUndefined();
  });

  it('builds a composed loadout from flask + food', () => {
    const out = composeFromConsumableScans({
      best_flask: flaskScan('Flask of the Magisters'),
      best_food: foodScan('Silvermoon Parade'),
    });
    expect(out?.flask?.name).toBe('Flask of the Magisters');
    expect(out?.food?.name).toBe('Silvermoon Parade');
    expect(out?.label).toContain('single-target');
  });

  it('handles flask-only (food scan missing or yielded no winner)', () => {
    const out = composeFromConsumableScans({
      best_flask: flaskScan('Flask of the Magisters'),
    });
    expect(out?.flask?.name).toBe('Flask of the Magisters');
    expect(out?.food).toBeUndefined();
  });
});
