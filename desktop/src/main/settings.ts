/**
 * Phase 5 — electron-store-backed settings.
 *
 * All configurable thresholds from gear-config.ts are exposed here as
 * live-editable values. The constants in gear-config.ts remain as
 * fallback defaults; this module sits on top and consults the store
 * first.
 *
 * Usage:
 *   import { getSettings, setSettings } from './settings';
 *   const s = getSettings();          // → SimlySettings with defaults filled in
 *   setSettings({ prunerMultiplier: 1.3 });
 *
 * The scan-queue calls getSettings() at the start of each run so a
 * threshold change in the desktop UI applies on the next "Update sims"
 * without restarting the app.
 */

import type ElectronStore from 'electron-store';
import * as ElectronStoreModule from 'electron-store';
import {
  DEFAULT_PRUNER_MULTIPLIER,
  DEFAULT_MAX_COMBOS,
  TIE_WINDOW_PCT,
  GOOD_THRESHOLD_PCT,
  TRASH_THRESHOLD_PCT,
  COARSE_KEEP_THRESHOLD_PCT,
  REFINED_KEEP_THRESHOLD_PCT,
  COARSE_ITERATIONS,
  REFINED_ITERATIONS,
  FINAL_ITERATIONS,
  TRINKET_ITERATIONS,
  TOP_TRINKETS_TO_KEEP,
  RING_ITERATIONS,
  TOP_RINGS_TO_KEEP,
  SWAP_TEST_ITERATIONS,
} from './gear-config';

// ---------------------------------------------------------------------------
// Content preferences — Phase 7 picker
//
// Captures which content the player is willing to run. Future `best_content`
// scan reads this to scope its loot pool. Defaults are all-on so unconfigured
// users still get full coverage.
// ---------------------------------------------------------------------------

export type RaidId = 'voidspire' | 'dreamrift' | 'march_on_queldanas';

export interface RaidDifficultyMap {
  lfr: boolean;
  normal: boolean;
  heroic: boolean;
  mythic: boolean;
}

export interface ContentPrefs {
  raids: Record<RaidId, RaidDifficultyMap>;
  mplus: {
    enabled: boolean;
    /** Max keystone level the player is willing to time. 1..10 inclusive. */
    max_level: number;
  };
  world: {
    /** Master toggle. False = ignore all world loot. */
    enabled: boolean;
    /** 1..11 inclusive. */
    max_delve_tier: number;
    /** 1..5 inclusive. */
    max_ritual_tier: number;
  };
}

export const CONTENT_PREFS_DEFAULTS: Readonly<ContentPrefs> = Object.freeze({
  raids: {
    voidspire: { lfr: true, normal: true, heroic: true, mythic: true },
    dreamrift: { lfr: true, normal: true, heroic: true, mythic: true },
    march_on_queldanas: { lfr: true, normal: true, heroic: true, mythic: true },
  },
  mplus: { enabled: true, max_level: 10 },
  world: { enabled: true, max_delve_tier: 11, max_ritual_tier: 5 },
});

export interface SimlySettings {
  /** Coarse-stage pruner multiplier. Items with score × multiplier < slot_max are dropped. */
  prunerMultiplier: number;
  /** Hard cap on the gear cartesian combo count. */
  maxCombos: number;
  /** DPS % band within which items are 'sidegrade' (vs winner). */
  tieWindowPct: number;
  /** Items within this % of winner are 'good' (re-eligible next run). */
  goodThresholdPct: number;
  /** Items losing by more than this % are 'trash' (excluded from future cartesians). */
  trashThresholdPct: number;
  /** Coarse-stage survivors: keep combos within this % of the coarse winner for refined. */
  coarseKeepThresholdPct: number;
  /** Refined-stage survivors: keep combos within this % of the refined winner for final. */
  refinedKeepThresholdPct: number;
  /** SimC iterations per profileset for the coarse gear scan. */
  coarseIterations: number;
  /** SimC iterations per profileset for the refined gear scan. */
  refinedIterations: number;
  /** SimC iterations per profileset for the final gear scan. */
  finalIterations: number;
  /** SimC iterations per profileset for the trinket pre-scan. */
  trinketIterations: number;
  /** Number of "top" trinkets carried forward to the gear ladder from the pre-scan. */
  topTrinketsToKeep: number;
  /** SimC iterations per profileset for the ring pre-scan. */
  ringIterations: number;
  /** Number of "top" rings carried forward from the pre-scan cache. */
  topRingsToKeep: number;
  /** SimC iterations per profileset for the swap-test quick-sim stage. */
  swapTestIterations: number;
  /** Override for the WoW retail root path. Undefined = auto-detect. */
  wowRetailRoot?: string;
  /** Phase 7 — content the player is willing to run (gates `best_content` scan). */
  contentPrefs: ContentPrefs;
}

