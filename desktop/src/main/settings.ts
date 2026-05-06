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
  SWAP_TEST_ITERATIONS,
} from './gear-config';

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
  /** SimC iterations per profileset for the swap-test quick-sim stage. */
  swapTestIterations: number;
  /** Override for the WoW retail root path. Undefined = auto-detect. */
  wowRetailRoot?: string;
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
  swapTestIterations: SWAP_TEST_ITERATIONS,
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

export function getSettings(): SimlySettings {
  return { ...SETTINGS_DEFAULTS, ...getStore().get('settings') };
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
