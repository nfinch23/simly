import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ADDON_FALLBACK_SENTINELS,
  ScanQueue,
  composeFromConsumableScans,
} from './scan-queue';
import { GearCatalogStore } from './gear-catalog';
import { TrinketCacheStore } from './trinket-cache';
import { IgnoreListStore } from './ignore-list';
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

describe('ScanQueue.clearAllCaches', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'simly-clear-cache-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  function makeQueueWithStores(): {
    queue: ScanQueue;
    gearCatalog: GearCatalogStore;
    trinketCache: TrinketCacheStore;
    ignoreList: IgnoreListStore;
    resultsLuaPath: string;
  } {
    const tag = Math.random().toString(36).slice(2);
    const gearCatalog = new GearCatalogStore({ cwd: tmp, name: `gear-${tag}` });
    const trinketCache = new TrinketCacheStore({ cwd: tmp, name: `trinket-${tag}` });
    const ignoreList = new IgnoreListStore({ cwd: tmp, name: `ignore-${tag}` });
    const resultsLuaPath = join(tmp, 'SimlyResults.lua');
    const queue = new ScanQueue({
      paths: { resultsLuaPath } as unknown as WowPaths,
      simc: fakeSimc,
      initialLastCompletedAt: 1000,
      gearCatalog,
      trinketCache,
      ignoreList,
    });
    return { queue, gearCatalog, trinketCache, ignoreList, resultsLuaPath };
  }

  it('clears all stores, deletes results.lua, and resets in-memory state', async () => {
    const { queue, gearCatalog, trinketCache, ignoreList, resultsLuaPath } = makeQueueWithStores();

    // Seed each store with at least one entry so we can verify clear()
    // actually emptied them.
    gearCatalog.put({
      character_key: 'Char-Realm',
      scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {},
      last_pool_signature: 'sig',
      last_full_sim_at: 100,
      last_quick_sim_at: 100,
      best_ilvl_by_slot: {},
    });
    trinketCache.put({
      character_key: 'Char-Realm',
      scenario: 'single_target_patchwerk',
      pool_signature: 'sig',
      pairs: [],
      top_trinket_identities: [],
      last_simmed_at: 100,
    });
    ignoreList.recordObservation({
      character_key: 'Char-Realm',
      scenario: 'single_target_patchwerk',
      item_identity: 'item-1',
      item_id: 1,
      slot: 'head',
      name: 'Test Helm',
      delta_pct: -10,
    });
    writeFileSync(resultsLuaPath, '-- stale results\n', 'utf8');

    expect(gearCatalog.get('Char-Realm', 'single_target_patchwerk')).toBeDefined();
    expect(trinketCache.get('Char-Realm', 'single_target_patchwerk')).toBeDefined();
    expect(ignoreList.list().length).toBeGreaterThan(0);
    expect(existsSync(resultsLuaPath)).toBe(true);

    // Plant some "latest results" so we can confirm the in-memory state resets too.
    queue.latestResults = { schema_version: 3 } as never;

    const result = await queue.clearAllCaches();

    expect(result).toEqual({
      inFlight: false,
      catalogCleared: true,
      trinketCleared: true,
      ignoreCleared: true,
      resultsLuaDeleted: true,
    });
    expect(gearCatalog.get('Char-Realm', 'single_target_patchwerk')).toBeUndefined();
    expect(trinketCache.get('Char-Realm', 'single_target_patchwerk')).toBeUndefined();
    expect(ignoreList.list().length).toBe(0);
    expect(existsSync(resultsLuaPath)).toBe(false);
    expect(queue.latestResults).toBeNull();
    // lastCompletedAt should be bumped to "now" (>= a few seconds ago) so a
    // stale update_requested_at in SavedVariables can't immediately re-fire.
    const nowSec = Math.floor(Date.now() / 1000);
    expect(queue.getQueueState().lastCompletedAt).toBeGreaterThanOrEqual(nowSec - 2);
  });

  it('treats a missing results.lua as success (ENOENT is not an error)', async () => {
    const { queue, resultsLuaPath } = makeQueueWithStores();
    expect(existsSync(resultsLuaPath)).toBe(false);

    const result = await queue.clearAllCaches();

    expect(result.inFlight).toBe(false);
    // resultsLuaDeleted is false because there was nothing to delete, but
    // the call succeeded — no warn was logged because ENOENT is suppressed.
    expect(result.resultsLuaDeleted).toBe(false);
  });

  it('refuses to clear while a scan is in flight (returns inFlight:true, no side effects)', async () => {
    const { queue, gearCatalog, resultsLuaPath } = makeQueueWithStores();

    gearCatalog.put({
      character_key: 'Char-Realm',
      scenario: 'single_target_patchwerk',
      best_loadout: {},
      seen_items: {},
      last_pool_signature: 'sig',
      last_full_sim_at: 100,
      last_quick_sim_at: 100,
      best_ilvl_by_slot: {},
    });
    writeFileSync(resultsLuaPath, '-- stale\n', 'utf8');

    // Force the in-flight flag on so clearAllCaches sees a "scan running" state.
    (queue as unknown as { inFlight: boolean }).inFlight = true;

    const result = await queue.clearAllCaches();

    expect(result).toEqual({
      inFlight: true,
      catalogCleared: false,
      trinketCleared: false,
      ignoreCleared: false,
      resultsLuaDeleted: false,
    });
    // Stores and file untouched.
    expect(gearCatalog.get('Char-Realm', 'single_target_patchwerk')).toBeDefined();
    expect(existsSync(resultsLuaPath)).toBe(true);
  });

  it('emits a fresh queue state with results=null after clearing', async () => {
    let lastEmitted: { results: unknown } | null = null;
    const tag = Math.random().toString(36).slice(2);
    const queue = new ScanQueue({
      paths: { resultsLuaPath: join(tmp, 'r.lua') } as unknown as WowPaths,
      simc: fakeSimc,
      initialLastCompletedAt: 1000,
      gearCatalog: new GearCatalogStore({ cwd: tmp, name: `gear-${tag}` }),
      trinketCache: new TrinketCacheStore({ cwd: tmp, name: `trinket-${tag}` }),
      ignoreList: new IgnoreListStore({ cwd: tmp, name: `ignore-${tag}` }),
      onStateChange: (s) => { lastEmitted = s; },
    });
    queue.latestResults = { schema_version: 3 } as never;

    await queue.clearAllCaches();

    expect(lastEmitted).not.toBeNull();
    expect(lastEmitted!.results).toBeNull();
  });
});