export const SETTINGS_DEFAULTS: Readonly<Required<Omit<SimlySettings, 'wowRetailRoot'>>> = {
  prunerMultiplier: DEFAULT_PRUNER_MULTIPLIER,
  maxCombos: DEFAULT_MAX_COMBOS,
  tieWindowPct: TIE_WINDOW_PCT,
  goodThresholdPct: GOOD_THRESHOLD_PCT,
  trashThresholdPct: TRASH_THRESHOLD_PCT,
  coarseKeepThresholdPct: COARSE_KEEP_THRESHOLD_PCT,
  refinedKeepThresholdPct: REFINED_KEEP_THRESHOLD_PCT,
  coarseIterations: COARSE_ITERATIONS,
  refinedIterations: REFINED_ITERATIONS,
  finalIterations: FINAL_ITERATIONS,
  trinketIterations: TRINKET_ITERATIONS,
  topTrinketsToKeep: TOP_TRINKETS_TO_KEEP,
  ringIterations: RING_ITERATIONS,
  topRingsToKeep: TOP_RINGS_TO_KEEP,
  swapTestIterations: SWAP_TEST_ITERATIONS,
  contentPrefs: CONTENT_PREFS_DEFAULTS,
};

// Same ESM/CJS interop dance as ignore-list.ts — electron-store@11 is
// ESM-only but electron-vite externalizes it as CJS at runtime.
function resolveStoreCtor(): typeof ElectronStore {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const m: any = ElectronStoreModule;
  for (const candidate of [m, m?.default, m?.default?.default]) {
    if (typeof candidate === 'function') return candidate as typeof ElectronStore;
  }
  throw new Error('electron-store default export is not a constructor');
}

type Schema = { settings: SimlySettings };

let _store: ElectronStore<Schema> | undefined;

function getStore(): ElectronStore<Schema> {
  if (!_store) {
    const StoreClass = resolveStoreCtor();
    _store = new StoreClass<Schema>({
      name: 'settings',
      defaults: { settings: SETTINGS_DEFAULTS },
    });
  }
  return _store;
}

/**
 * Deep-merges stored `contentPrefs` against defaults so a partially-shaped
 * persisted object (e.g. from an older app build that didn't have one of
 * the nested fields yet) still surfaces as a fully-populated ContentPrefs.
 */
export function mergeContentPrefs(stored: Partial<ContentPrefs> | undefined): ContentPrefs {
  const d = CONTENT_PREFS_DEFAULTS;
  return {
    raids: {
      voidspire: { ...d.raids.voidspire, ...stored?.raids?.voidspire },
      dreamrift: { ...d.raids.dreamrift, ...stored?.raids?.dreamrift },
      march_on_queldanas: { ...d.raids.march_on_queldanas, ...stored?.raids?.march_on_queldanas },
    },
    mplus: { ...d.mplus, ...stored?.mplus },
    world: { ...d.world, ...stored?.world },
  };
}

export function getSettings(): SimlySettings {
  const stored = getStore().get('settings');
  return {
    ...SETTINGS_DEFAULTS,
    ...stored,
    contentPrefs: mergeContentPrefs(stored?.contentPrefs),
  };
}

export function setSettings(updates: Partial<SimlySettings>): SimlySettings {
  const current = getSettings();
  const next = { ...current, ...updates };
  getStore().set('settings', next);
  return next;
}

/** Reset all settings to code defaults. */
export function resetSettings(): SimlySettings {
  const next = { ...SETTINGS_DEFAULTS };
  getStore().set('settings', next);
  return next;
}
