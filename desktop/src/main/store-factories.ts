/**
 * Lazy electron-store init wrappers for the three persistent stores
 * (ignore list, trinket cache, gear catalog). Each `tryCreate*` swallows
 * construction errors and returns undefined so the queue can fall
 * through gracefully when running in a stripped harness (tests, no
 * Electron app context). A real production build always has Electron
 * available and these always succeed.
 */

import { GearCatalogStore } from './gear-catalog';
import { IgnoreListStore } from './ignore-list';
import { TrinketCacheStore } from './trinket-cache';

export function tryCreateIgnoreList(): IgnoreListStore | undefined {
  try {
    return new IgnoreListStore();
  } catch (err) {
    console.warn('[ignore-list] could not initialize store:', (err as Error).message);
    return undefined;
  }
}

export function tryCreateTrinketCache(): TrinketCacheStore | undefined {
  try {
    return new TrinketCacheStore();
  } catch (err) {
    console.warn('[trinket-cache] could not initialize store:', (err as Error).message);
    return undefined;
  }
}

export function tryCreateGearCatalog(): GearCatalogStore | undefined {
  try {
    return new GearCatalogStore();
  } catch (err) {
    console.warn('[gear-catalog] could not initialize store:', (err as Error).message);
    return undefined;
  }
}
